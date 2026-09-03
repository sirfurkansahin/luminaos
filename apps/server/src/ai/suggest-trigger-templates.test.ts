import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { suggestTriggerTemplates } from './suggest-trigger-templates.js';

import type {
  SuggestTriggerTemplatesResult,
  TriggerTemplateCandidate,
} from './suggest-trigger-templates.js';
import type { UsagePatternSummary } from './summarize-usage-patterns.js';

/**
 * F2-T17 PR1 (RED step) — `suggestTriggerTemplates`, the THIRD AI-call
 * orchestrator (ADR-0034 Karar (e)), mirroring `parseCommand`'s
 * (`./parse-command.ts`) / `extractMeetingActions`'s (`./extract-meeting-actions.ts`)
 * EXACT retry-once-then-sentinel shape, adjusted for this domain: the model
 * responds with an ENVELOPE object `{ suggestions: [...] }` (NOT a bare
 * array, unlike `parseCommand`) of candidate `{name, rationale, spec}`
 * triples, validated against a zod schema built from `create-trigger.schema.ts`'s
 * (now-exported) `triggerSpecSchema` — never re-written a third time
 * (ADR-0034 Karar (e)).
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./suggest-trigger-templates.ts` does not exist yet on this branch):
 *
 *   export interface SuggestTriggerTemplatesInput {
 *     provider: AIProvider;
 *     summary: UsagePatternSummary;
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface TriggerTemplateCandidate {
 *     suggestionId: string; // minted server-side, NEVER trusted from the model
 *     name: string;
 *     rationale: string;
 *     spec: TriggerSpec;
 *   }
 *
 *   export interface SuggestTriggerTemplatesResult {
 *     suggestions: TriggerTemplateCandidate[];
 *     parseError: boolean;
 *     message?: string;
 *   }
 *
 *   export function suggestTriggerTemplates(
 *     input: SuggestTriggerTemplatesInput,
 *   ): Promise<SuggestTriggerTemplatesResult>;
 *
 * Per ADR-0034 Karar (e), the response schema is (approximately):
 *
 *   const candidateSuggestionSchema = z
 *     .object({ name: z.string().min(1), rationale: z.string().min(1), spec: triggerSpecSchema })
 *     .strict();
 *   const suggestTriggerTemplatesResponseSchema = z
 *     .object({ suggestions: z.array(candidateSuggestionSchema).max(5) })
 *     .strict();
 *
 * Behavior pinned by the tests below:
 *  a. Happy path: valid envelope JSON on the FIRST attempt → `provider.complete`
 *     called exactly once, `recordUsage` called exactly once, returns
 *     `{ suggestions: [...], parseError: false }` with each suggestion
 *     carrying a freshly-minted, UUID-shaped, distinct `suggestionId` (the
 *     model's JSON never includes this field at all, mirroring `parseCommand`'s
 *     `actionId`-minting discipline for `ProposedAction`).
 *  b. Retry-once on a malformed/invalid first response, second succeeds:
 *     `provider.complete` called exactly twice with an IDENTICAL prompt.
 *  c. Double failure -- safe fallback: NEVER throws (asserted via
 *     `await expect(...).resolves.toEqual(...)`, not try/catch). Returns
 *     `{ suggestions: [], parseError: true, message: <non-empty string> }`,
 *     exactly 2 provider calls, exactly 2 `recordUsage` calls.
 *  d. A candidate with `spec.kind` outside `'scheduled'|'condition'`, or one
 *     missing a required field (`name`/`rationale`/`spec`), is a SCHEMA
 *     validation failure -- same retry-then-sentinel path as malformed JSON,
 *     not silently dropped/tolerated.
 *  e. A 6-element `suggestions` array is a HARD schema-validation failure
 *     (`.max(5)`) -- NOT silently truncated to 5. Both attempts returning 6
 *     elements must land on the double-failure sentinel, never a
 *     5-length success result.
 *  f. `recordUsage` is called ONCE PER actual `provider.complete()` call
 *     (twice if it retried), mirroring `parseCommand`'s own convention.
 *
 * Nothing under test here exists yet: `./suggest-trigger-templates.ts` has
 * not been written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

const SAMPLE_SUMMARY: UsagePatternSummary = {
  activeTriggerSummaries: ['Scheduled trigger "Daily digest" fires every 90 minutes'],
  groups: [
    {
      actionType: 'createTask',
      outcome: 'approved',
      count: 5,
      exampleCommands: ['Create a daily standup summary task'],
    },
  ],
};

/** A single, schema-valid `scheduled`-kind candidate, WITHOUT a `suggestionId`
 * field -- per this file's design decision (mirroring `parse-command.test.ts`'s
 * `actionId` convention), the model is never expected to supply one. */
function validScheduledCandidateJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Daily digest scheduler',
    rationale:
      'You approved 5 createTask actions from recurring commands about daily standup summaries',
    spec: {
      kind: 'scheduled',
      intervalMinutes: 90,
      actionTemplate: { title: 'Send daily digest' },
    },
    ...overrides,
  };
}

function validConditionCandidateJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Flag urgent tasks',
    rationale: 'You frequently assign people to tasks whose title mentions "urgent"',
    spec: {
      kind: 'condition',
      objectType: 'task',
      fieldKey: 'title',
      pattern: 'urgent',
      flags: 'i',
      actionTemplate: { title: 'Flag as urgent' },
    },
    ...overrides,
  };
}

describe('suggestTriggerTemplates — happy path (valid envelope JSON on the first attempt)', () => {
  it('calls provider.complete exactly once, records usage exactly once, and returns { suggestions: [...with fresh suggestionIds...], parseError: false }', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify({
          suggestions: [validScheduledCandidateJson(), validConditionCandidateJson()],
        }),
        usage: { inputTokens: 80, outputTokens: 30 },
      };
    });
    const { recordUsage } = collectUsage();

    const result: SuggestTriggerTemplatesResult = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 80, outputTokens: 30 });

    expect(result.parseError).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.suggestions).toHaveLength(2);

    for (const suggestion of result.suggestions) {
      expect(suggestion.suggestionId).toEqual(expect.any(String));
      expect(suggestion.suggestionId.length).toBeGreaterThan(0);
      expect(suggestion.suggestionId).toMatch(UUID_SHAPE);
    }
    const ids = result.suggestions.map(
      (suggestion: TriggerTemplateCandidate) => suggestion.suggestionId,
    );
    expect(new Set(ids).size).toBe(ids.length);

    const [scheduled, condition] = result.suggestions;
    expect(scheduled?.name).toBe('Daily digest scheduler');
    expect(scheduled?.spec).toEqual({
      kind: 'scheduled',
      intervalMinutes: 90,
      actionTemplate: { title: 'Send daily digest' },
    });
    expect(condition?.name).toBe('Flag urgent tasks');
    expect(condition?.spec).toEqual({
      kind: 'condition',
      objectType: 'task',
      fieldKey: 'title',
      pattern: 'urgent',
      flags: 'i',
      actionTemplate: { title: 'Flag as urgent' },
    });
  });
});

describe('suggestTriggerTemplates — retry-once on malformed/invalid envelope JSON', () => {
  it('retries with the IDENTICAL prompt exactly once when the first response is not valid JSON, and returns the successfully-parsed second attempt', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not json at all', usage: { inputTokens: 30, outputTokens: 5 } }
        : {
            text: JSON.stringify({ suggestions: [validScheduledCandidateJson()] }),
            usage: { inputTokens: 30, outputTokens: 8 },
          };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.prompt).toBe(capturedRequests[1]?.prompt);

    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 30, outputTokens: 5 });
    expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 30, outputTokens: 8 });

    expect(result.parseError).toBe(false);
    expect(result.suggestions).toHaveLength(1);
  });

  it('also retries when the first response is schema-invalid because a candidate is missing a required field ("rationale")', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        const withoutRationale = Object.fromEntries(
          Object.entries(validScheduledCandidateJson()).filter(([key]) => key !== 'rationale'),
        );
        return {
          text: JSON.stringify({ suggestions: [withoutRationale] }),
          usage: { inputTokens: 20, outputTokens: 4 },
        };
      }
      return {
        text: JSON.stringify({ suggestions: [validScheduledCandidateJson()] }),
        usage: { inputTokens: 20, outputTokens: 6 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.suggestions).toHaveLength(1);
  });

  it("retries when the first response contains a candidate whose spec.kind is outside the 'scheduled'|'condition' union (e.g. 'deleteEverything') -- a schema violation, not silently accepted", async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            suggestions: [
              validScheduledCandidateJson({
                spec: { kind: 'deleteEverything', foo: 'bar' },
              }),
            ],
          }),
          usage: { inputTokens: 18, outputTokens: 3 },
        };
      }
      return {
        text: JSON.stringify({ suggestions: [validScheduledCandidateJson()] }),
        usage: { inputTokens: 18, outputTokens: 7 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.suggestions).toHaveLength(1);
  });
});

describe('suggestTriggerTemplates — double failure (safe fallback, never throws, no fabricated suggestions)', () => {
  it('resolves (never rejects/throws) to { suggestions: [], parseError: true, message } when BOTH attempts are unparseable, and never attempts a third call', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: `still not json (attempt ${String(callCount)})`,
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const { recordUsage } = collectUsage();

    await expect(
      suggestTriggerTemplates({ provider, summary: SAMPLE_SUMMARY, recordUsage }),
    ).resolves.toEqual({
      suggestions: [],
      parseError: true,
      message: expect.any(String) as string,
    });

    expect(callCount).toBe(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it('resolves to a sentinel with a non-empty message when both attempts are missing a required field ("name")', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      const withoutName = Object.fromEntries(
        Object.entries(validScheduledCandidateJson()).filter(([key]) => key !== 'name'),
      );
      return {
        text: JSON.stringify({ suggestions: [withoutName] }),
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.suggestions).toEqual([]);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });

  it('resolves to a sentinel with a non-empty message when both attempts are missing the required "spec" field entirely', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      const withoutSpec = Object.fromEntries(
        Object.entries(validScheduledCandidateJson()).filter(([key]) => key !== 'spec'),
      );
      return {
        text: JSON.stringify({ suggestions: [withoutSpec] }),
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.suggestions).toEqual([]);
    expect(result.parseError).toBe(true);
  });
});

describe('suggestTriggerTemplates — max-5 cap is a HARD schema-validation failure, never silent truncation', () => {
  it('rejects (via the same retry-then-sentinel path) a 6-element suggestions array on BOTH attempts, landing on the sentinel with an EMPTY suggestions array -- never a silently-truncated 5-length success', async () => {
    let callCount = 0;
    const sixCandidates = Array.from({ length: 6 }, (_, index) =>
      validScheduledCandidateJson({ name: `Candidate ${String(index)}` }),
    );
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify({ suggestions: sixCandidates }),
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.suggestions).toEqual([]);
    expect(result.suggestions).not.toHaveLength(5);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
  });

  it('accepts exactly 5 candidates without error (the boundary just below the rejected 6)', async () => {
    const fiveCandidates = Array.from({ length: 5 }, (_, index) =>
      validScheduledCandidateJson({ name: `Candidate ${String(index)}` }),
    );
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify({ suggestions: fiveCandidates }),
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(result.parseError).toBe(false);
    expect(result.suggestions).toHaveLength(5);
  });
});

describe('suggestTriggerTemplates — model forwarding', () => {
  it('when the caller passes model, provider.complete(...) receives that exact model alongside the rendered prompt', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify({ suggestions: [validScheduledCandidateJson()] }),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      model: 'claude-sonnet-5-20260101',
      recordUsage,
    });

    expect(capturedRequest?.model).toBe('claude-sonnet-5-20260101');
  });

  it('backward compatibility: omitting model still parses correctly and sends no model key (or an undefined one) to provider.complete', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify({ suggestions: [validScheduledCandidateJson()] }),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await suggestTriggerTemplates({
      provider,
      summary: SAMPLE_SUMMARY,
      recordUsage,
    });

    expect(result.parseError).toBe(false);
    expect(capturedRequest?.model).toBeUndefined();
  });
});

describe('suggestTriggerTemplates — never logs summary or candidate content', () => {
  it('does not call console.log/console.error/console.warn while suggesting templates from a summary containing recognizable content', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = MockProvider.fixed({
      text: JSON.stringify({
        suggestions: [validScheduledCandidateJson({ rationale: 'SECRET-RATIONALE-MARKER-22222' })],
      }),
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { recordUsage } = collectUsage();

    await suggestTriggerTemplates({
      provider,
      summary: {
        activeTriggerSummaries: ['SECRET-TRIGGER-SUMMARY-MARKER-11111'],
        groups: [],
      },
      recordUsage,
    });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();

    consoleLog.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});
