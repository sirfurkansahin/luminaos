import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Role } from '@luminaos/core-objects';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { ActionProposalProjection } from './action-proposal.projection.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIUsageService } from '../ai/ai-usage.service.js';
import { parseCommand, proposedActionSchema } from '../ai/parse-command.js';
import { selectAIModel } from '../ai/select-ai-model.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { commandProposals } from '../db/schema/command-proposals.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { ObjectsService } from '../objects/objects.service.js';
import { RelationsService } from '../relations/relations.service.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

import type { ProposedAction } from '../ai/parse-command.js';
import type { Database } from '../db/client.js';

/**
 * Defensive READ-time re-validation of a single stored `command_proposals`
 * row's `actions[]` element (PR4 security-review finding, F1-T16 PR5 spec
 * step 4): only `parseCommand`'s WRITE-time zod check (`proposedActionSchema`
 * in `../ai/parse-command.ts`) protects this jsonb column today, so `decide`
 * must NOT blindly trust it at read time (a manual DB edit, a future
 * migration bug, or a bypassed write path could otherwise let an
 * unvalidated `type` reach the dispatch switch below). Reuses the exported
 * per-item element schema (`proposedActionSchema.element`) to avoid drift,
 * extended with the `actionId` field `parseCommand` mints onto every action
 * after its own validation.
 */
const decidableActionSchema = proposedActionSchema.element.extend({
  actionId: z.string(),
});

/** Hard cap on how many decisions a single `decide()` call may carry — defense-in-depth against an adversarial/malfunctioning AI response producing an unbounded `subtaskTitles`/`userIds`-style array upstream in `parseCommand`'s output (security review, F1-T16 PR5). Exported so `../commands/dto/decide-actions.schema.ts` (F1-T16 PR6) can reuse the exact same cap instead of hardcoding a second, driftable `50`. */
export const MAX_DECISIONS_PER_CALL = 50;

type DecidableAction = z.infer<typeof decidableActionSchema>;

export type DecisionInput = {
  actionId: string;
  decision: 'approved' | 'rejected';
};

export type DecideActionResult = {
  actionId: string;
  status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
  createdCount?: number;
  totalCount?: number;
  failedAtStep?: number;
  error?: string;
};

/**
 * `@luminaos/shared`'s `AppError` subclasses carry deliberately clean,
 * caller-safe messages (`NotFoundError`/`ValidationError`/`ForbiddenError`/
 * `ConflictError`, etc.) -- these are safe to return verbatim in a
 * `{status:'failed', error}` result. Anything else (a raw driver exception,
 * an unexpected runtime error) may contain internal details (constraint/
 * column names, stack fragments) that must never reach an API caller
 * (security review, F1-T16 PR5) -- those are collapsed to a generic message.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  return 'This action could not be executed.';
}

function requireStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') {
    throw new ValidationError(`Action param "${key}" must be a string.`);
  }
  return value;
}

function requireStringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new ValidationError(`Action param "${key}" must be an array of strings.`);
  }
  return value;
}

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
    private readonly objectsService: ObjectsService,
    private readonly relationsService: RelationsService,
    private readonly workspaceMembershipService: WorkspaceMembershipService,
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

  /**
   * `decide()` (F1-T16 PR5, ADR-0015 §d): the FIRST place in this codebase
   * where an AI-proposed action becomes a REAL state mutation, gated on
   * explicit per-action human approval. `approverActor`/`callerRole` are the
   * REAL approving user's own identity/role — threaded through to EVERY
   * resulting mutation call, NEVER the fixed `COMMAND_PARSER_ACTOR` this
   * class uses for `ActionsProposed`.
   *
   * `workspaceId` is the workspace the CALLER was authorized against (by
   * whatever guard sits in front of this method, e.g. `WorkspaceMembershipGuard`
   * in the future PR6 controller) — checked against the proposal's OWN
   * `workspaceId` and rejected as `NotFoundError` (not a distinguishable 403,
   * mirroring `setFieldValues`'s "hidden must look like not-found" discipline)
   * on any mismatch. Without this check, a caller authorized for workspace A
   * could `decide()` a `proposalId` belonging to workspace B, executing real
   * mutations against a workspace they were never authorized against
   * (security review, F1-T16 PR5).
   *
   * Idempotency/double-execution prevention across separate `decide()` CALLS
   * is deliberately simple: the `command_proposals.decided_at` column is
   * checked BEFORE anything else (before touching the event store, before
   * executing any action) and set exactly once by the `ActionsDecided`
   * event's own projection handler — no deterministic-id machinery needed
   * (verified safe under a genuine concurrent-call race too: the SECOND
   * racing call's `eventStore.append` at the SAME `expectedVersion` fails
   * with a version conflict before its own execution loop ever starts).
   * WITHIN a single call, duplicate `actionId` entries in `decisions` are
   * de-duplicated (executed once, the same cached result repeated) — security
   * review, F1-T16 PR5.
   */
  async decide(
    workspaceId: string,
    proposalId: string,
    approverActor: Actor,
    callerRole: Role,
    decisions: DecisionInput[],
  ): Promise<{ results: DecideActionResult[] }> {
    if (decisions.length > MAX_DECISIONS_PER_CALL) {
      throw new ValidationError(
        `A single decide() call may not carry more than ${String(MAX_DECISIONS_PER_CALL)} decisions.`,
      );
    }

    const [row] = await this.db
      .select()
      .from(commandProposals)
      .where(eq(commandProposals.id, proposalId))
      .limit(1);

    // A proposal that exists but belongs to a DIFFERENT workspace must be
    // indistinguishable from one that doesn't exist at all — a distinguishable
    // 403/409 here would let a caller enumerate other workspaces' proposalIds.
    if (!row || row.workspaceId !== workspaceId) {
      throw new NotFoundError('Command proposal not found.');
    }

    if (row.decidedAt !== null) {
      throw new ConflictError('This command proposal has already been decided.');
    }

    const rawActions = Array.isArray(row.actions) ? row.actions : [];
    const rawActionsById = new Map<string, unknown>();
    for (const rawAction of rawActions) {
      if (
        rawAction !== null &&
        typeof rawAction === 'object' &&
        'actionId' in rawAction &&
        typeof (rawAction as { actionId: unknown }).actionId === 'string'
      ) {
        rawActionsById.set((rawAction as { actionId: string }).actionId, rawAction);
      }
    }

    for (const decision of decisions) {
      if (!rawActionsById.has(decision.actionId)) {
        throw new ValidationError(
          `Unknown actionId "${decision.actionId}" for this proposal's actions.`,
        );
      }
    }

    const decidedEvent: NewDomainEvent = {
      id: randomUUID(),
      streamType: PROPOSAL_STREAM_TYPE,
      workspaceId: row.workspaceId,
      type: 'ActionsDecided',
      payload: { proposalId, decisions },
      actor: approverActor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(row.streamId, 1, [decidedEvent]);
    await this.projectionRunner.catchUp(this.actionProposalProjection);

    const resultsByActionId = new Map<string, DecideActionResult>();

    for (const decision of decisions) {
      // Duplicate actionId within the SAME call: execute at most once,
      // repeat the cached result for every later occurrence (security
      // review — a repeated entry must never re-run a real mutation).
      const cached = resultsByActionId.get(decision.actionId);
      if (cached !== undefined) {
        continue;
      }

      // Fail-CLOSED: anything other than the literal 'approved' string is
      // treated as not-approved (security review — the original
      // `=== 'rejected'`-else-execute check was fail-OPEN, so a malformed/
      // unexpected `decision` value would have been silently executed).
      if (decision.decision !== 'approved') {
        resultsByActionId.set(decision.actionId, {
          actionId: decision.actionId,
          status: 'rejected',
        });
        continue;
      }

      const rawAction = rawActionsById.get(decision.actionId);
      const parsedAction = decidableActionSchema.safeParse(rawAction);

      if (!parsedAction.success) {
        resultsByActionId.set(decision.actionId, {
          actionId: decision.actionId,
          status: 'failed',
          error: 'This action is no longer valid and could not be executed.',
        });
        continue;
      }

      resultsByActionId.set(
        decision.actionId,
        await this.executeDecidedAction(
          row.workspaceId,
          parsedAction.data,
          approverActor,
          callerRole,
          decidedEvent.id,
        ),
      );
    }

    // One result per INPUT decision (in input order, duplicates repeated),
    // not one per unique actionId -- `resultsByActionId` is keyed by actionId
    // purely to dedupe EXECUTION, not to collapse the response shape.
    const results = decisions.map((decision) => {
      const result = resultsByActionId.get(decision.actionId);
      // Always set by the loop above for every actionId in `decisions`
      // (either the fail-closed/failed/executed branch, or a duplicate's
      // cached entry) -- this is a defensive fallback, never expected to
      // be reached given the loop's own invariant.
      return result ?? { actionId: decision.actionId, status: 'failed' as const };
    });

    return { results };
  }

  /**
   * Dispatches a single approved, already-re-validated action by `type` —
   * see this class's `decide()` doc comment for the actor-attribution
   * contract every branch below must honor. `causationEventId` (the
   * `ActionsDecided` event's own id) is threaded through to every real
   * mutation call as plain audit-trail metadata (ADR-0015 §b, amended):
   * idempotency/double-execution prevention comes ENTIRELY from
   * `decide()`'s own `decided_at` guard above, NOT from this field — this
   * is purely for post-hoc traceability (`gerçek mutasyon ← ActionsDecided`,
   * readable directly from the event log), no deterministic-id derivation
   * involved.
   */
  private async executeDecidedAction(
    workspaceId: string,
    action: DecidableAction,
    approverActor: Actor,
    callerRole: Role,
    causationEventId: string,
  ): Promise<DecideActionResult> {
    switch (action.type) {
      case 'createTask':
        return this.executeCreateTask(
          workspaceId,
          action,
          approverActor,
          callerRole,
          causationEventId,
        );
      case 'generateSubtasks':
        return this.executeGenerateSubtasks(
          workspaceId,
          action,
          approverActor,
          callerRole,
          causationEventId,
        );
      case 'assignPeople':
        return this.executeAssignPeople(workspaceId, action, approverActor, callerRole);
    }
  }

  private async executeCreateTask(
    workspaceId: string,
    action: DecidableAction,
    approverActor: Actor,
    callerRole: Role,
    causationEventId: string,
  ): Promise<DecideActionResult> {
    const { actionId } = action;

    try {
      const title = requireStringParam(action.params, 'title');
      await this.objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title, causationEventId },
        callerRole,
      );
      return { actionId, status: 'executed' };
    } catch (error) {
      return { actionId, status: 'failed', error: toErrorMessage(error) };
    }
  }

  /**
   * `generateSubtasks`: creates every subtask + its own `parentChild`
   * relation to `parentObjectId`, IN ORDER, stopping immediately at the
   * first failing title. `createdCount`/`totalCount`/`failedAtStep` are
   * ONLY included on `'partially_executed'`/`'failed'` — a full success
   * omits them entirely (`exactOptionalPropertyTypes`-safe conditional
   * object construction, not `undefined`-valued keys).
   */
  private async executeGenerateSubtasks(
    workspaceId: string,
    action: DecidableAction,
    approverActor: Actor,
    callerRole: Role,
    causationEventId: string,
  ): Promise<DecideActionResult> {
    const { actionId } = action;

    let parentObjectId: string;
    let subtaskTitles: string[];

    try {
      parentObjectId = requireStringParam(action.params, 'parentObjectId');
      subtaskTitles = requireStringArrayParam(action.params, 'subtaskTitles');
    } catch (error) {
      return { actionId, status: 'failed', error: toErrorMessage(error) };
    }

    const totalCount = subtaskTitles.length;
    let createdCount = 0;
    let failure: { step: number; error: string } | undefined;

    for (const [index, title] of subtaskTitles.entries()) {
      try {
        const created = await this.objectsService.create(
          workspaceId,
          approverActor,
          { objectType: 'task', title, causationEventId },
          callerRole,
        );
        await this.relationsService.create(workspaceId, approverActor, {
          fromId: parentObjectId,
          toId: created.id,
          kind: 'parentChild',
          causationEventId,
        });
        createdCount += 1;
      } catch (error) {
        failure = { step: index + 1, error: toErrorMessage(error) };
        break;
      }
    }

    if (!failure) {
      return { actionId, status: 'executed' };
    }

    if (createdCount === 0) {
      return { actionId, status: 'failed', error: failure.error };
    }

    return {
      actionId,
      status: 'partially_executed',
      createdCount,
      totalCount,
      failedAtStep: failure.step,
      error: failure.error,
    };
  }

  private async executeAssignPeople(
    workspaceId: string,
    action: DecidableAction,
    approverActor: Actor,
    callerRole: Role,
  ): Promise<DecideActionResult> {
    const { actionId } = action;

    try {
      const objectId = requireStringParam(action.params, 'objectId');
      const fieldKey = requireStringParam(action.params, 'fieldKey');
      const userIds = requireStringArrayParam(action.params, 'userIds');

      await this.workspaceMembershipService.assertAllMembers(workspaceId, userIds);

      await this.objectsService.setFieldValues(workspaceId, objectId, approverActor, callerRole, [
        { fieldKey, value: userIds },
      ]);

      return { actionId, status: 'executed' };
    } catch (error) {
      return { actionId, status: 'failed', error: toErrorMessage(error) };
    }
  }
}
