import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { AppError, deriveDeterministicUuid, ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { DmMessageProjection } from './direct-message.projection.js';
import { CommandsService } from '../commands/commands.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { agents } from '../db/schema/agents.js';
import { dmMessages } from '../db/schema/dm-messages.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const STREAM_TYPE = 'direct-message';

/**
 * Fixed, arbitrary namespace UUID for deriving per-(workspace, userId,
 * agentIdentifier) DM-thread streamIds. MUST NEVER CHANGE once real data
 * exists -- changing it silently opens a new stream per triple, losing
 * continuity with any prior message history (F3-T3 PR5, ADR-0037 §4),
 * mirroring `MEMORY_ACCESS_POLICY_UUID_NAMESPACE`'s exact same "never
 * change" rationale.
 */
export const DM_MESSAGE_UUID_NAMESPACE = 'f1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** The fixed rejection body recorded when a below-admin caller's DM triggers `CommandsService.proposeFromDirectMessage`'s own admin-gate. Pinned verbatim by this PR's own spec/tests. */
const NON_ADMIN_REJECTION_BODY =
  'Only workspace admins can request agent permission changes via DM.';

/** Default fallback body when `proposeFromDirectMessage` returns `parseError: true` without its own `message`. */
const DEFAULT_PARSE_ERROR_BODY = 'Sorry, I could not understand that request.';

export interface DmMessage {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  sender: 'user' | 'agent';
  body: string;
  proposalId: string | null;
  createdAt: Date;
}

type DmMessageRow = typeof dmMessages.$inferSelect;

function toDmMessage(row: DmMessageRow): DmMessage {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    agentIdentifier: row.agentIdentifier,
    sender: row.sender as DmMessage['sender'],
    body: row.body,
    proposalId: row.proposalId,
    createdAt: row.createdAt,
  };
}

/**
 * Signals a database invariant violation (an append that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors `AgentDirectoryService`'s/
 * `MemoryAccessPolicyService`'s own `UnexpectedQueryResultError` pattern.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

/**
 * `DirectMessagesService` (F3-T3 PR5, ADR-0037 §4): a lightweight,
 * event-sourced, persistent 1:1 DM thread per `(workspaceId, userId,
 * agentIdentifier)` triple. Pure plumbing (storage + orchestration) around
 * `CommandsService.proposeFromDirectMessage` -- this service never
 * re-implements any AI/reconfiguration logic itself.
 *
 * `streamId` is a DETERMINISTIC function of `(workspaceId, userId,
 * agentIdentifier)` (RFC 4122 UUIDv5, via `deriveDeterministicUuid`) --
 * mirrors `MemoryAccessPolicyService.streamIdFor`'s exact same per-triple
 * stream shape: every message (user-authored or agent-authored reply) for
 * a given triple lives on the SAME stream, appended incrementally.
 */
@Injectable()
export class DirectMessagesService {
  private readonly projection = new DmMessageProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    private readonly commandsService: CommandsService,
  ) {}

  async send(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    agentIdentifier: string,
    body: string,
  ): Promise<{ userMessage: DmMessage; agentReply: DmMessage }> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    await this.assertActiveAgentExists(workspaceId, agentIdentifier);

    const streamId = this.streamIdFor(workspaceId, actor.id, agentIdentifier);

    const userMessage = await this.appendMessage(streamId, workspaceId, {
      userId: actor.id,
      agentIdentifier,
      sender: 'user',
      body,
      proposalId: null,
      actor,
    });

    let replyBody: string;
    let replyProposalId: string | null;

    try {
      const result = await this.commandsService.proposeFromDirectMessage(
        workspaceId,
        actor,
        callerRole,
        agentIdentifier,
        body,
      );

      if (result.parseError) {
        replyBody = result.message ?? DEFAULT_PARSE_ERROR_BODY;
        replyProposalId = null;
      } else {
        replyBody = this.renderProposalSummary(result);
        replyProposalId = result.proposalId;
      }
    } catch (error) {
      if (error instanceof ForbiddenError) {
        replyBody = NON_ADMIN_REJECTION_BODY;
        replyProposalId = null;
      } else {
        throw error;
      }
    }

    const agentReply = await this.appendMessage(streamId, workspaceId, {
      userId: actor.id,
      agentIdentifier,
      sender: 'agent',
      body: replyBody,
      proposalId: replyProposalId,
      actor: { type: 'agent', id: agentIdentifier },
    });

    return { userMessage, agentReply };
  }

  async list(
    workspaceId: string,
    requestingUserId: string,
    targetUserId: string,
    agentIdentifier: string,
    callerRole: MembershipRole,
  ): Promise<DmMessage[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    if (requestingUserId !== targetUserId && !hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select()
      .from(dmMessages)
      .where(
        and(
          eq(dmMessages.workspaceId, workspaceId),
          eq(dmMessages.userId, targetUserId),
          eq(dmMessages.agentIdentifier, agentIdentifier),
        ),
      )
      .orderBy(asc(dmMessages.createdAt));

    return rows.map(toDmMessage);
  }

  /**
   * Renders a short, human-readable summary of a successful parse result --
   * exact wording is this implementer's own call (the spec only pins that
   * `proposalId` is set to the real value and sender/scoping are correct).
   */
  private renderProposalSummary(result: {
    proposalId: string;
    actions: { intent: string; rationale: string }[];
  }): string {
    if (result.actions.length === 0) {
      return `I've recorded proposal ${result.proposalId}, but found no concrete actions to propose.`;
    }

    const actionSummaries = result.actions
      .map((action) => `- ${action.intent} (${action.rationale})`)
      .join('\n');

    return `I've recorded the following proposal (id: ${result.proposalId}) for an admin to review:\n${actionSummaries}`;
  }

  private async assertActiveAgentExists(
    workspaceId: string,
    agentIdentifier: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.agentIdentifier, agentIdentifier),
          eq(agents.lifecycle, 'active'),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundError('Agent not found or not active.');
    }
  }

  private async appendMessage(
    streamId: string,
    workspaceId: string,
    input: {
      userId: string;
      agentIdentifier: string;
      sender: 'user' | 'agent';
      body: string;
      proposalId: string | null;
      actor: Actor;
    },
  ): Promise<DmMessage> {
    const priorEvents = await this.eventStore.readStream(streamId);
    const messageId = randomUUID();
    const occurredAt = new Date();

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId,
      type: 'DirectMessageSent',
      payload: {
        messageId,
        userId: input.userId,
        agentIdentifier: input.agentIdentifier,
        sender: input.sender,
        body: input.body,
        proposalId: input.proposalId,
      },
      actor: input.actor,
      occurredAt,
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const [row] = await this.db
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.id, messageId))
      .limit(1);

    if (!row) {
      throw new UnexpectedQueryResultError(
        'Failed to read back DM message immediately after writing it.',
      );
    }

    return toDmMessage(row);
  }

  private streamIdFor(workspaceId: string, userId: string, agentIdentifier: string): string {
    return deriveDeterministicUuid(
      DM_MESSAGE_UUID_NAMESPACE,
      `${workspaceId}:${userId}:${agentIdentifier}`,
    );
  }
}
