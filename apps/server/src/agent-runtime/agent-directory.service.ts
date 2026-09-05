import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import { AppError, ConflictError, ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { AgentDirectoryProjection } from './agent-directory.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { agents } from '../db/schema/agents.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const STREAM_TYPE = 'agent';

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  agentIdentifier: string;
  lifecycle: 'active' | 'deactivated';
  createdAt: Date;
}

export interface RegisterAgentInput {
  name: string;
  agentIdentifier: string;
}

type AgentRow = typeof agents.$inferSelect;

/**
 * Signals a database invariant violation (an append that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors
 * `AgentPermissionManifestsService`'s `UnexpectedQueryResultError` pattern.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    agentIdentifier: row.agentIdentifier,
    lifecycle: row.lifecycle as Agent['lifecycle'],
    createdAt: row.createdAt,
  };
}

/**
 * F3-T3 (ADR-0037 Karar b): `AgentDirectoryService`, a flat, event-sourced
 * CRUD entity mirroring `AutomationTriggersService`'s exact shape — own
 * `STREAM_TYPE='agent'`, a FRESH `randomUUID()` stream per new agent (NOT a
 * deterministic per-key stream like `AgentPermissionManifestsService`'s,
 * since an Agent is a freshly-minted identity, not a toggle), flat
 * `admin`+/`member`+ RBAC via `hasAtLeastRole`, `lifecycle:
 * 'active'|'deactivated'` soft-delete, `list()` filtered to `active` only.
 *
 * Registration and permission-granting are BILEREK (intentionally) separate
 * admin+ steps — see ADR-0037 Karar b's "no atomic combined operation"
 * rationale.
 */
@Injectable()
export class AgentDirectoryService {
  private readonly projection = new AgentDirectoryProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async register(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: RegisterAgentInput,
  ): Promise<Agent> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const existingByName = await this.findActiveByNameCaseInsensitive(workspaceId, input.name);
    if (existingByName) {
      throw new ConflictError('An active agent with this name already exists in this workspace.');
    }

    const existingByIdentifier = await this.findActiveByIdentifier(
      workspaceId,
      input.agentIdentifier,
    );
    if (existingByIdentifier) {
      throw new ConflictError(
        'An active agent with this agentIdentifier already exists in this workspace.',
      );
    }

    const agentId = ulid();
    const streamId = randomUUID();

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId,
      type: 'AgentRegistered',
      payload: {
        agentId,
        workspaceId,
        name: input.name,
        agentIdentifier: input.agentIdentifier,
      },
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, 0, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const created = await this.getById(workspaceId, agentId);

    if (!created) {
      throw new UnexpectedQueryResultError(
        'Failed to read back agent immediately after registering it.',
      );
    }

    return created;
  }

  async deactivate(
    workspaceId: string,
    agentId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<Agent> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const streamId = await this.lookupStreamId(workspaceId, agentId);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId,
      type: 'AgentDeactivated',
      payload: { agentId },
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const updated = await this.getById(workspaceId, agentId);

    if (!updated) {
      throw new UnexpectedQueryResultError(
        'Failed to read back agent immediately after deactivating it.',
      );
    }

    return updated;
  }

  async list(workspaceId: string, callerRole: MembershipRole): Promise<Agent[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.lifecycle, 'active')));

    return rows.map(toAgent);
  }

  /**
   * NO RBAC parameter at all (ADR-0037 Karar b) — an internal read-point
   * mirroring `AgentPermissionManifestsService.checkPermission`'s own
   * no-RBAC internal read-point convention. Never throws; returns `null`
   * when nothing matches.
   */
  async resolveByName(workspaceId: string, name: string): Promise<Agent | null> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycle, 'active'),
          eq(sql<string>`lower(${agents.name})`, name.toLowerCase()),
        ),
      )
      .limit(1);

    return row ? toAgent(row) : null;
  }

  private async findActiveByNameCaseInsensitive(
    workspaceId: string,
    name: string,
  ): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycle, 'active'),
          eq(sql<string>`lower(${agents.name})`, name.toLowerCase()),
        ),
      )
      .limit(1);

    return row;
  }

  private async findActiveByIdentifier(
    workspaceId: string,
    agentIdentifier: string,
  ): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycle, 'active'),
          eq(agents.agentIdentifier, agentIdentifier),
        ),
      )
      .limit(1);

    return row;
  }

  private async getById(workspaceId: string, agentId: string): Promise<Agent | null> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1);

    return row ? toAgent(row) : null;
  }

  /**
   * Scoped by `id` + `workspaceId` only, mirroring
   * `AutomationTriggersService.lookupStreamId`'s exact contract — an
   * `agentId` that belongs to a different workspace, or doesn't exist at
   * all, is a 404.
   */
  private async lookupStreamId(workspaceId: string, agentId: string): Promise<string> {
    const [row] = await this.db
      .select({ streamId: agents.streamId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Agent not found');
    }

    return row.streamId;
  }
}
