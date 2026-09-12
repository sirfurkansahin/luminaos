import { describe, expect, it } from 'vitest';

import { LocalProvider } from './local-provider.js';

import type { AICompletionRequest } from './provider.js';

/**
 * Designed signatures (must be matched exactly by implementer — F3-T12 PR1,
 * red step). Per `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md` Karar (c)
 * and `docs/specs/F3-E5/F3-T12-cihaz-ustu-model-koprusu.md`:
 *
 *   export class LocalProvider implements AIProvider {
 *     complete(request: AICompletionRequest): Promise<AICompletionResult>;
 *   }
 *
 * v0 STUB -- no real on-device inference, no model weights loaded. The
 * single most important regression proof (per the spec's Kabul Kriterleri):
 * the resolved `usage` is ALWAYS `{ inputTokens: 0, outputTokens: 0 }`,
 * completely independent of the input request's contents -- "never does
 * real inference, cost is always zero". We deliberately do NOT assert on the
 * exact literal wording of the fixed `text` (an implementer detail) -- only
 * its type/shape.
 */

function buildRequest(overrides: Partial<AICompletionRequest> = {}): AICompletionRequest {
  return {
    prompt: 'Summarize this ticket in one sentence.',
    ...overrides,
  };
}

describe('LocalProvider — always zero usage, independent of request contents', () => {
  it('resolves with usage {inputTokens: 0, outputTokens: 0} for one request', async () => {
    const provider = new LocalProvider();

    const result = await provider.complete(buildRequest({ prompt: 'first distinct prompt' }));

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('resolves with the SAME zero usage for a completely different request (never real inference, cost always zero)', async () => {
    const provider = new LocalProvider();

    const resultA = await provider.complete(
      buildRequest({ prompt: 'a short prompt', maxTokens: 10 }),
    );
    const resultB = await provider.complete(
      buildRequest({
        prompt:
          'a wildly different, much longer prompt that should have no bearing whatsoever on token usage',
        maxTokens: 4000,
        model: 'some-arbitrary-requested-model',
      }),
    );

    expect(resultA.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(resultB.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('LocalProvider — result shape', () => {
  it('resolves with a non-empty text string', async () => {
    const provider = new LocalProvider();

    const result = await provider.complete(buildRequest());

    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('resolves with a model field present (per AnthropicProvider convention of populating what actually produced the result)', async () => {
    const provider = new LocalProvider();

    const result = await provider.complete(buildRequest());

    expect(typeof result.model).toBe('string');
    expect(result.model?.length).toBeGreaterThan(0);
  });
});
