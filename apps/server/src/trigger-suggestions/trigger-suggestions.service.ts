import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { AIProvider } from '@luminaos/ai-gateway';
import { createTrigger } from '@luminaos/automation';
import type { TriggerSpec } from '@luminaos/automation';
import { ConflictError, ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { TriggerTemplateSuggestionProjection } from './trigger-suggestions.projection.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIUsageService } from '../ai/ai-usage.service.js';
import { selectAIModel } from '../ai/select-ai-model.js';
import { suggestTriggerTemplates } from '../ai/suggest-trigger-templates.js';
import { summarizeUsagePatterns } from '../ai/summarize-usage-patterns.js';
import { AutomationTriggersService } from '../automation/automation-triggers.service.js';
import { CommandsService } from '../commands/commands.service.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { triggerSuggestionAnalysisState } from '../db/schema/trigger-suggestion-analysis-state.js';
import { triggerTemplateSuggestions } from '../db/schema/trigger-template-suggestions.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/** The dedicated event-stream type for a suggestion's own `TriggerTemplateSuggested`/`TriggerTemplateApproved`/`TriggerTemplateRejected` events (ADR-0034 §c/§d) — a brand-new, independent stream type, never joining `command_proposals`'s own `action-proposal` stream type. */
const SUGGESTION_STREAM_TYPE = 'trigger-template-suggestion';

/** ADR-0034 §b: an admin-triggered `runAnalysis()` call is rejected with `ConflictError` if the workspace's last run was within this window. */
const COOLDOWN_MS = 15 * 60 * 1000;

/** ADR-0034 §h: `suggestTriggerTemplates`'s own response schema already caps candidates at 5 (`.max(5)`), but this is enforced here too as a defense-in-depth backstop against a future producer bug. */
const MAX_SUGGESTIONS_PER_RUN = 5;

/**
 * The always-and-only actor recorded on every `TriggerTemplateSuggested`
 * event (ADR-0034 §e) — deliberately distinct from `TRIGGER_ENGINE_ACTOR`
 * (`commands.service.ts`, which FIRES an already-approved trigger): this
 * actor SUGGESTS a brand-new trigger template, it never fires one. NEVER
 * used as the actor on the `automation_triggers` row an approval produces
 * (ADR-0034 §g) — that row always records the REAL approving human admin.
 */
export const TRIGGER_SUGGESTION_ACTOR = { type: 'agent', id: 'trigger-suggestion-engine' } as const;

/**
 * A single row of `trigger_template_suggestions`, as returned by `list`/
 * `runAnalysis`/`decide` — a direct field-for-field copy of the Drizzle row
 * shape, no transformation needed (mirrors `CommandProposalSummary`'s own
 * "direct copy" doc comment).
 */
export interface TriggerTemplateSuggestionSummary {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'scheduled' | 'condition';
  spec: TriggerSpec;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  createdTriggerId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/**
 * Recursively sorts every object's keys (arrays keep their order) before
 * `JSON.stringify`-ing, so two structurally-identical specs compare equal
 * regardless of the key order Postgres's `jsonb` storage or zod's own
 * object-schema parsing happen to produce (ADR-0034 §h's `(kind, spec)`
 * dedup check).
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

function dedupKey(kind: string, spec: unknown): string {
  return `${kind}:${JSON.stringify(sortKeysDeep(spec))}`;
}

/**
 * `TriggerSuggestionsService` (F2-T17 PR2, ADR-0034): orchestrates the
 * AI-suggested-automation-trigger-template flow — `runAnalysis` (admin+,
 * §a) analyzes a workspace's usage patterns (`summarizeUsagePatterns`) and
 * asks `suggestTriggerTemplates` for candidate trigger templates, subject to
 * a 15-minute cooldown (§b), a two-layer defensive re-validation (§f), a
 * `(kind, spec)` dedup + 5-per-run cap (§h); `list` (member+, §a) reads the
 * `trigger_template_suggestions` projection; `decide` (admin+, §a) turns an
 * approval into a REAL `AutomationTriggersService.create` call (§f layer 2 /
 * §g) or a reject into a status-only update.
 */
@Injectable()
export class TriggerSuggestionsService {
  /** Same "single, stable instance" reasoning as `AutomationTriggersService.projection`. */
  private readonly projection = new TriggerTemplateSuggestionProjection();
  private readonly logger = new Logger(TriggerSuggestionsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    private readonly aiUsageService: AIUsageService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
    private readonly automationTriggersService: AutomationTriggersService,
    private readonly commandsService: CommandsService,
  ) {}

  async list(
    workspaceId: string,
    callerRole: MembershipRole,
  ): Promise<TriggerTemplateSuggestionSummary[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select()
      .from(triggerTemplateSuggestions)
      .where(eq(triggerTemplateSuggestions.workspaceId, workspaceId));

    return rows.map((row) => this.toSummary(row));
  }

  /**
   * ADR-0034 §b/§e/§f/§h. Sequence inside `withWorkspaceAILock`: cooldown
   * check FIRST (rejected calls never advance `lastRunAt` and never touch
   * quota), THEN quota/budget checks, THEN model selection, THEN the usage
   * summary + AI call, THEN an UNCONDITIONAL `lastRunAt` upsert (regardless
   * of `parseError`). The dry-run filter (§f layer 1) and dedup/cap (§h) run
   * OUTSIDE the lock, since they touch neither AI quota nor the cooldown.
   */
  async runAnalysis(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<TriggerTemplateSuggestionSummary[]> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const aiResult = await this.aiUsageService.withWorkspaceAILock(workspaceId, async () => {
      await this.assertCooldownElapsed(workspaceId);

      await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
      await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

      const model = selectAIModel({ outputType: 'triggerSuggestion' });

      const activeTriggers = await this.automationTriggersService.list(workspaceId, 'admin');
      const { proposals } = await this.commandsService.listProposals(workspaceId, 'admin', {
        limit: 200,
      });
      const decidedProposals = proposals.filter((proposal) => proposal.decidedAt !== null);

      const summary = summarizeUsagePatterns({ activeTriggers, decidedProposals });

      const suggested = await suggestTriggerTemplates({
        provider: this.aiProvider,
        summary,
        model,
        recordUsage: (usage) =>
          this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
      });

      await this.markAnalysisRan(workspaceId);

      return suggested;
    });

    const candidates = aiResult.parseError ? [] : aiResult.suggestions;

    if (candidates.length === 0) {
      return [];
    }

    const existingPendingRows = await this.db
      .select({ kind: triggerTemplateSuggestions.kind, spec: triggerTemplateSuggestions.spec })
      .from(triggerTemplateSuggestions)
      .where(
        and(
          eq(triggerTemplateSuggestions.workspaceId, workspaceId),
          eq(triggerTemplateSuggestions.status, 'pending'),
        ),
      );

    const seenKeys = new Set(existingPendingRows.map((row) => dedupKey(row.kind, row.spec)));
    const insertedIds: string[] = [];

    for (const candidate of candidates) {
      if (insertedIds.length >= MAX_SUGGESTIONS_PER_RUN) {
        break;
      }

      try {
        createTrigger({
          triggerId: 'dry-run',
          workspaceId,
          name: candidate.name,
          spec: candidate.spec,
        });
      } catch {
        // ADR-0034 §f layer 1: never log candidate/suggestion content, only a
        // static message (CLAUDE.md: never log raw error content).
        this.logger.warn(
          'Dropped a trigger-suggestion candidate that failed dry-run business-rule validation.',
        );
        continue;
      }

      const key = dedupKey(candidate.spec.kind, candidate.spec);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);

      const suggestionId = ulid();
      const streamId = randomUUID();

      const event: NewDomainEvent = {
        id: randomUUID(),
        streamType: SUGGESTION_STREAM_TYPE,
        workspaceId,
        type: 'TriggerTemplateSuggested',
        payload: {
          suggestionId,
          workspaceId,
          name: candidate.name,
          kind: candidate.spec.kind,
          spec: candidate.spec,
          rationale: candidate.rationale,
        },
        actor: TRIGGER_SUGGESTION_ACTOR,
        occurredAt: new Date(),
      };

      await this.eventStore.append(streamId, 0, [event]);
      insertedIds.push(suggestionId);
    }

    if (insertedIds.length === 0) {
      return [];
    }

    await this.projectionRunner.catchUp(this.projection);

    const rows = await this.db
      .select()
      .from(triggerTemplateSuggestions)
      .where(inArray(triggerTemplateSuggestions.id, insertedIds));

    const rowsById = new Map(rows.map((row) => [row.id, row]));

    return insertedIds
      .map((id) => rowsById.get(id))
      .filter((row): row is typeof triggerTemplateSuggestions.$inferSelect => row !== undefined)
      .map((row) => this.toSummary(row));
  }

  /**
   * ADR-0034 §f layer 2 / §g. Cross-workspace and nonexistent `suggestionId`
   * are indistinguishable `NotFoundError`s, mirroring `commands.service.ts`'s
   * `decide()` exactly. An approve that fails `AutomationTriggersService.
   * create`'s real validation propagates — the suggestion stays `'pending'`,
   * no `TriggerTemplateApproved` event is appended.
   */
  async decide(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    suggestionId: string,
    decision: 'approve' | 'reject',
  ): Promise<TriggerTemplateSuggestionSummary> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const [row] = await this.db
      .select()
      .from(triggerTemplateSuggestions)
      .where(eq(triggerTemplateSuggestions.id, suggestionId))
      .limit(1);

    // A suggestion that exists but belongs to a DIFFERENT workspace must be
    // indistinguishable from one that doesn't exist at all.
    if (!row || row.workspaceId !== workspaceId) {
      throw new NotFoundError('Trigger template suggestion not found.');
    }

    if (row.status !== 'pending') {
      throw new ConflictError('This trigger template suggestion has already been decided.');
    }

    if (decision === 'reject') {
      const occurredAt = new Date();
      const event: NewDomainEvent = {
        id: randomUUID(),
        streamType: SUGGESTION_STREAM_TYPE,
        workspaceId,
        type: 'TriggerTemplateRejected',
        payload: { suggestionId },
        actor,
        occurredAt,
      };

      await this.eventStore.append(row.streamId, 1, [event]);
      await this.projectionRunner.catchUp(this.projection);

      return {
        ...this.toSummary(row),
        status: 'rejected',
        decidedAt: occurredAt,
      };
    }

    // ADR-0034 §f layer 2: reuses `AutomationTriggersService.create`
    // UNMODIFIED — its own admin+ RBAC + `createTrigger`'s full validation
    // run again here. If it throws, the throw propagates and NOTHING below
    // (the `TriggerTemplateApproved` append) ever runs.
    const spec = row.spec as TriggerSpec;
    const createdTrigger = await this.automationTriggersService.create(
      workspaceId,
      actor,
      callerRole,
      { name: row.name, spec },
    );

    const occurredAt = new Date();
    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: SUGGESTION_STREAM_TYPE,
      workspaceId,
      type: 'TriggerTemplateApproved',
      payload: { suggestionId, createdTriggerId: createdTrigger.id },
      actor,
      occurredAt,
    };

    await this.eventStore.append(row.streamId, 1, [event]);
    await this.projectionRunner.catchUp(this.projection);

    return {
      ...this.toSummary(row),
      status: 'approved',
      createdTriggerId: createdTrigger.id,
      decidedAt: occurredAt,
    };
  }

  /** ADR-0034 §b: throws `ConflictError` without advancing `lastRunAt` if this workspace's last run was within `COOLDOWN_MS`. A workspace with no prior run at all always passes. */
  private async assertCooldownElapsed(workspaceId: string): Promise<void> {
    const [row] = await this.db
      .select({ lastRunAt: triggerSuggestionAnalysisState.lastRunAt })
      .from(triggerSuggestionAnalysisState)
      .where(eq(triggerSuggestionAnalysisState.workspaceId, workspaceId))
      .limit(1);

    if (row === undefined) {
      return;
    }

    if (Date.now() - row.lastRunAt.getTime() < COOLDOWN_MS) {
      throw new ConflictError(
        'An automation-trigger-suggestion analysis for this workspace was run too recently; try again later.',
      );
    }
  }

  /** ADR-0034 §b: upserts `lastRunAt = now()` unconditionally, regardless of `parseError` — mirrors `AutomationTriggersService`'s general upsert style. */
  private async markAnalysisRan(workspaceId: string): Promise<void> {
    const lastRunAt = new Date();

    await this.db
      .insert(triggerSuggestionAnalysisState)
      .values({ workspaceId, lastRunAt })
      .onConflictDoUpdate({
        target: triggerSuggestionAnalysisState.workspaceId,
        set: { lastRunAt },
      });
  }

  private toSummary(
    row: typeof triggerTemplateSuggestions.$inferSelect,
  ): TriggerTemplateSuggestionSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      kind: row.kind as TriggerTemplateSuggestionSummary['kind'],
      spec: row.spec as TriggerSpec,
      rationale: row.rationale,
      status: row.status as TriggerTemplateSuggestionSummary['status'],
      createdTriggerId: row.createdTriggerId,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    };
  }
}
