import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';
import type { AIProvider } from '@luminaos/ai-gateway';
import { computeDeviation, computeQueryAggregate } from '@luminaos/artifacts';
import type { DeviationExplanationContent } from '@luminaos/artifacts';
import { ValidationError } from '@luminaos/shared';
import type { Actor, QuerySpec } from '@luminaos/shared';

vi.mock('./explain-deviation.js', () => ({ explainDeviation: vi.fn() }));

import { BaselineExplanationService } from './baseline-explanation.service.js';
import { explainDeviation } from './explain-deviation.js';

import type { ExplainDeviationResult } from './explain-deviation.js';
import type { ObjectWithFieldValues, QueryResult } from '../objects/objects.service.js';

/**
 * F3-T11 PR2 (RED step, ADR-0045 Karar e/h) — `BaselineExplanationService.explain`,
 * the NEW orchestrator that reads an already-captured baseline `artifact`
 * (F3-T10, ADR-0044), re-queries its live rows, computes the deviation
 * between the frozen `capturedValue` and a freshly-computed `currentValue`,
 * and (only if that computation succeeds) asks AI for a short root-cause
 * explanation card, persisting the result back onto the SAME baseline
 * object.
 *
 * Unit-level, mirrors `./widgets.service.test.ts`'s/`./baselines.service.test.ts`'s
 * exact plain-mock, no-Nest-DI, no-Testcontainers harness style.
 * `computeQueryAggregate`/`computeDeviation` (`@luminaos/artifacts`, already
 * merged) are used FOR REAL here (never mocked). `explainDeviation`
 * (`./explain-deviation.ts`, PR1, already merged) IS mocked here -- its own
 * JSON+zod+1-retry contract is separately pinned by
 * `./explain-deviation.test.ts`.
 *
 * ============================================================================
 * RED STATE (expected, today): `./baseline-explanation.service.ts` does not
 * exist yet on this branch -- the import below resolves to a
 * "Cannot find module" error, so this entire file fails to even load. That is
 * the correct red: it means the SERVICE doesn't exist yet. `implementer` must
 * add `BaselineExplanationService` (ADR-0045 Karar e) to turn this green.
 * ============================================================================
 *
 * Designed contract (must be matched exactly by `implementer`):
 *
 *   export type BaselineExplanationObjectsService =
 *     Pick<ObjectsService, 'get' | 'query' | 'setFieldValues'>;
 *   export type BaselineExplanationAIUsageService = WidgetAIUsageService;
 *
 *   class BaselineExplanationService {
 *     constructor(
 *       aiUsageService: BaselineExplanationAIUsageService,
 *       objectsService: BaselineExplanationObjectsService,
 *       provider: AIProvider,
 *     )
 *     async explain(
 *       workspaceId: string,
 *       actor: Actor,
 *       callerRole: Role,
 *       baselineObjectId: string,
 *     ): Promise<ObjectWithFieldValues>
 *   }
 */

const ACTOR: Actor = { type: 'user', id: 'user-1' };

const FLAT_QUERY_SPEC: QuerySpec = {
  objectType: 'task',
  filters: [{ field: 'status', operator: 'equals', value: 'doing' }],
};

function buildObjectWithFieldValues(
  overrides: Partial<ObjectWithFieldValues> = {},
): ObjectWithFieldValues {
  return {
    id: 'baseline-1',
    type: 'artifact',
    workspaceId: 'workspace-1',
    title: 'Doing tasks count',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    lifecycle: 'active',
    checklist: [],
    fieldValues: {},
    ...overrides,
  };
}

/** A real, well-formed baseline `artifact` fieldValues bag -- mirrors exactly
 * what `BaselinesService.capture()` (F3-T10, merged) itself writes. */
function buildBaseline(
  overrides: Record<string, unknown> = {},
  querySpec: QuerySpec = FLAT_QUERY_SPEC,
): ObjectWithFieldValues {
  return buildObjectWithFieldValues({
    fieldValues: {
      artifactType: 'baseline',
      querySpec: JSON.stringify(querySpec),
      aggregateFn: 'sum',
      targetFieldKey: 'estimateHours',
      capturedValue: 10,
      ...overrides,
    },
  });
}

interface Harness {
  service: BaselineExplanationService;
  calls: string[];
  queryRows: ObjectWithFieldValues[];
  aiUsageMocks: {
    withWorkspaceAILock: ReturnType<typeof vi.fn>;
    assertAITokenQuotaNotExceeded: ReturnType<typeof vi.fn>;
    assertAICostBudgetNotExceeded: ReturnType<typeof vi.fn>;
    recordAIUsage: ReturnType<typeof vi.fn>;
  };
  objectsMocks: {
    get: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    setFieldValues: ReturnType<typeof vi.fn>;
  };
  provider: AIProvider;
  providerComplete: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  baseline?: ObjectWithFieldValues;
  queryResult?: QueryResult;
  explainResult?: ExplainDeviationResult;
}

/** Builds a fresh `BaselineExplanationService` + fully-mocked collaborators
 * for one test. `calls` records the relative ORDER of every collaborator
 * invocation, mirroring `./widgets.service.test.ts`'s identical technique. */
function createHarness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];

  const queryRows: ObjectWithFieldValues[] = [
    buildObjectWithFieldValues({
      id: 'row-1',
      title: 'Ship the report',
      fieldValues: { status: 'doing', estimateHours: 5 },
    }),
    buildObjectWithFieldValues({
      id: 'row-2',
      title: 'Review the report',
      fieldValues: { status: 'doing', estimateHours: 20 },
    }),
  ];

  const explainDeviationMock = vi.mocked(explainDeviation);
  explainDeviationMock.mockReset();
  explainDeviationMock.mockImplementation(async (input) => {
    calls.push('explainDeviation');
    await input.recordUsage({ inputTokens: 42, outputTokens: 8 });
    return (
      options.explainResult ?? {
        content: { summary: 'Usage rose sharply.', possibleCauses: ['More work was logged.'] },
        parseError: false,
      }
    );
  });

  const aiUsageMocks = {
    withWorkspaceAILock: vi.fn(async (_workspaceId: string, fn: () => Promise<unknown>) => {
      calls.push('lock:enter');
      const result = await fn();
      calls.push('lock:exit');
      return result;
    }),
    assertAITokenQuotaNotExceeded: vi.fn(() => {
      calls.push('assertQuota');
      return Promise.resolve();
    }),
    assertAICostBudgetNotExceeded: vi.fn(() => {
      calls.push('assertBudget');
      return Promise.resolve();
    }),
    recordAIUsage: vi.fn(() => {
      calls.push('recordAIUsage');
      return Promise.resolve();
    }),
  };

  const objectsMocks = {
    get: vi.fn(() => {
      calls.push('get');
      return Promise.resolve(options.baseline ?? buildBaseline());
    }),
    query: vi.fn(() => {
      calls.push('query');
      return Promise.resolve(options.queryResult ?? { objects: queryRows });
    }),
    setFieldValues: vi.fn(() => {
      calls.push('setFieldValues');
      return Promise.resolve(
        buildObjectWithFieldValues({ id: 'baseline-1', fieldValues: { persisted: true } }),
      );
    }),
  };

  const providerComplete = vi.fn();
  const provider = { complete: providerComplete } as unknown as AIProvider;

  const service = new BaselineExplanationService(aiUsageMocks, objectsMocks, provider);

  return { service, calls, queryRows, aiUsageMocks, objectsMocks, provider, providerComplete };
}

describe('BaselineExplanationService.explain — reads the baseline via ObjectsService.get', () => {
  it('calls objectsService.get(workspaceId, baselineObjectId, callerRole)', async () => {
    const { service, objectsMocks } = createHarness();

    await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    expect(objectsMocks.get).toHaveBeenCalledWith('workspace-1', 'baseline-1', 'member');
  });
});

describe('BaselineExplanationService.explain — artifactType guard', () => {
  it('throws ValidationError and calls NEITHER query NOR setFieldValues NOR the AI lock/provider when fieldValues.artifactType !== "baseline"', async () => {
    const { service, objectsMocks, aiUsageMocks, providerComplete } = createHarness({
      baseline: buildBaseline({ artifactType: 'dashboard' }),
    });

    await expect(
      service.explain('workspace-1', ACTOR, 'member', 'baseline-1'),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(objectsMocks.query).not.toHaveBeenCalled();
    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
    expect(aiUsageMocks.withWorkspaceAILock).not.toHaveBeenCalled();
    expect(providerComplete).not.toHaveBeenCalled();
  });
});

describe('BaselineExplanationService.explain — stored querySpec parse guard', () => {
  it('throws ValidationError and calls NEITHER query NOR setFieldValues NOR the AI lock when fieldValues.querySpec is not valid JSON', async () => {
    const { service, objectsMocks, aiUsageMocks } = createHarness({
      baseline: buildBaseline({ querySpec: 'not-json{{' }),
    });

    await expect(
      service.explain('workspace-1', ACTOR, 'member', 'baseline-1'),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(objectsMocks.query).not.toHaveBeenCalled();
    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
    expect(aiUsageMocks.withWorkspaceAILock).not.toHaveBeenCalled();
  });

  it('throws ValidationError when fieldValues.querySpec is valid JSON but fails querySpecSchema (e.g. missing "objectType"/"filters")', async () => {
    const { service, objectsMocks, aiUsageMocks } = createHarness({
      baseline: buildBaseline({ querySpec: JSON.stringify({ foo: 'bar' }) }),
    });

    await expect(
      service.explain('workspace-1', ACTOR, 'member', 'baseline-1'),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(objectsMocks.query).not.toHaveBeenCalled();
    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
    expect(aiUsageMocks.withWorkspaceAILock).not.toHaveBeenCalled();
  });
});

describe('BaselineExplanationService.explain — queries live rows with the parsed querySpec', () => {
  it('calls objectsService.query(workspaceId, callerRole, parsedQuerySpec), AFTER get and BEFORE the AI lock', async () => {
    const { service, objectsMocks, calls } = createHarness();

    await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    expect(objectsMocks.query).toHaveBeenCalledWith('workspace-1', 'member', FLAT_QUERY_SPEC);
    expect(calls.indexOf('get')).toBeLessThan(calls.indexOf('query'));
    expect(calls.indexOf('query')).toBeLessThan(calls.indexOf('lock:enter'));
  });
});

describe('BaselineExplanationService.explain — currentValue is computed via the REAL, un-mocked computeQueryAggregate', () => {
  it('passes currentValue = computeQueryAggregate(realRows, aggregateFn, targetFieldKey) into explainDeviation', async () => {
    const { service, queryRows } = createHarness();

    await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    const expectedCurrentValue = computeQueryAggregate(queryRows, 'sum', 'estimateHours');
    expect(expectedCurrentValue).toBe(25);

    const explainDeviationMock = vi.mocked(explainDeviation);
    expect(explainDeviationMock).toHaveBeenCalledTimes(1);
    const input = explainDeviationMock.mock.calls[0]?.[0];
    expect(input?.currentValue).toBe(expectedCurrentValue);
    expect(input?.capturedValue).toBe(10);
  });
});

describe('BaselineExplanationService.explain — cost-protection: an un-computable currentValue NEVER invokes AI (ADR-0045 Karar h)', () => {
  it('throws ValidationError and calls NEITHER withWorkspaceAILock NOR assertAITokenQuotaNotExceeded NOR the provider NOR explainDeviation NOR setFieldValues, when computeQueryAggregate returns null', async () => {
    const { service, objectsMocks, aiUsageMocks, providerComplete } = createHarness({
      baseline: buildBaseline({ aggregateFn: 'avg', targetFieldKey: 'fieldThatNoRowHas' }),
    });

    await expect(
      service.explain('workspace-1', ACTOR, 'member', 'baseline-1'),
    ).rejects.toBeInstanceOf(ValidationError);

    // Sanity: this scenario really does make the REAL computeQueryAggregate
    // return null (avg over zero numeric values).
    const { queryRows } = createHarness();
    expect(computeQueryAggregate(queryRows, 'avg', 'fieldThatNoRowHas')).toBeNull();

    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
    expect(aiUsageMocks.withWorkspaceAILock).not.toHaveBeenCalled();
    expect(aiUsageMocks.assertAITokenQuotaNotExceeded).not.toHaveBeenCalled();
    expect(aiUsageMocks.assertAICostBudgetNotExceeded).not.toHaveBeenCalled();
    expect(providerComplete).not.toHaveBeenCalled();
    expect(vi.mocked(explainDeviation)).not.toHaveBeenCalled();
  });
});

describe('BaselineExplanationService.explain — AI lock/quota discipline + explainDeviation input shape', () => {
  it('performs assertAITokenQuotaNotExceeded/assertAICostBudgetNotExceeded INSIDE withWorkspaceAILock, before calling explainDeviation, then exits the lock before setFieldValues', async () => {
    const { service, aiUsageMocks, calls } = createHarness();

    await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    expect(aiUsageMocks.withWorkspaceAILock).toHaveBeenCalledWith(
      'workspace-1',
      expect.any(Function),
    );

    const enterIdx = calls.indexOf('lock:enter');
    const quotaIdx = calls.indexOf('assertQuota');
    const budgetIdx = calls.indexOf('assertBudget');
    const explainIdx = calls.indexOf('explainDeviation');
    const exitIdx = calls.indexOf('lock:exit');
    const setFieldValuesIdx = calls.indexOf('setFieldValues');

    expect(enterIdx).toBeLessThan(quotaIdx);
    expect(quotaIdx).toBeLessThan(budgetIdx);
    expect(budgetIdx).toBeLessThan(explainIdx);
    expect(explainIdx).toBeLessThan(exitIdx);
    expect(exitIdx).toBeLessThan(setFieldValuesIdx);
  });

  it('calls explainDeviation with { provider, objectType: querySpec.objectType, aggregateFn, targetFieldKey, capturedValue, currentValue, deviation: computeDeviation({capturedValue, currentValue}), model: CLAUDE_SONNET_5, recordUsage }', async () => {
    const { service, provider, queryRows } = createHarness();

    await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    const currentValue = computeQueryAggregate(queryRows, 'sum', 'estimateHours') as number;
    const expectedDeviation = computeDeviation({ capturedValue: 10, currentValue });

    const explainDeviationMock = vi.mocked(explainDeviation);
    expect(explainDeviationMock).toHaveBeenCalledTimes(1);
    const input = explainDeviationMock.mock.calls[0]?.[0];

    expect(input?.provider).toBe(provider);
    expect(input?.objectType).toBe('task');
    expect(input?.aggregateFn).toBe('sum');
    expect(input?.targetFieldKey).toBe('estimateHours');
    expect(input?.capturedValue).toBe(10);
    expect(input?.currentValue).toBe(currentValue);
    expect(input?.deviation).toEqual(expectedDeviation);
    expect(input?.model).toBe(CLAUDE_SONNET_5);
    expect(typeof input?.recordUsage).toBe('function');
  });

  it("calls AIUsageService.recordAIUsage with (workspaceId, undefined, undefined, usage, model) when explainDeviation's recordUsage callback fires", async () => {
    const { service, aiUsageMocks } = createHarness();

    await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    expect(aiUsageMocks.recordAIUsage).toHaveBeenCalledWith(
      'workspace-1',
      undefined,
      undefined,
      { inputTokens: 42, outputTokens: 8 },
      CLAUDE_SONNET_5,
    );
  });
});

describe('BaselineExplanationService.explain — explainDeviation failure surfaces as ValidationError, no persistence happens', () => {
  it('throws ValidationError and calls NEITHER setFieldValues when explainDeviation reports parseError:true', async () => {
    const { service, objectsMocks } = createHarness({
      explainResult: {
        content: undefined,
        parseError: true,
        message: 'AI response could not be parsed into a valid deviation explanation after retry',
      },
    });

    await expect(
      service.explain('workspace-1', ACTOR, 'member', 'baseline-1'),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
  });
});

describe("BaselineExplanationService.explain — success: persists via the SAME hardcoded 'owner'-bypass as BaselinesService/WidgetsService", () => {
  it("calls setFieldValues(workspaceId, baselineObjectId, actor, 'owner', entries) -- 'owner' HARDCODED, never the caller's own (here: 'guest') callerRole", async () => {
    const { service, objectsMocks } = createHarness();

    await service.explain('workspace-1', ACTOR, 'guest', 'baseline-1');

    expect(objectsMocks.setFieldValues).toHaveBeenCalledTimes(1);
    const call = objectsMocks.setFieldValues.mock.calls[0] as unknown[];
    const [calledWorkspaceId, calledObjectId, calledActor, calledRole, entries] = call as [
      string,
      string,
      Actor,
      string,
      { fieldKey: string; value: unknown }[],
    ];

    expect(calledWorkspaceId).toBe('workspace-1');
    expect(calledObjectId).toBe('baseline-1');
    expect(calledActor).toEqual(ACTOR);
    expect(calledRole).toBe('owner');

    const byKey = new Map(entries.map((entry) => [entry.fieldKey, entry.value]));
    expect(byKey.get('explanationSummary')).toBe('Usage rose sharply.');
    expect(byKey.get('explanationCauses')).toBe(JSON.stringify(['More work was logged.']));

    const generatedAt = byKey.get('explanationGeneratedAt');
    expect(typeof generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(generatedAt as string))).toBe(false);
  });

  it('persists a DIFFERENT explanationSummary/explanationCauses pair when explainDeviation resolves a different DeviationExplanationContent (no history -- overwrite, ADR-0045 Karar f)', async () => {
    const secondContent: DeviationExplanationContent = {
      summary: 'A different explanation, from a re-run.',
      possibleCauses: ['A brand-new cause.', 'Another new cause.'],
    };
    const { service, objectsMocks } = createHarness({
      explainResult: { content: secondContent, parseError: false },
    });

    await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    const entries = objectsMocks.setFieldValues.mock.calls[0]?.[4] as
      { fieldKey: string; value: unknown }[] | undefined;
    const byKey = new Map(entries?.map((entry) => [entry.fieldKey, entry.value]));

    expect(byKey.get('explanationSummary')).toBe(secondContent.summary);
    expect(byKey.get('explanationCauses')).toBe(JSON.stringify(secondContent.possibleCauses));
  });

  it('returns the final ObjectWithFieldValues from setFieldValues (not the raw baseline read from get)', async () => {
    const { service } = createHarness();

    const result = await service.explain('workspace-1', ACTOR, 'member', 'baseline-1');

    expect(result.fieldValues).toEqual({ persisted: true });
  });
});
