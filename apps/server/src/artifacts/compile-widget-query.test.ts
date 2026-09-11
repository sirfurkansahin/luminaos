import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';
import { MAX_WIDGET_TABLE_ROWS } from '@luminaos/artifacts';
import type { FieldDefinition } from '@luminaos/core-objects';

import { compileWidgetQuery } from './compile-widget-query.js';

import type { CompileWidgetQueryResult } from './compile-widget-query.js';

/**
 * F3-T8 PR2 (RED step, ADR-0042 Karar c) — `compileWidgetQuery`, the NEW,
 * DB-free NL->QuerySpec orchestrator: mirrors `parseCommand`'s
 * (`../ai/parse-command.ts`) exact JSON-prompt + zod + 1-retry shape, PLUS a
 * business-rule allowlist layer (`validateCompiledQuerySpec` per the ADR's
 * own sketch) that rejects a schema-VALID-but-semantically-wrong response
 * (wrong `objectType`, a `group` key, or a field key the caller's own role
 * cannot see) exactly like `parseCommand`'s `ALLOWED_PARSE_COMMAND_TYPES`
 * allowlist rejects a schema-valid-but-wrong-`type` action.
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./compile-widget-query.ts` does not exist yet on this branch, so every
 * assertion below is expected to fail with a module-not-found error):
 *
 *   export interface CompileWidgetQueryInput {
 *     provider: AIProvider;
 *     prompt: string;
 *     objectType: ObjectType;
 *     availableFields: FieldDefinition[];
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface CompileWidgetQueryResult {
 *     querySpec: QuerySpec | undefined;
 *     parseError: boolean;
 *     message?: string;
 *   }
 *
 *   export function compileWidgetQuery(
 *     input: CompileWidgetQueryInput,
 *   ): Promise<CompileWidgetQueryResult>;
 *
 * Behavior pinned by the tests below:
 *
 *  a. Happy path: a well-formed `QuerySpec` JSON matching the requested
 *     `objectType`, referencing only `availableFields` keys (or `"title"`),
 *     no `group` -> `{ querySpec, parseError: false }`, `provider.complete`
 *     called once, `recordUsage` called once with the provider's usage.
 *  b. `objectType` mismatch on BOTH attempts -> retried once, then
 *     `{ querySpec: undefined, parseError: true }`.
 *  c. A `group` key present on BOTH attempts (v0 is flat-only, ADR-0042
 *     Karar c/d) -> same retry-then-fail behavior.
 *  d. A filter/sort field referencing a key NOT in `availableFields` and not
 *     `"title"`, on BOTH attempts -> rejected (security-critical allowlist,
 *     mirrors `parseCommand`'s `ALLOWED_PARSE_COMMAND_TYPES` finding) -> same
 *     retry-then-fail behavior.
 *  e. A `limit` EXCEEDING `MAX_WIDGET_TABLE_ROWS` (25) is NOT rejected --
 *     "benign, safely narrowed" per the ADR -- the returned
 *     `querySpec.limit` is clamped down to 25, `provider.complete` called
 *     only ONCE (no retry triggered by this alone).
 *  f. Malformed JSON / schema-invalid response on BOTH attempts -> retried
 *     once, then `parseError: true` with a non-empty `message`.
 *  g. First attempt fails (malformed JSON), second (retry) attempt succeeds
 *     -> returns the retry's result, `provider.complete`/`recordUsage`
 *     called exactly twice.
 *
 * Nothing under test here exists yet: `./compile-widget-query.ts` has not
 * been written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

function statusField(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A well-formed QuerySpec JSON referencing only "status" (an available
 * field) and "title" -- matches the requested objectType, no group. */
function validQuerySpecJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectType: 'task',
    filters: [{ field: 'status', operator: 'equals', value: 'doing' }],
    sort: [{ field: 'title', direction: 'asc' }],
    ...overrides,
  };
}

describe('compileWidgetQuery — happy path (valid, in-allowlist QuerySpec on the first attempt)', () => {
  it('calls provider.complete exactly once, records usage exactly once, and returns { querySpec, parseError: false }', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(validQuerySpecJson()),
        usage: { inputTokens: 40, outputTokens: 12 },
      };
    });
    const { recordUsage } = collectUsage();

    const result: CompileWidgetQueryResult = await compileWidgetQuery({
      provider,
      prompt: 'show tasks by status',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 12 });

    expect(result.parseError).toBe(false);
    expect(result.querySpec).toBeDefined();
    expect(result.querySpec?.objectType).toBe('task');
    expect(result.querySpec?.filters).toEqual([
      { field: 'status', operator: 'equals', value: 'doing' },
    ]);
    expect(result.querySpec?.sort).toEqual([{ field: 'title', direction: 'asc' }]);
    expect(result.querySpec?.group).toBeUndefined();
  });
});

describe('compileWidgetQuery — objectType mismatch is rejected (retry-once-then-fail)', () => {
  it('treats a QuerySpec whose objectType differs from the requested one as a validation failure on both attempts', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(validQuerySpecJson({ objectType: 'note' })),
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show tasks by status',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.querySpec).toBeUndefined();
    expect(result.parseError).toBe(true);
  });
});

describe('compileWidgetQuery — group is forbidden in v0 (flat-only widgets, ADR-0042 Karar c/d)', () => {
  it('treats a QuerySpec containing a "group" key as a validation failure on both attempts', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(validQuerySpecJson({ group: 'status' })),
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show a status breakdown',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.querySpec).toBeUndefined();
    expect(result.parseError).toBe(true);
  });
});

describe('compileWidgetQuery — unknown/hidden field reference is rejected (security-critical allowlist, mirrors parseCommand ALLOWED_PARSE_COMMAND_TYPES)', () => {
  it('treats a filter referencing a field key NOT in availableFields (and not "title") as a validation failure on both attempts, preventing a hallucinated/prompt-injected reference to a hidden or nonexistent field', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(
          validQuerySpecJson({
            filters: [{ field: 'secretSalary', operator: 'equals', value: 100_000 }],
          }),
        ),
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show tasks where secret salary is 100000',
      objectType: 'task',
      // Deliberately does NOT include a "secretSalary" field -- this
      // simulates the field being hidden from the caller's role, or simply
      // hallucinated/not existing at all.
      availableFields: [statusField()],
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.querySpec).toBeUndefined();
    expect(result.parseError).toBe(true);
  });

  it('accepts a filter/sort referencing "title" even though it is not itself a custom FieldDefinition (title lives on the object shell, not fieldValues)', async () => {
    const provider = MockProvider.fixed({
      text: JSON.stringify(
        validQuerySpecJson({
          filters: [{ field: 'title', operator: 'contains', value: 'onboarding' }],
        }),
      ),
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show tasks whose title contains onboarding',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(result.parseError).toBe(false);
    expect(result.querySpec?.filters).toEqual([
      { field: 'title', operator: 'contains', value: 'onboarding' },
    ]);
  });
});

describe('compileWidgetQuery — oversized limit is clamped, NOT rejected (benign, safely narrowed per ADR-0042 Karar h)', () => {
  it('accepts a QuerySpec whose limit exceeds MAX_WIDGET_TABLE_ROWS (25), clamping it down to 25 rather than treating it as a hallucination signal', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(validQuerySpecJson({ limit: 200 })),
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show up to 200 tasks by status',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(result.parseError).toBe(false);
    expect(result.querySpec?.limit).toBe(MAX_WIDGET_TABLE_ROWS);
  });
});

describe('compileWidgetQuery — malformed JSON / schema-invalid response (retry-once-then-fail)', () => {
  it('retries once when the first response is not valid JSON at all, and returns parseError:true with a message when BOTH attempts fail', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: `still not json (attempt ${String(callCount)})`,
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show tasks by status',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(result.querySpec).toBeUndefined();
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });

  it('also retries when the first response is syntactically valid JSON but fails querySpecSchema validation (missing required "filters")', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        const withoutFilters = Object.fromEntries(
          Object.entries(validQuerySpecJson()).filter(([key]) => key !== 'filters'),
        );
        return { text: JSON.stringify(withoutFilters), usage: { inputTokens: 5, outputTokens: 1 } };
      }
      return {
        text: JSON.stringify(validQuerySpecJson()),
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show tasks by status',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.querySpec).toBeDefined();
  });
});

describe('compileWidgetQuery — retry succeeds after a first failed attempt', () => {
  it('returns the retry attempt result when the first attempt is malformed and the second is valid; provider.complete/recordUsage are each called exactly twice, with an IDENTICAL prompt both times', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not json at all', usage: { inputTokens: 8, outputTokens: 1 } }
        : {
            text: JSON.stringify(validQuerySpecJson()),
            usage: { inputTokens: 8, outputTokens: 3 },
          };
    });
    const { recordUsage } = collectUsage();

    const result = await compileWidgetQuery({
      provider,
      prompt: 'show tasks by status',
      objectType: 'task',
      availableFields: [statusField()],
      recordUsage,
    });

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.prompt).toBe(capturedRequests[1]?.prompt);

    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 8, outputTokens: 1 });
    expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 8, outputTokens: 3 });

    expect(result.parseError).toBe(false);
    expect(result.querySpec?.objectType).toBe('task');
  });
});
