import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { ActionProposalProjection } from './action-proposal.projection.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIUsageService } from '../ai/ai-usage.service.js';
import { parseCommand } from '../ai/parse-command.js';
import { selectAIModel } from '../ai/select-ai-model.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { ProposedAction } from '../ai/parse-command.js';
import type { Database } from '../db/client.js';

/** The dedicated event-stream type for a proposal's own `ActionsProposed`/`ActionsDecided` events — never the calling user's or source object's own stream (ADR-0015 §b). */
const PROPOSAL_STREAM_TYPE = 'action-proposal';

/**
 * The always-and-only actor recorded for a proposal's own `ActionsProposed`
 * event (ADR-0015 §d) — deliberately fixed, regardless of the calling user's
 * own `actor` passed into `parse()`: the command-parsing agent, not the
 * human who typed the command, is the one taking the "propose these
 * actions" action being recorded.
 */
const COMMAND_PARSER_ACTOR = { type: 'agent', id: 'command-parser' } as const;

export interface CommandsServiceParseResult {
  proposalId: string;
  actions: ProposedAction[];
  parseError: boolean;
  message?: string;
}

/**
 * `CommandsService` (F1-T16 PR4, ADR-0015): orchestrates the
 * conversation-command-parsing flow — `AIUsageService`'s quota/lock/audit
 * discipline (same "once per operation" pattern as `QAService.answer`),
 * `selectAIModel({ outputType: 'command' })`, `parseCommand`, and durably
 * records the result as an `ActionsProposed` event on a brand-new dedicated
 * `action-proposal` stream, regardless of whether parsing succeeded (design
 * decision 4: the double-failure sentinel — see this class's `parse()` doc
 * comment).
 */
@Injectable()
export class CommandsService {
  /** Same "single, stable instance" reasoning as `ObjectsService.aiUsageProjection`/`AIUsageService.aiUsageProjection`. */
  private readonly actionProposalProjection = new ActionProposalProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    private readonly aiUsageService: AIUsageService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
  ) {}

  /**
   * Parses `command` into a set of proposed actions and durably records the
   * attempt (success or failure) as a single `ActionsProposed` event.
   *
   * `actor` is the CALLING USER's actor — used only for future authorization
   * concerns, NEVER persisted onto the `ActionsProposed` event itself (that
   * event is always authored by the fixed `COMMAND_PARSER_ACTOR`, ADR-0015
   * §d).
   *
   * ALWAYS appends exactly one `ActionsProposed` event per call, even when
   * `parseCommand` returns its `{ actions: [], parseError: true }` failure
   * sentinel — recording a failed parse attempt is itself useful audit
   * history, and it keeps a single, uniform code path for every caller
   * (including the future `decide` endpoint, PR5) to reason about.
   */
  async parse(
    workspaceId: string,
    _actor: Actor,
    command: string,
    sourceObjectId?: string,
  ): Promise<CommandsServiceParseResult> {
    const { actions, parseError, message } = await this.aiUsageService.withWorkspaceAILock(
      workspaceId,
      async () => {
        // Quota is checked EXACTLY ONCE per parse operation, before the
        // provider call — same "once per operation" discipline as
        // `QAService.answer`.
        await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
        await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

        const model = selectAIModel({ outputType: 'command' });

        return parseCommand({
          provider: this.aiProvider,
          command,
          ...(sourceObjectId !== undefined ? { sourceObjectId } : {}),
          model,
          recordUsage: (usage) =>
            this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
        });
      },
    );

    const proposalId = newObjectId();
    const streamId = randomUUID();

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: PROPOSAL_STREAM_TYPE,
      workspaceId,
      type: 'ActionsProposed',
      payload: {
        proposalId,
        workspaceId,
        ...(sourceObjectId !== undefined ? { sourceObjectId } : {}),
        command,
        actions,
      },
      actor: COMMAND_PARSER_ACTOR,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, 0, [event]);
    await this.projectionRunner.catchUp(this.actionProposalProjection);

    return {
      proposalId,
      actions,
      parseError,
      ...(message !== undefined ? { message } : {}),
    };
  }
}
