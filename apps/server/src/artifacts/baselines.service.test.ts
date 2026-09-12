import { describe, expect, it, vi } from 'vitest';

import { computeQueryAggregate } from '@luminaos/artifacts';
import { ValidationError } from '@luminaos/shared';
import type { Actor, QuerySpec } from '@luminaos/shared';

import { BaselinesService } from './baselines.service.js';

import type { CaptureBaselineServiceInput } from './baselines.service.js';
import type { ObjectWithFieldValues, QueryResult } from '../objects/objects.service.js';

/**
 * F3-T10 PR2 (RED step, ADR-0044 Karar c) — `BaselinesService.capture`, the
 * NEW orchestrator that turns an ALREADY-KNOWN `QuerySpec` (sourced from a
 * `SavedView` on the frontend, Karar d -- this service itself is unaware of
 * that origin) into a REAL `artifact` Lumina Object whose `capturedValue` is
 * a single frozen numeric snapshot. Per ADR-0044 Karar (c), `BaselinesService`
 * has ZERO AI-gateway dependency -- unlike `WidgetsService`
 * (`./widgets.service.ts`), its constructor takes ONLY a narrow
 * `Pick<ObjectsService, 'query' | 'create' | 'setFieldValues'>` collaborator,
 * no `AIUsageService`/`FieldDefinitionsService`/`AIProvider` at all.
 *
 * Unit-level, mirrors `./widgets.service.test.ts`'s exact plain-mock,
 * no-Nest-DI, no-Testcontainers harness style. `computeQueryAggregate`
 * (`@luminaos/artifacts`, already merged in PR1) is used FOR REAL here (never
 * mocked) -- this file computes its own "expected" value via the same real
 * function against a realistic row fixture, proving genuine end-to-end
 * computation rather than a stand-in.
 *
 * ============================================================================
 * RED STATE (expected, today): `./baselines.service.ts` does not exist yet on
 * this branch -- every import above resolves to a "Cannot find module" error,
 * so this entire file fails to even load. That is the correct red: it means
 * the SERVICE doesn't exist yet. `implementer` must add `BaselinesService`
 * (ADR-0044 Karar c) to turn this green.
 * ============================================================================
 *
 * Designed contract (must be matched exactly by `implementer`):
 *
 *   export type BaselineObjectsService =
 *     Pick<ObjectsService, 'query' | 'create' | 'setFieldValues'>;
 *
 *   export interface CaptureBaselineServiceInput {
 *     title: string;
 *     querySpec: QuerySpec;
 *     aggregateFn: AggregateFn;
 *     targetFieldKey?: string;
 *   }
 *
 *   class BaselinesService {
 *     constructor(objectsService: BaselineObjectsService)
 *     async capture(
 *       workspaceId: string,
 *       actor: Actor,
 *       callerRole: Role,
 *       input: CaptureBaselineServiceInput,
 *     ): Promise<ObjectWithFieldValues>
 *   }
 */

const ACTOR: Actor = { type: 'user', id: 'user-1' };

const FLAT_QUERY_SPEC: QuerySpec = {
  objectType: 'task',
  filters: [{ field: 'status', operator: 'equals', value: 'doing' }],
};

const GROUPED_QUERY_SPEC: QuerySpec = {
  objectType: 'task',
  filters: [],
  group: 'status',
};

function buildObjectWithFieldValues(
  overrides: Partial<ObjectWithFieldValues> = {},
): ObjectWithFieldValues {
  return {
    id: 'object-1',
    type: 'artifact',
    workspaceId: 'workspace-1',
    title: 'Untitled',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    lifecycle: 'active',
    checklist: [],
    fieldValues: {},
    ...overrides,
  };
}

interface Harness {
  service: BaselinesService;
  queryRows: ObjectWithFieldValues[];
  createdShellId: string;
  objectsMocks: {
    query: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    setFieldValues: ReturnType<typeof vi.fn>;
  };
}

/** Builds a fresh `BaselinesService` + fully-mocked `ObjectsService` Pick for
 * one test. `queryRows` is a REALISTIC row fixture (a numeric custom field,
 * `estimateHours`) so `computeQueryAggregate` -- called for real by
 * `BaselinesService.capture`, never mocked here -- has something meaningful
 * to reduce for `sum`/`avg`/`min`/`max`-style tests. */
function createHarness(
  options: {
    queryResult?: QueryResult;
  } = {},
): Harness {
  const queryRows: ObjectWithFieldValues[] = [
    buildObjectWithFieldValues({
      id: 'row-1',
      title: 'Ship the report',
      fieldValues: { status: 'doing', estimateHours: 3 },
    }),
    buildObjectWithFieldValues({
      id: 'row-2',
      title: 'Review the report',
      fieldValues: { status: 'doing', estimateHours: 5 },
    }),
    buildObjectWithFieldValues({
      id: 'row-3',
      title: 'Ship the follow-up',
      fieldValues: { status: 'doing', estimateHours: 10 },
    }),
  ];

  const createdShellId = 'created-baseline-id';

  const objectsMocks = {
    query: vi.fn(() => Promise.resolve(options.queryResult ?? { objects: queryRows })),
    create: vi.fn(() =>
      Promise.resolve(buildObjectWithFieldValues({ id: createdShellId, title: '' })),
    ),
    setFieldValues: vi.fn(() =>
      Promise.resolve(
        buildObjectWithFieldValues({ id: createdShellId, fieldValues: { persisted: true } }),
      ),
    ),
  };

  const service = new BaselinesService(objectsMocks);

  return { service, queryRows, createdShellId, objectsMocks };
}

describe('BaselinesService.capture — v0 flat-only guard (ADR-0044 Karar c/d)', () => {
  it('throws ValidationError and calls NEITHER query NOR create NOR setFieldValues when input.querySpec.group is set', async () => {
    const { service, objectsMocks } = createHarness();

    const input: CaptureBaselineServiceInput = {
      title: 'Grouped baseline attempt',
      querySpec: GROUPED_QUERY_SPEC,
      aggregateFn: 'count',
    };

    await expect(service.capture('workspace-1', ACTOR, 'member', input)).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(objectsMocks.query).not.toHaveBeenCalled();
    expect(objectsMocks.create).not.toHaveBeenCalled();
    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
  });
});

describe('BaselinesService.capture — calls ObjectsService.query with the exact args', () => {
  it('calls query(workspaceId, callerRole, querySpec)', async () => {
    const { service, objectsMocks } = createHarness();

    await service.capture('workspace-1', ACTOR, 'member', {
      title: 'Doing tasks count',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'count',
    });

    expect(objectsMocks.query).toHaveBeenCalledWith('workspace-1', 'member', FLAT_QUERY_SPEC);
  });
});

describe('BaselinesService.capture — defensive fail-closed guard against a GROUPED query result', () => {
  it('throws ValidationError and calls NEITHER create NOR setFieldValues when query() unexpectedly returns { groups: [...] }', async () => {
    const { service, objectsMocks } = createHarness({
      queryResult: { groups: [{ groupValue: 'doing', count: 0, items: [] }] },
    });

    await expect(
      service.capture('workspace-1', ACTOR, 'member', {
        title: 'Doing tasks count',
        querySpec: FLAT_QUERY_SPEC,
        aggregateFn: 'count',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(objectsMocks.create).not.toHaveBeenCalled();
    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
  });
});

describe('BaselinesService.capture — capturedValue is computed via the REAL, un-mocked computeQueryAggregate', () => {
  it('persists a capturedValue equal to computeQueryAggregate(realRows, "sum", "estimateHours")', async () => {
    const { service, objectsMocks, queryRows } = createHarness();

    await service.capture('workspace-1', ACTOR, 'member', {
      title: 'Total estimate',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'sum',
      targetFieldKey: 'estimateHours',
    });

    const expectedCapturedValue = computeQueryAggregate(queryRows, 'sum', 'estimateHours');
    expect(expectedCapturedValue).toBe(18);

    const entries = objectsMocks.setFieldValues.mock.calls[0]?.[4] as
      { fieldKey: string; value: unknown }[] | undefined;
    const capturedValueEntry = entries?.find((entry) => entry.fieldKey === 'capturedValue');

    expect(capturedValueEntry?.value).toBe(expectedCapturedValue);
  });

  it('persists a capturedValue equal to rows.length ("count" without a targetFieldKey)', async () => {
    const { service, objectsMocks, queryRows } = createHarness();

    await service.capture('workspace-1', ACTOR, 'member', {
      title: 'Doing tasks count',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'count',
    });

    const expectedCapturedValue = computeQueryAggregate(queryRows, 'count', undefined);
    expect(expectedCapturedValue).toBe(3);

    const entries = objectsMocks.setFieldValues.mock.calls[0]?.[4] as
      { fieldKey: string; value: unknown }[] | undefined;
    const capturedValueEntry = entries?.find((entry) => entry.fieldKey === 'capturedValue');

    expect(capturedValueEntry?.value).toBe(expectedCapturedValue);
  });
});

describe('BaselinesService.capture — object creation uses the REAL callerRole', () => {
  it('calls ObjectsService.create(workspaceId, actor, { objectType: "artifact", title }, callerRole) with the caller\'s REAL role', async () => {
    const { service, objectsMocks } = createHarness();

    await service.capture('workspace-1', ACTOR, 'admin', {
      title: 'Total estimate',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'sum',
      targetFieldKey: 'estimateHours',
    });

    expect(objectsMocks.create).toHaveBeenCalledWith(
      'workspace-1',
      ACTOR,
      { objectType: 'artifact', title: 'Total estimate' },
      'admin',
    );
  });
});

describe("BaselinesService.capture — field-value persistence uses the SAME hardcoded 'owner'-bypass as WidgetsService/ArtifactsService", () => {
  it("calls setFieldValues(workspaceId, created.id, actor, 'owner', entries) -- 'owner' HARDCODED, never the caller's own (here: 'guest') callerRole", async () => {
    const { service, objectsMocks, createdShellId } = createHarness();

    await service.capture('workspace-1', ACTOR, 'guest', {
      title: 'Total estimate',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'sum',
      targetFieldKey: 'estimateHours',
    });

    expect(objectsMocks.setFieldValues).toHaveBeenCalledTimes(1);
    const call = objectsMocks.setFieldValues.mock.calls[0] as unknown[];
    const [calledWorkspaceId, calledObjectId, calledActor, calledRole] = call as [
      string,
      string,
      Actor,
      string,
      unknown,
    ];

    expect(calledWorkspaceId).toBe('workspace-1');
    expect(calledObjectId).toBe(createdShellId);
    expect(calledActor).toEqual(ACTOR);
    expect(calledRole).toBe('owner');
  });

  it('entries include artifactType="baseline" (always), querySpec=JSON.stringify(input.querySpec), aggregateFn=input.aggregateFn, WITH a targetFieldKey entry when provided', async () => {
    const { service, objectsMocks } = createHarness();

    await service.capture('workspace-1', ACTOR, 'member', {
      title: 'Total estimate',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'sum',
      targetFieldKey: 'estimateHours',
    });

    const entries = objectsMocks.setFieldValues.mock.calls[0]?.[4] as
      { fieldKey: string; value: unknown }[] | undefined;
    const byKey = new Map(entries?.map((entry) => [entry.fieldKey, entry.value]));

    expect(byKey.get('artifactType')).toBe('baseline');
    expect(byKey.get('querySpec')).toBe(JSON.stringify(FLAT_QUERY_SPEC));
    expect(byKey.get('aggregateFn')).toBe('sum');
    expect(byKey.get('targetFieldKey')).toBe('estimateHours');
  });

  it('entries have NO targetFieldKey entry at all (not even one with value: undefined) when input.targetFieldKey is omitted', async () => {
    const { service, objectsMocks } = createHarness();

    await service.capture('workspace-1', ACTOR, 'member', {
      title: 'Doing tasks count',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'count',
    });

    const entries = objectsMocks.setFieldValues.mock.calls[0]?.[4] as
      { fieldKey: string; value: unknown }[] | undefined;

    expect(entries?.some((entry) => entry.fieldKey === 'targetFieldKey')).toBe(false);
  });

  it('returns the final ObjectWithFieldValues from setFieldValues (not the bare shell from create)', async () => {
    const { service } = createHarness();

    const result = await service.capture('workspace-1', ACTOR, 'member', {
      title: 'Doing tasks count',
      querySpec: FLAT_QUERY_SPEC,
      aggregateFn: 'count',
    });

    expect(result.fieldValues).toEqual({ persisted: true });
  });
});
