import { CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';
import type { AIProvider } from '@luminaos/ai-gateway';
import { computeDeviation, computeQueryAggregate } from '@luminaos/artifacts';
import type { AggregateFn, ObjectType, Role } from '@luminaos/core-objects';
import { ValidationError, querySpecSchema } from '@luminaos/shared';
import type { Actor, QuerySpec } from '@luminaos/shared';

import { explainDeviation } from './explain-deviation.js';

import type { WidgetAIUsageService } from './widgets.service.js';
import type { ObjectsService, ObjectWithFieldValues } from '../objects/objects.service.js';

/**
 * `BaselineExplanationService`'s two collaborators are typed as narrow,
 * structural `Pick`s (imported `type`-only here, so loading this module
 * never pulls in `ObjectsService`'s own runtime module graph -- notably
 * `../config/env.js`'s eager `DATABASE_URL` validation, which
 * `baseline-explanation.service.test.ts`'s plain-mock, no-Nest-DI,
 * no-Testcontainers harness deliberately never sets). A real
 * `ObjectsService` instance still satisfies this narrower interface
 * structurally; `artifacts.module.ts` wires the REAL instance in via an
 * explicit `useFactory` provider, mirroring `WidgetsService`'s/
 * `BaselinesService`'s identical precedent, so this file itself needs no
 * Nest decorators/imports at all. `WidgetAIUsageService` is reused as-is
 * (not redefined) -- same narrow AI-usage-collaborator shape
 * `WidgetsService` already depends on.
 */
export type BaselineExplanationObjectsService = Pick<
  ObjectsService,
  'get' | 'query' | 'setFieldValues'
>;

function parseStoredQuerySpec(raw: unknown): QuerySpec {
  if (typeof raw !== 'string') {
    throw new ValidationError('Baseline is missing a valid stored querySpec.');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Baseline has a malformed stored querySpec (invalid JSON).');
  }

  const result = querySpecSchema.safeParse(parsed);

  if (!result.success) {
    throw new ValidationError('Baseline has an invalid stored querySpec.');
  }

  return result.data;
}

/**
 * `BaselineExplanationService` (F3-T11 PR2, ADR-0045 Karar e/h): orchestrates
 * the "already-captured baseline `artifact` -> re-query live rows -> compute
 * deviation between the frozen `capturedValue` and a freshly-computed
 * `currentValue` -> (only if that computation succeeds) ask AI for a short
 * root-cause explanation card -> persist onto the SAME baseline object" flow.
 * Deliberately kept OUT of `BaselinesService` (ADR-0044 Karar c protects that
 * service's zero-AI-dependency property) -- this is a separate class with
 * its own AI-gateway collaborator.
 */
export class BaselineExplanationService {
  constructor(
    private readonly aiUsageService: WidgetAIUsageService,
    private readonly objectsService: BaselineExplanationObjectsService,
    private readonly provider: AIProvider,
  ) {}

  async explain(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    baselineObjectId: string,
  ): Promise<ObjectWithFieldValues> {
    const baseline = await this.objectsService.get(workspaceId, baselineObjectId, callerRole);

    if (baseline.fieldValues.artifactType !== 'baseline') {
      throw new ValidationError('The referenced object is not a captured baseline artifact.');
    }

    const querySpec = parseStoredQuerySpec(baseline.fieldValues.querySpec);

    const queryResult = await this.objectsService.query(workspaceId, callerRole, querySpec);

    // Defensive, fail-closed narrowing: a baseline's stored `querySpec` is
    // guaranteed flat (never grouped) by `BaselinesService.capture()`'s own
    // guard, this should never occur in practice -- mirrors
    // `WidgetsService.generate`'s/`BaselinesService.capture`'s identical
    // guard.
    if (!('objects' in queryResult)) {
      throw new ValidationError('Unexpected grouped query result for a baseline (unsupported).');
    }

    const aggregateFn = baseline.fieldValues.aggregateFn as AggregateFn;
    const targetFieldKey = baseline.fieldValues.targetFieldKey as string | undefined;
    const capturedValue = baseline.fieldValues.capturedValue as number;

    const currentValue = computeQueryAggregate(queryResult.objects, aggregateFn, targetFieldKey);

    // ADR-0045 Karar (h) — the most important regression here: an
    // un-computable `currentValue` (e.g. the querySpec now matches zero
    // rows) must NEVER reach the AI lock/quota/provider at all.
    if (currentValue === null) {
      throw new ValidationError(
        'Could not compute a current value for this baseline (no matching rows or non-numeric field).',
      );
    }

    const deviation = computeDeviation({ capturedValue, currentValue });
    const model = CLAUDE_SONNET_5;

    const lockResult = await this.aiUsageService.withWorkspaceAILock(workspaceId, async () => {
      await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
      await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

      return explainDeviation({
        provider: this.provider,
        // `objectsService.query()` above already succeeded with this exact
        // `querySpec`, which internally validates `objectType` against
        // `isKnownObjectType` and throws `ValidationError` on an unknown
        // type -- so `querySpec.objectType` (typed as plain `string` by the
        // shared, cross-object-type `querySpecSchema`) is guaranteed to be a
        // real `ObjectType` by this point.
        objectType: querySpec.objectType as ObjectType,
        aggregateFn,
        ...(targetFieldKey !== undefined ? { targetFieldKey } : {}),
        capturedValue,
        currentValue,
        deviation,
        model,
        recordUsage: (usage) =>
          this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
      });
    });

    // `withWorkspaceAILock` is typed generically-erased-to-`unknown` here
    // (see `WidgetAIUsageService`'s own doc comment for why) -- the callback
    // passed above always resolves to exactly `explainDeviation`'s own
    // `ExplainDeviationResult`, so this cast is a safe, structural-only
    // narrowing back to that known shape.
    const { content, parseError } = lockResult as {
      content: { summary: string; possibleCauses: string[] } | undefined;
      parseError: boolean;
    };

    if (parseError || content === undefined) {
      throw new ValidationError('AI deviation explanation could not be generated.');
    }

    // Fixed 'owner' role here, NOT `callerRole`: mirrors
    // `BaselinesService.capture()`'s/`WidgetsService.generate()`'s identical
    // `'owner'`-bypass precedent -- these fields are exclusively
    // system-populated by this explanation pipeline, never a direct manual
    // edit.
    return this.objectsService.setFieldValues(workspaceId, baseline.id, actor, 'owner', [
      { fieldKey: 'explanationSummary', value: content.summary },
      { fieldKey: 'explanationCauses', value: JSON.stringify(content.possibleCauses) },
      { fieldKey: 'explanationGeneratedAt', value: new Date().toISOString() },
    ]);
  }
}
