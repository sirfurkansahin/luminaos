import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AIProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Role } from '@luminaos/core-objects';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { ActionProposalProjection } from './action-proposal.projection.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIUsageService } from '../ai/ai-usage.service.js';
import { extractMeetingActions } from '../ai/extract-meeting-actions.js';
import { parseCommand, proposedActionSchema } from '../ai/parse-command.js';
import { selectAIModel } from '../ai/select-ai-model.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { commandProposals } from '../db/schema/command-proposals.js';
import { memberships } from '../db/schema/memberships.js';
import { users } from '../db/schema/users.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { ObjectsService } from '../objects/objects.service.js';
import { RelationsService } from '../relations/relations.service.js';
import { WebhookDeliveryEnqueueProjection } from '../webhooks/webhook-delivery-enqueue.projection.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

import type { ProposedAction } from '../ai/parse-command.js';
import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

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

/** Default page size for `listProposals` when `filter?.limit` is omitted (F2-T16 PR3, ADR-0033 §b/§g). */
export const DEFAULT_LIST_PROPOSALS_LIMIT = 50;

/**
 * Hard cap on `listProposals`'s page size regardless of what `filter?.limit`
 * requests — security-review finding (F2-T16 PR3), mirroring
 * `MAX_DECISIONS_PER_CALL`'s exact rationale: an uncapped caller-supplied
 * `limit` (the controller only rejects non-positive-integers, not large
 * ones) could otherwise fetch a workspace's entire `command_proposals` table
 * — including its unbounded `actions`/`decisions` jsonb blobs — in one
 * response. Enforced HERE (not just at the controller) so any future
 * internal caller of `listProposals` that bypasses HTTP is protected too.
 */
export const MAX_LIST_PROPOSALS_LIMIT = 200;

/**
 * A single row of `command_proposals`, as returned by `listProposals`
 * (F2-T16 PR3, ADR-0033 §b/§g) — a direct field-for-field copy of the
 * Drizzle row shape, no transformation needed.
 */
export interface CommandProposalSummary {
  id: string;
  workspaceId: string;
  command: string;
  sourceObjectId: string | null;
  actions: unknown;
  decisions: unknown;
  createdAt: Date;
  decidedAt: Date | null;
}

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

/**
 * The always-and-only actor recorded for a meeting-triggered proposal's own
 * `ActionsProposed` event (ADR-0031 §h) — deliberately distinct from
 * `COMMAND_PARSER_ACTOR` so an audit query can tell the two proposal sources
 * apart purely from `actor.id`, without any calling-user actor involved at
 * all (there IS no calling user for this automatic, webhook-triggered flow).
 */
const MEETING_ACTION_EXTRACTOR_ACTOR = { type: 'agent', id: 'meeting-action-extractor' } as const;

/**
 * The always-and-only actor recorded for a trigger-produced proposal's own
 * `ActionsProposed` event (ADR-0032 Karar (f)) — deliberately distinct from
 * BOTH `COMMAND_PARSER_ACTOR` and `MEETING_ACTION_EXTRACTOR_ACTOR`, so an
 * audit query can tell all three proposal sources apart purely from
 * `actor.id`. There is no calling-user actor for this flow either (a
 * trigger-engine match, not a human command or a webhook-triggered meeting
 * transcript).
 */
const TRIGGER_ENGINE_ACTOR = { type: 'agent', id: 'trigger-engine' } as const;

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
  /** F2-T16 PR2 (ADR-0033 §d/§e): enqueues `webhook_deliveries` rows for `ActionsProposed`/`ActionsDecided`, caught up in the same transaction as `actionProposalProjection`. */
  private readonly webhookDeliveryEnqueueProjection = new WebhookDeliveryEnqueueProjection();
  private readonly logger = new Logger(CommandsService.name);

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

    return this.recordProposal(
      workspaceId,
      COMMAND_PARSER_ACTOR,
      actions,
      sourceObjectId,
      command,
      parseError,
      message,
    );
  }

  /**
   * `proposeFromMeeting` (ADR-0031 §h): the meeting-triggered sibling of
   * `parse()` — sources its proposed actions from `extractMeetingActions`
   * (`../ai/extract-meeting-actions.ts`) instead of `parseCommand`, and
   * shares `parse()`'s `recordProposal` event-recording helper below rather
   * than duplicating it. There is no calling-user actor for this method at
   * all (it's triggered automatically by a webhook, ADR-0031 §i) — every
   * resulting `ActionsProposed` event is always authored by the fixed
   * `MEETING_ACTION_EXTRACTOR_ACTOR`, never `COMMAND_PARSER_ACTOR`.
   *
   * The `command` column never stores the raw transcript (ADR-0031 §f) — a
   * short, synthetic, human-readable string is recorded instead; the real
   * transcript text is only ever used as the AI call's own prompt input.
   */
  async proposeFromMeeting(
    workspaceId: string,
    meetingObjectId: string,
    transcriptText: string,
  ): Promise<CommandsServiceParseResult> {
    const { actions, parseError, message } = await this.aiUsageService.withWorkspaceAILock(
      workspaceId,
      async () => {
        await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
        await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

        const model = selectAIModel({ outputType: 'command' });

        return extractMeetingActions({
          provider: this.aiProvider,
          transcriptText,
          model,
          recordUsage: (usage) =>
            this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
        });
      },
    );

    return this.recordProposal(
      workspaceId,
      MEETING_ACTION_EXTRACTOR_ACTOR,
      actions,
      meetingObjectId,
      `[meeting-action-extraction] meetingObjectId=${meetingObjectId}`,
      parseError,
      message,
    );
  }

  /**
   * `proposeFromTrigger` (ADR-0032 Karar (f)): the THIRD fixed-actor caller
   * of `recordProposal` below, sitting alongside `parse()`
   * (`COMMAND_PARSER_ACTOR`) and `proposeFromMeeting()`
   * (`MEETING_ACTION_EXTRACTOR_ACTOR`). Deliberately simpler than both: the
   * caller (a future trigger-engine, PR5) hands in already-fully-formed
   * `actions` sourced from a trigger's own stored `actionTemplate` — there is
   * no AI call at all, so this method never touches
   * `AIUsageService.withWorkspaceAILock`/quota/budget checks, and
   * `parseError` is always `false` since there is no parse step that can
   * fail.
   *
   * The `command` column never stores raw trigger internals beyond the
   * trigger's own id (mirrors `proposeFromMeeting`'s "never store the raw
   * transcript" discipline) — a short, synthetic, human-readable string is
   * recorded instead.
   *
   * `sourceObjectId` (F2-T15 PR4 widening) is `string | undefined`: a
   * SCHEDULED trigger's fire has no matched source object at all, unlike a
   * condition-trigger match — `recordProposal` below already accepts
   * `string | undefined` and conditionally spreads it, so this is a pure
   * type-level widening, no behavior change.
   */
  async proposeFromTrigger(
    workspaceId: string,
    triggerId: string,
    sourceObjectId: string | undefined,
    actions: ProposedAction[],
  ): Promise<CommandsServiceParseResult> {
    return this.recordProposal(
      workspaceId,
      TRIGGER_ENGINE_ACTOR,
      actions,
      sourceObjectId,
      `[trigger] triggerId=${triggerId}`,
      false,
    );
  }

  /**
   * `recordProposal` (ADR-0031 §h): the shared "durably record an
   * `ActionsProposed` event + return the standard parse-result shape"
   * mechanics, extracted out of `parse()` so `proposeFromMeeting` above can
   * reuse it verbatim without duplicating the event-append logic. `actor`
   * distinguishes the two callers (`COMMAND_PARSER_ACTOR` vs
   * `MEETING_ACTION_EXTRACTOR_ACTOR`); `parseError`/`message` come from each
   * caller's own AI-call result, since this helper has no opinion on how the
   * actions were produced.
   */
  /**
   * F2-T16 PR2 security review finding: `webhookDeliveryEnqueueProjection`'s
   * `catchUp()` runs in its OWN separate transaction from the
   * `ActionsProposed`/`ActionsDecided` append + `actionProposalProjection`
   * catch-up that precedes it. If it threw uncaught, `recordProposal()`/
   * `decide()` would reject AFTER the event (and, for `decide()`,
   * `command_proposals.decided_at`) was already durably committed --
   * permanently stranding the proposal, since `decide()` rejects any retry
   * of an already-decided proposal with `ConflictError` before ever reaching
   * the execution loop again. A webhook-enqueue failure must never be able
   * to do that: it is caught and logged here, exactly like
   * `WebhookDeliveryWorker.runOnce()`'s own "one row's failure never aborts
   * the rest" discipline, never rethrown.
   */
  private async catchUpWebhookDeliveryEnqueue(): Promise<void> {
    try {
      await this.projectionRunner.catchUp(this.webhookDeliveryEnqueueProjection);
    } catch (error) {
      this.logger.error(
        'Webhook delivery enqueue projection catch-up failed; the proposal/decision itself was already committed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async recordProposal(
    workspaceId: string,
    actor: Actor,
    actions: ProposedAction[],
    sourceObjectId: string | undefined,
    command: string,
    parseError: boolean,
    message?: string,
  ): Promise<CommandsServiceParseResult> {
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
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, 0, [event]);
    await this.projectionRunner.catchUp(this.actionProposalProjection);
    await this.catchUpWebhookDeliveryEnqueue();

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
    await this.catchUpWebhookDeliveryEnqueue();

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
      case 'createTaskFromMeeting':
        return this.executeCreateTaskFromMeeting(
          workspaceId,
          action,
          approverActor,
          callerRole,
          causationEventId,
        );
      case 'createTaskFromTrigger':
        return this.executeCreateTaskFromTrigger(
          workspaceId,
          action,
          approverActor,
          callerRole,
          causationEventId,
        );
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
   * `executeCreateTaskFromTrigger` (ADR-0032 Karar (f)): creates the task
   * exactly like `executeCreateTask` — reads `params.title`, creates a
   * `task` object attributed to the REAL approving user (`approverActor`),
   * never `TRIGGER_ENGINE_ACTOR`. Deliberately NO hint resolution of any
   * kind (unlike `executeCreateTaskFromMeeting`'s `assigneeHint`/
   * `dueDateHint`): ADR-0032 has no templating/hints in v0, `params` only
   * ever carries `title`.
   */
  private async executeCreateTaskFromTrigger(
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

  /**
   * `executeCreateTaskFromMeeting` (ADR-0031 §h): creates the task exactly
   * like `executeCreateTask`, then BEST-EFFORT applies `assigneeHint`/
   * `dueDateHint` (if present) — hint resolution failures (no matching
   * member, no active field definition, unparseable date) must NEVER cause
   * the overall result to be `'failed'` once the task itself was created,
   * so each hint's application is wrapped in its own silently-swallowing
   * try/catch (`applyAssigneeHint`/`applyDueDateHint` below).
   */
  private async executeCreateTaskFromMeeting(
    workspaceId: string,
    action: DecidableAction,
    approverActor: Actor,
    callerRole: Role,
    causationEventId: string,
  ): Promise<DecideActionResult> {
    const { actionId } = action;

    try {
      const title = requireStringParam(action.params, 'title');
      const created = await this.objectsService.create(
        workspaceId,
        approverActor,
        { objectType: 'task', title, causationEventId },
        callerRole,
      );

      await this.applyAssigneeHint(
        workspaceId,
        created.id,
        action.params,
        approverActor,
        callerRole,
      );
      await this.applyDueDateHint(
        workspaceId,
        created.id,
        action.params,
        approverActor,
        callerRole,
      );

      return { actionId, status: 'executed' };
    } catch (error) {
      return { actionId, status: 'failed', error: toErrorMessage(error) };
    }
  }

  /**
   * Best-effort `assigneeHint` resolution (ADR-0031's human-approved "Açık
   * Soru 1"): EXACT-MATCH-ONLY, case-insensitive, against a workspace
   * member's `users.email` — no fuzzy/partial matching. Any failure (no
   * matching member, no active `assignee` field definition for `task` in
   * this workspace, etc.) is silently swallowed; the task itself was already
   * created and must not be affected.
   */
  private async applyAssigneeHint(
    workspaceId: string,
    taskId: string,
    params: Record<string, unknown>,
    approverActor: Actor,
    callerRole: Role,
  ): Promise<void> {
    const assigneeHint = params.assigneeHint;
    if (typeof assigneeHint !== 'string') {
      return;
    }

    try {
      const [foundMember] = await this.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            sql`lower(${users.email}) = lower(${assigneeHint})`,
          ),
        )
        .limit(1);

      if (!foundMember) {
        return;
      }

      await this.objectsService.setFieldValues(workspaceId, taskId, approverActor, callerRole, [
        { fieldKey: 'assignee', value: [foundMember.userId] },
      ]);
    } catch (error) {
      // Best-effort: any failure (missing field definition, etc.) is
      // silently swallowed -- the task was already created successfully, and
      // this must never flip the reported status to 'failed'. A
      // ForbiddenError specifically (the approver's role lacks edit
      // permission on this field) is a genuine authorization-configuration
      // signal worth surfacing, unlike "field not defined" -- logged (no
      // hint/email content, only opaque ids) so it isn't invisible
      // (security-reviewer finding, PR4).
      if (error instanceof ForbiddenError) {
        this.logger.warn(
          `assigneeHint could not be applied to task ${taskId}: approver lacks edit permission on the "assignee" field.`,
        );
      }
    }
  }

  /**
   * Best-effort `dueDateHint` resolution (ADR-0031's human-approved "Açık
   * Soru 1"): only `Date.parse`-parseable strings are accepted -- relative
   * expressions ("next week") are deliberately rejected, not fuzzily
   * interpreted. Any failure applying the value (no active `dueDate` field
   * definition, etc.) is silently swallowed.
   */
  private async applyDueDateHint(
    workspaceId: string,
    taskId: string,
    params: Record<string, unknown>,
    approverActor: Actor,
    callerRole: Role,
  ): Promise<void> {
    const dueDateHint = params.dueDateHint;
    if (typeof dueDateHint !== 'string') {
      return;
    }

    const parsedMs = Date.parse(dueDateHint);
    if (Number.isNaN(parsedMs)) {
      return;
    }

    // `dueDate` fields use the `date` field type (`z.iso.date()`, plain
    // `YYYY-MM-DD` — no time component), NOT `datetime` — a full
    // `.toISOString()` timestamp fails that schema (rejected as invalid,
    // silently swallowed below), so the value is truncated to its date
    // portion, which round-trips to the same instant for a pure-date hint.
    const dueDateValue = new Date(parsedMs).toISOString().slice(0, 10);

    try {
      await this.objectsService.setFieldValues(workspaceId, taskId, approverActor, callerRole, [
        { fieldKey: 'dueDate', value: dueDateValue },
      ]);
    } catch (error) {
      // Same discipline as `applyAssigneeHint`'s catch (security-reviewer
      // finding, PR4): never let this flip the reported status away from
      // 'executed', but a ForbiddenError is worth a log signal, unlike a
      // merely-undefined field.
      if (error instanceof ForbiddenError) {
        this.logger.warn(
          `dueDateHint could not be applied to task ${taskId}: approver lacks edit permission on the "dueDate" field.`,
        );
      }
    }
  }

  /**
   * `listProposals` (F2-T16 PR3, ADR-0033 §b/§g): the FIRST general "list
   * proposals" read endpoint on top of ADR-0015's öner→onayla (propose→decide)
   * flow. `member`+ required — DELIBERATELY DIFFERENT from
   * `WebhookSubscriptionsService.list`'s `admin`+-both-ways rule (PR1): a
   * proposal's automation history is "not more sensitive than seeing a
   * trigger DEFINITION" (ADR-0033 §g), so this mirrors
   * `AutomationTriggersService.list`'s member-read precedent instead.
   *
   * Always scoped by `workspaceId` — never cross-workspace, even for an
   * admin/owner of a DIFFERENT workspace. Ordered newest-first by `id`
   * (ULID, lexicographically sortable by creation time in production).
   *
   * Pagination: fetches `limit + 1` rows to detect whether a next page
   * exists without a separate `count(*)` query — if `limit + 1` rows come
   * back, the page is sliced to `limit` and `nextCursor` is set to the last
   * (oldest) row of that page; otherwise every fetched row is returned and
   * `nextCursor` is omitted. `cursor` continues strictly before
   * (`id < cursor`) the given row — no overlap, no gaps across pages.
   */
  async listProposals(
    workspaceId: string,
    callerRole: MembershipRole,
    filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
  ): Promise<{ proposals: CommandProposalSummary[]; nextCursor?: string }> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const limit = Math.min(filter?.limit ?? DEFAULT_LIST_PROPOSALS_LIMIT, MAX_LIST_PROPOSALS_LIMIT);

    const conditions = [eq(commandProposals.workspaceId, workspaceId)];

    if (filter?.pendingOnly === true) {
      conditions.push(isNull(commandProposals.decidedAt));
    }

    if (filter?.cursor !== undefined) {
      conditions.push(lt(commandProposals.id, filter.cursor));
    }

    const rows = await this.db
      .select()
      .from(commandProposals)
      .where(and(...conditions))
      .orderBy(desc(commandProposals.id))
      .limit(limit + 1);

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];

    return {
      proposals: page,
      ...(hasNextPage && lastRow ? { nextCursor: lastRow.id } : {}),
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
