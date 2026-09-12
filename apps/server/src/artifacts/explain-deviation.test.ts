import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';
import type { DeviationResult } from '@luminaos/artifacts';

import { explainDeviation } from './explain-deviation.js';

import type { ExplainDeviationResult } from './explain-deviation.js';

/**
 * F3-T11 PR1 (RED step), ADR-0045 Karar (b)/(c) — `explainDeviation`, the
 * NEW, DB-free "explain a captured-vs-current metric deviation" orchestrator:
 * mirrors `compileWidgetQuery`'s (`./compile-widget-query.ts`) exact
 * JSON-prompt + zod + 1-retry shape, but with NO allowlist layer (like
 * `generateArtifact`) -- the only "validation" here is
 * `deviationExplanationSchema.safeParse`.
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./explain-deviation.ts` does not exist yet on this branch, so every
 * assertion below is expected to fail with a module-not-found error):
 *
 *   export interface ExplainDeviationInput {
 *     provider: AIProvider;
 *     objectType: ObjectType;
 *     aggregateFn: AggregateFn;
 *     targetFieldKey?: string;
 *     capturedValue: number;
 *     currentValue: number;
 *     deviation: DeviationResult;
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface ExplainDeviationResult {
 *     content: DeviationExplanationContent | undefined;
 *     parseError: boolean;
 *     message?: string;
 *   }
 *
 *   export function explainDeviation(
 *     input: ExplainDeviationInput,
 *   ): Promise<ExplainDeviationResult>;
 *
 * Behavior pinned by the tests below (ADR-0045 Karar b/c):
 *
 *  a. Happy path: a well-formed `{summary, possibleCauses}` JSON on the FIRST
 *     attempt -> `{content, parseError: false}`, `provider.complete` called
 *     exactly once, `recordUsage` called exactly once with the provider's
 *     usage.
 *  b. Malformed JSON on the first attempt, valid JSON on the retry -> returns
 *     the RETRY's result; `provider.complete`/`recordUsage` called exactly
 *     twice.
 *  c. Schema-invalid JSON on BOTH attempts (missing `possibleCauses`, or an
 *     empty `possibleCauses` array) -> `{content: undefined, parseError:
 *     true, message: <non-empty string>}`, `provider.complete` called
 *     exactly twice (never a third time).
 *  d. Security/correctness-critical regression test (Human Decision 2, ADR-
 *     0045 Karar c/i): the rendered prompt is built ONLY from
 *     `objectType`/`aggregateFn`/`targetFieldKey`/`capturedValue`/
 *     `currentValue`/`deviation.delta`/`deviation.percentChange`/
 *     `deviation.direction` -- NO other data source exists in the function's
 *     own signature to leak from.
 *  e. `deviation.percentChange === null` (baseline value was zero) -> the
 *     rendered prompt contains the ADR's own exact phrase, 'not computable
 *     (baseline value was zero)', and never contains the literal strings
 *     "Infinity", "NaN", or "null".
 *  f. `input.model` is passed through to `provider.complete({prompt, model})`
 *     when provided, and omitted from the call when `input.model` is
 *     `undefined` (mirrors `compileWidgetQuery`'s own exact
 *     `...(input.model !== undefined ? {model: input.model} : {})`
 *     conditional-spread convention).
 *
 * Nothing under test here exists yet: `./explain-deviation.ts` has not been
 * written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

function unchangedDeviation(overrides: Partial<DeviationResult> = {}): DeviationResult {
  return { delta: 0, percentChange: 0, direction: 'unchanged', ...overrides };
}

const validExplanationJson = {
  summary: 'The metric increased slightly over the tracked period.',
  possibleCauses: ['Seasonal demand increase', 'A recent process change'],
};

describe('explainDeviation — happy path (valid JSON on the first attempt)', () => {
  it('calls provider.complete exactly once, records usage exactly once, and returns { content, parseError: false }', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(validExplanationJson),
        usage: { inputTokens: 30, outputTokens: 10 },
      };
    });
    const { recordUsage } = collectUsage();

    const result: ExplainDeviationResult = await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'sum',
      targetFieldKey: 'estimatedDuration',
      capturedValue: 100,
      currentValue: 120,
      deviation: { delta: 20, percentChange: 20, direction: 'up' },
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 30, outputTokens: 10 });

    expect(result.parseError).toBe(false);
    expect(result.content).toEqual(validExplanationJson);
  });
});

describe('explainDeviation — retry succeeds after a first malformed attempt', () => {
  it('returns the retry attempt result when the first attempt is not valid JSON and the second is valid; provider.complete/recordUsage each called exactly twice, with an IDENTICAL prompt both times', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not json at all', usage: { inputTokens: 8, outputTokens: 1 } }
        : {
            text: JSON.stringify(validExplanationJson),
            usage: { inputTokens: 8, outputTokens: 3 },
          };
    });
    const { recordUsage } = collectUsage();

    const result = await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'count',
      capturedValue: 10,
      currentValue: 5,
      deviation: { delta: -5, percentChange: -50, direction: 'down' },
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.prompt).toBe(capturedRequests[1]?.prompt);

    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 8, outputTokens: 1 });
    expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 8, outputTokens: 3 });

    expect(result.parseError).toBe(false);
    expect(result.content).toEqual(validExplanationJson);
  });
});

describe('explainDeviation — schema-invalid response on both attempts (retry-once-then-fail)', () => {
  it('retries once when the first response is not valid JSON at all, and returns parseError:true with a non-empty message when BOTH attempts fail', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: `still not json (attempt ${String(callCount)})`,
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'avg',
      targetFieldKey: 'estimatedDuration',
      capturedValue: 4,
      currentValue: 6,
      deviation: { delta: 2, percentChange: 50, direction: 'up' },
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(result.content).toBeUndefined();
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });

  it('also retries when "possibleCauses" is an empty array on both attempts (schema-valid-shape but business-invalid per min(1))', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify({ summary: 'A summary with no causes.', possibleCauses: [] }),
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'sum',
      targetFieldKey: 'estimatedDuration',
      capturedValue: 100,
      currentValue: 90,
      deviation: { delta: -10, percentChange: -10, direction: 'down' },
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.content).toBeUndefined();
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });

  it('also retries when the first response is missing the required "possibleCauses" key entirely', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({ summary: 'A summary with no causes key.' }),
          usage: { inputTokens: 5, outputTokens: 1 },
        };
      }
      return {
        text: JSON.stringify(validExplanationJson),
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'sum',
      targetFieldKey: 'estimatedDuration',
      capturedValue: 100,
      currentValue: 90,
      deviation: { delta: -10, percentChange: -10, direction: 'down' },
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.content).toEqual(validExplanationJson);
  });
});

describe('explainDeviation — prompt content is built ONLY from the documented aggregate/metadata inputs (Human Decision 2 regression, ADR-0045 Karar c/i)', () => {
  it('includes the literal targetFieldKey value as the referenced field key, and reflects only objectType/aggregateFn/targetFieldKey/capturedValue/currentValue/deviation fields -- there is no other data source in the function signature for row-level content (title/description/fieldValues) to leak from', async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedPrompt = request.prompt;
      return {
        text: JSON.stringify(validExplanationJson),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'avg',
      targetFieldKey: 'secretFieldXYZ',
      capturedValue: 42,
      currentValue: 84,
      deviation: { delta: 42, percentChange: 100, direction: 'up' },
      recordUsage,
    });

    // The field KEY is legitimately referenced in the prompt as metadata.
    expect(capturedPrompt).toContain('secretFieldXYZ');

    // Structural check: every numeric/enum value actually supplied is
    // reflected somewhere in the prompt text -- the function has NO other
    // data source (no title/description/fieldValues param exists at all in
    // ExplainDeviationInput), so this is the strongest available proof that
    // nothing beyond the documented aggregate/metadata envelope was used.
    expect(capturedPrompt).toContain('task');
    expect(capturedPrompt).toContain('avg');
    expect(capturedPrompt).toContain('42');
    expect(capturedPrompt).toContain('84');
    expect(capturedPrompt).toContain('100');
    expect(capturedPrompt).toContain('up');
  });
});

describe('explainDeviation — percentChange: null renders a human-readable "not computable" phrase, never Infinity/NaN/null', () => {
  it('renders the ADR-0045-specified exact phrase and omits the literal strings "Infinity"/"NaN"/"null"', async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedPrompt = request.prompt;
      return {
        text: JSON.stringify(validExplanationJson),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'sum',
      targetFieldKey: 'estimatedDuration',
      capturedValue: 0,
      currentValue: 50,
      deviation: { delta: 50, percentChange: null, direction: 'up' },
      recordUsage,
    });

    expect(capturedPrompt).toContain('not computable (baseline value was zero)');
    expect(capturedPrompt).not.toContain('Infinity');
    expect(capturedPrompt).not.toContain('NaN');
    expect(capturedPrompt).not.toContain('null');
  });
});

describe("explainDeviation — model pass-through (mirrors compileWidgetQuery's conditional-spread convention)", () => {
  it('passes input.model through to provider.complete({prompt, model}) when provided', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      return {
        text: JSON.stringify(validExplanationJson),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'sum',
      targetFieldKey: 'estimatedDuration',
      capturedValue: 10,
      currentValue: 10,
      deviation: unchangedDeviation(),
      model: 'claude-sonnet-5',
      recordUsage,
    });

    expect(capturedRequests[0]?.model).toBe('claude-sonnet-5');
  });

  it('omits "model" from the provider.complete call when input.model is undefined', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      return {
        text: JSON.stringify(validExplanationJson),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const { recordUsage } = collectUsage();

    await explainDeviation({
      provider,
      objectType: 'task',
      aggregateFn: 'sum',
      targetFieldKey: 'estimatedDuration',
      capturedValue: 10,
      currentValue: 10,
      deviation: unchangedDeviation(),
      recordUsage,
    });

    expect(capturedRequests[0] && 'model' in capturedRequests[0]).toBe(false);
  });
});
