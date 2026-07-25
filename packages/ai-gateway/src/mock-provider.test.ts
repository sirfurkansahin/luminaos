import { describe, expect, it } from 'vitest';

import { MockProvider } from './mock-provider.js';

import type { AICompletionRequest, AICompletionResult } from './provider.js';

/**
 * Designed signatures (must be matched exactly by implementer — F1-T5 PR-A,
 * red step):
 *
 *   export class MockProvider implements AIProvider {
 *     constructor(
 *       responder: (request: AICompletionRequest) =>
 *         AICompletionResult | Promise<AICompletionResult>,
 *     );
 *     complete(request: AICompletionRequest): Promise<AICompletionResult>;
 *     static fixed(result: AICompletionResult): MockProvider; // convenience
 *   }
 *
 * `MockProvider` is a thin deterministic pass-through: it calls the supplied
 * `responder` with the request and returns/propagates exactly what the
 * responder returns/throws (sync or async) — no swallowing, no
 * transformation. This is the exact mechanism later tests (retry.ts,
 * AI-field refresh scenarios) rely on to script "fail once, then succeed"
 * sequences via a call-counting closure.
 */

function buildRequest(overrides: Partial<AICompletionRequest> = {}): AICompletionRequest {
  return {
    prompt: 'Summarize: hello world',
    ...overrides,
  };
}

function buildResult(overrides: Partial<AICompletionResult> = {}): AICompletionResult {
  return {
    text: 'a summary',
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
}

describe('MockProvider — synchronous responder', () => {
  it('calls the responder with the request and returns its (sync) result', async () => {
    const seenRequests: AICompletionRequest[] = [];
    const fixedResult = buildResult({ text: 'sync response' });

    const provider = new MockProvider((request) => {
      seenRequests.push(request);
      return fixedResult;
    });

    const request = buildRequest();
    const result = await provider.complete(request);

    expect(seenRequests).toEqual([request]);
    expect(result).toEqual(fixedResult);
  });

  it('propagates a synchronous throw from the responder as a rejection', async () => {
    const provider = new MockProvider(() => {
      throw new Error('boom: synchronous responder failure');
    });

    await expect(provider.complete(buildRequest())).rejects.toThrow(
      'boom: synchronous responder failure',
    );
  });
});

describe('MockProvider — asynchronous responder', () => {
  it('calls the responder and returns its (async) result', async () => {
    const fixedResult = buildResult({ text: 'async response' });

    const provider = new MockProvider(async (request) => {
      await Promise.resolve();
      return { ...fixedResult, text: `${fixedResult.text}:${request.prompt}` };
    });

    const result = await provider.complete(buildRequest({ prompt: 'ping' }));

    expect(result.text).toBe('async response:ping');
  });

  it('propagates an asynchronous rejection from the responder', async () => {
    const provider = new MockProvider(async () => {
      await Promise.resolve();
      throw new Error('boom: asynchronous responder rejection');
    });

    await expect(provider.complete(buildRequest())).rejects.toThrow(
      'boom: asynchronous responder rejection',
    );
  });
});

describe('MockProvider — call-counting responder (fail-then-succeed pattern)', () => {
  it('supports a responder that throws on the first call and succeeds on the second, via a closure counter', async () => {
    let callCount = 0;
    const succeedingResult = buildResult({ text: 'succeeded on attempt 2' });

    const provider = new MockProvider(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('transient failure on first attempt');
      }
      return succeedingResult;
    });

    await expect(provider.complete(buildRequest())).rejects.toThrow(
      'transient failure on first attempt',
    );
    expect(callCount).toBe(1);

    const result = await provider.complete(buildRequest());
    expect(result).toEqual(succeedingResult);
    expect(callCount).toBe(2);
  });
});

describe('MockProvider — fixed-result convenience constructor', () => {
  it('MockProvider.fixed(result) always resolves with that same result, regardless of the request', async () => {
    const fixedResult = buildResult({ text: 'always this' });
    const provider = MockProvider.fixed(fixedResult);

    const resultA = await provider.complete(buildRequest({ prompt: 'first prompt' }));
    const resultB = await provider.complete(
      buildRequest({ prompt: 'a completely different prompt' }),
    );

    expect(resultA).toEqual(fixedResult);
    expect(resultB).toEqual(fixedResult);
  });
});
