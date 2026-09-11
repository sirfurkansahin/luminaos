import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';
import type { AIProvider } from '@luminaos/ai-gateway';
import {
  buildQueryResultTableSection,
  deriveWidgetColumns,
  renderArtifactHtml,
} from '@luminaos/artifacts';
import type { ArtifactContent } from '@luminaos/artifacts';
import type { FieldDefinition } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';
import type { Actor, QuerySpec } from '@luminaos/shared';

vi.mock('./compile-widget-query.js', () => ({ compileWidgetQuery: vi.fn() }));

import { compileWidgetQuery } from './compile-widget-query.js';
import { WidgetsService } from './widgets.service.js';

import type { ObjectWithFieldValues } from '../objects/objects.service.js';

/**
 * F3-T8 PR2 (RED step, ADR-0042 Karar d) — `WidgetsService.generate`, the NEW
 * orchestrator that turns a natural-language query request into a REAL
 * `artifact` Lumina Object whose content comes from ACTUAL query rows, not
 * from AI-generated text. Per ADR-0042 Karar (d), `WidgetsService.generate()`
 * does NOT call `ArtifactsService.generate()` -- it follows its own PARALLEL
 * flow: compile (AI, inside the lock) -> query (outside the lock, cheap) ->
 * `buildQueryResultTableSection` (pure, code) -> `renderArtifactHtml`
 * (unchanged) -> persist (`ArtifactsService`'s SAME `'owner'`-bypass pattern).
 *
 * Unit-level, all collaborators mocked/manually constructed (NOT going
 * through Nest DI/Testcontainers): `ArtifactsService` itself
 * (`./artifacts.service.ts`) only has an integration-level test
 * (`./artifacts.service.integration.test.ts`), but THIS file deliberately
 * diverges from that precedent -- the acceptance criteria this file must pin
 * (exact call ORDERING relative to the AI lock, "these mocks were NEVER
 * called" assertions on the parse-error path, the exact `setFieldValues`
 * entry shape) are far more precisely and cheaply provable against directly
 * injected mocks than against a real Postgres/Redis harness. `compileWidgetQuery`
 * itself (`./compile-widget-query.ts`) is mocked here -- its OWN retry/
 * allowlist contract is separately pinned by `./compile-widget-query.test.ts`.
 * `deriveWidgetColumns`/`buildQueryResultTableSection`/`renderArtifactHtml`
 * (all pure, already merged in `@luminaos/artifacts`) are deliberately NOT
 * mocked -- used for real, so the persisted `htmlContent` assertion below
 * proves the REAL pipeline output, not a stand-in.
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./widgets.service.ts` does not exist yet on this branch, so every
 * assertion below is expected to fail with a module-not-found error):
 *
 *   constructor(aiUsageService, objectsService, fieldDefinitionsService, provider)
 *
 *   async generate(
 *     workspaceId: string,
 *     actor: Actor,
 *     callerRole: Role,
 *     input: { prompt: string; objectType: ObjectType; themePreset: ThemePresetName },
 *   ): Promise<ObjectWithFieldValues>
 */

const ACTOR: Actor = { type: 'user', id: 'user-1' };

const FAKE_QUERY_SPEC: QuerySpec = {
  objectType: 'task',
  filters: [{ field: 'status', operator: 'equals', value: 'doing' }],
  sort: [{ field: 'title', direction: 'asc' }],
};

function buildFieldDefinition(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: 'field-status',
    workspaceId: 'workspace-1',
    objectType: 'task',
    key: 'status',
    label: 'Status',
    fieldType: 'select',
    config: {},
    permissions: { owner: 'edit', admin: 'edit', member: 'edit', guest: 'view' },
    lifecycle: 'active',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

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

interface CompileResult {
  querySpec: QuerySpec | undefined;
  parseError: boolean;
  message?: string;
}

interface Harness {
  service: WidgetsService;
  calls: string[];
  queryRows: ObjectWithFieldValues[];
  createdShellId: string;
  aiUsageMocks: {
    withWorkspaceAILock: ReturnType<typeof vi.fn>;
    assertAITokenQuotaNotExceeded: ReturnType<typeof vi.fn>;
    assertAICostBudgetNotExceeded: ReturnType<typeof vi.fn>;
    recordAIUsage: ReturnType<typeof vi.fn>;
  };
  objectsMocks: {
    query: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    setFieldValues: ReturnType<typeof vi.fn>;
  };
  fieldDefinitionsMocks: {
    list: ReturnType<typeof vi.fn>;
  };
  provider: AIProvider;
}

/** Builds a fresh WidgetsService + fully-mocked collaborators for one test,
 * scripting `compileWidgetQuery`'s (mocked) result. `calls` records the
 * relative ORDER of every collaborator invocation, so ordering assertions
 * (lock-scoping, list-before-compile, query-after-lock) don't depend on
 * fragile call-count inspection alone. */
function createHarness(compileResult: CompileResult): Harness {
  const calls: string[] = [];

  const compileWidgetQueryMock = vi.mocked(compileWidgetQuery);
  compileWidgetQueryMock.mockReset();
  compileWidgetQueryMock.mockImplementation(async (input) => {
    calls.push('compileWidgetQuery');
    await input.recordUsage({ inputTokens: 77, outputTokens: 33 });
    return compileResult;
  });

  const queryRows: ObjectWithFieldValues[] = [
    buildObjectWithFieldValues({
      id: 'row-1',
      title: 'Ship the report',
      fieldValues: { status: 'doing' },
    }),
  ];

  const createdShellId = 'created-widget-id';

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
    query: vi.fn(() => {
      calls.push('query');
      return Promise.resolve({ objects: queryRows });
    }),
    create: vi.fn(() => {
      calls.push('create');
      return Promise.resolve(buildObjectWithFieldValues({ id: createdShellId, title: '' }));
    }),
    setFieldValues: vi.fn(() => {
      calls.push('setFieldValues');
      return Promise.resolve(
        buildObjectWithFieldValues({ id: createdShellId, fieldValues: { persisted: true } }),
      );
    }),
  };

  const fieldDefinitionsMocks = {
    list: vi.fn(() => {
      calls.push('list');
      return Promise.resolve([buildFieldDefinition()]);
    }),
  };

  const provider = { complete: vi.fn() } as unknown as AIProvider;

  const service = new WidgetsService(aiUsageMocks, objectsMocks, fieldDefinitionsMocks, provider);

  return {
    service,
    calls,
    queryRows,
    createdShellId,
    aiUsageMocks,
    objectsMocks,
    fieldDefinitionsMocks,
    provider,
  };
}

describe('WidgetsService.generate — field-context lookup happens before compiling', () => {
  it('calls FieldDefinitionsService.list with (workspaceId, objectType, callerRole), before compileWidgetQuery', async () => {
    const { service, fieldDefinitionsMocks, calls } = createHarness({
      querySpec: FAKE_QUERY_SPEC,
      parseError: false,
    });

    await service.generate('workspace-1', ACTOR, 'member', {
      prompt: 'show tasks by status',
      objectType: 'task',
      themePreset: 'kurumsal',
    });

    expect(fieldDefinitionsMocks.list).toHaveBeenCalledWith('workspace-1', 'task', 'member');
    expect(calls.indexOf('list')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('list')).toBeLessThan(calls.indexOf('compileWidgetQuery'));
  });
});

describe('WidgetsService.generate — AI lock/quota discipline', () => {
  it('performs assertAITokenQuotaNotExceeded/assertAICostBudgetNotExceeded INSIDE withWorkspaceAILock, before compiling, and calls compileWidgetQuery with the field-filtered availableFields + CLAUDE_SONNET_5 model', async () => {
    const { service, aiUsageMocks, calls, provider } = createHarness({
      querySpec: FAKE_QUERY_SPEC,
      parseError: false,
    });

    await service.generate('workspace-1', ACTOR, 'member', {
      prompt: 'show tasks by status',
      objectType: 'task',
      themePreset: 'kurumsal',
    });

    expect(aiUsageMocks.withWorkspaceAILock).toHaveBeenCalledWith(
      'workspace-1',
      expect.any(Function),
    );

    const enterIdx = calls.indexOf('lock:enter');
    const quotaIdx = calls.indexOf('assertQuota');
    const budgetIdx = calls.indexOf('assertBudget');
    const compileIdx = calls.indexOf('compileWidgetQuery');
    const exitIdx = calls.indexOf('lock:exit');

    expect(enterIdx).toBeLessThan(quotaIdx);
    expect(quotaIdx).toBeLessThan(budgetIdx);
    expect(budgetIdx).toBeLessThan(compileIdx);
    expect(compileIdx).toBeLessThan(exitIdx);

    const compileWidgetQueryMock = vi.mocked(compileWidgetQuery);
    expect(compileWidgetQueryMock).toHaveBeenCalledTimes(1);
    const input = compileWidgetQueryMock.mock.calls[0]?.[0];
    expect(input?.provider).toBe(provider);
    expect(input?.prompt).toBe('show tasks by status');
    expect(input?.objectType).toBe('task');
    expect(input?.availableFields).toEqual([buildFieldDefinition()]);
    expect(input?.model).toBe(CLAUDE_SONNET_5);
    expect(typeof input?.recordUsage).toBe('function');
  });

  it("calls AIUsageService.recordAIUsage with (workspaceId, undefined, undefined, usage, model) -- context-free, per ADR-0042's compile-time-only usage recording", async () => {
    const { service, aiUsageMocks } = createHarness({
      querySpec: FAKE_QUERY_SPEC,
      parseError: false,
    });

    await service.generate('workspace-1', ACTOR, 'member', {
      prompt: 'show tasks by status',
      objectType: 'task',
      themePreset: 'kurumsal',
    });

    expect(aiUsageMocks.recordAIUsage).toHaveBeenCalledWith(
      'workspace-1',
      undefined,
      undefined,
      { inputTokens: 77, outputTokens: 33 },
      CLAUDE_SONNET_5,
    );
  });
});

describe('WidgetsService.generate — compile failure surfaces as ValidationError, no object is ever created', () => {
  it('throws ValidationError and calls NEITHER ObjectsService.query NOR .create NOR .setFieldValues when compileWidgetQuery reports parseError:true', async () => {
    const { service, objectsMocks } = createHarness({
      querySpec: undefined,
      parseError: true,
      message: 'AI response could not be compiled into a valid, referenceable query after retry',
    });

    await expect(
      service.generate('workspace-1', ACTOR, 'member', {
        prompt: 'show something ambiguous',
        objectType: 'task',
        themePreset: 'kurumsal',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(objectsMocks.query).not.toHaveBeenCalled();
    expect(objectsMocks.create).not.toHaveBeenCalled();
    expect(objectsMocks.setFieldValues).not.toHaveBeenCalled();
  });
});

describe('WidgetsService.generate — success path: query happens OUTSIDE the lock, against the compiled querySpec', () => {
  it('calls ObjectsService.query(workspaceId, callerRole, querySpec) only AFTER withWorkspaceAILock has already resolved', async () => {
    const { service, objectsMocks, calls } = createHarness({
      querySpec: FAKE_QUERY_SPEC,
      parseError: false,
    });

    await service.generate('workspace-1', ACTOR, 'member', {
      prompt: 'show tasks by status',
      objectType: 'task',
      themePreset: 'kurumsal',
    });

    expect(objectsMocks.query).toHaveBeenCalledWith('workspace-1', 'member', FAKE_QUERY_SPEC);
    expect(calls.indexOf('lock:exit')).toBeLessThan(calls.indexOf('query'));
  });
});

describe('WidgetsService.generate — content is built from REAL query rows via the REAL, un-mocked @luminaos/artifacts pipeline', () => {
  it('persists an htmlContent field value equal to what renderArtifactHtml(buildQueryResultTableSection(realRows, deriveWidgetColumns(querySpec)), themePreset, "dashboard") produces', async () => {
    const { service, objectsMocks, queryRows } = createHarness({
      querySpec: FAKE_QUERY_SPEC,
      parseError: false,
    });
    const prompt = 'show tasks by status, sorted by title';

    await service.generate('workspace-1', ACTOR, 'member', {
      prompt,
      objectType: 'task',
      themePreset: 'kurumsal',
    });

    const columns = deriveWidgetColumns(FAKE_QUERY_SPEC);
    const expectedContent: ArtifactContent = {
      title: prompt.slice(0, 200),
      sections: [buildQueryResultTableSection(queryRows, columns)],
    };
    const expectedHtml = renderArtifactHtml(expectedContent, 'kurumsal', 'dashboard');

    expect(objectsMocks.setFieldValues).toHaveBeenCalledTimes(1);
    const entries = objectsMocks.setFieldValues.mock.calls[0]?.[4] as
      { fieldKey: string; value: unknown }[] | undefined;
    const htmlEntry = entries?.find((entry) => entry.fieldKey === 'htmlContent');

    expect(htmlEntry?.value).toBe(expectedHtml);
  });
});

describe('WidgetsService.generate — object creation uses the REAL callerRole, title = prompt sliced to 200 chars', () => {
  it('calls ObjectsService.create(workspaceId, actor, { objectType: "artifact", title }, callerRole) with the caller\'s REAL role', async () => {
    const { service, objectsMocks } = createHarness({
      querySpec: FAKE_QUERY_SPEC,
      parseError: false,
    });
    const longPrompt = 'x'.repeat(300);

    await service.generate('workspace-1', ACTOR, 'admin', {
      prompt: longPrompt,
      objectType: 'task',
      themePreset: 'canli',
    });

    expect(objectsMocks.create).toHaveBeenCalledWith(
      'workspace-1',
      ACTOR,
      { objectType: 'artifact', title: longPrompt.slice(0, 200) },
      'admin',
    );
  });
});

describe("WidgetsService.generate — field-value persistence uses the SAME hardcoded 'owner'-bypass as ArtifactsService.generate() (ADR-0041 precedent)", () => {
  it("calls ObjectsService.setFieldValues(workspaceId, created.id, actor, 'owner', entries) -- 'owner' HARDCODED, never the caller's own (here: 'guest') callerRole", async () => {
    const { service, objectsMocks, createdShellId } = createHarness({
      querySpec: FAKE_QUERY_SPEC,
      parseError: false,
    });
    const prompt = 'show notes by status';

    await service.generate('workspace-1', ACTOR, 'guest', {
      prompt,
      objectType: 'note',
      themePreset: 'minimal',
    });

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
    expect(calledObjectId).toBe(createdShellId);
    expect(calledActor).toEqual(ACTOR);
    expect(calledRole).toBe('owner');

    const byKey = new Map(entries.map((entry) => [entry.fieldKey, entry.value]));
    expect(typeof byKey.get('htmlContent')).toBe('string');
    expect(byKey.get('themePreset')).toBe('minimal');
    expect(byKey.get('generationPrompt')).toBe(prompt);
    // ALWAYS 'dashboard', regardless of input.objectType ('note' here) --
    // ADR-0042 Karar (b)/(d).
    expect(byKey.get('artifactType')).toBe('dashboard');
    expect(byKey.get('querySpec')).toBe(JSON.stringify(FAKE_QUERY_SPEC));
  });

  it('returns the final ObjectWithFieldValues from setFieldValues (not the bare shell from create)', async () => {
    const { service } = createHarness({ querySpec: FAKE_QUERY_SPEC, parseError: false });

    const result = await service.generate('workspace-1', ACTOR, 'member', {
      prompt: 'show tasks by status',
      objectType: 'task',
      themePreset: 'kurumsal',
    });

    expect(result.fieldValues).toEqual({ persisted: true });
  });
});
