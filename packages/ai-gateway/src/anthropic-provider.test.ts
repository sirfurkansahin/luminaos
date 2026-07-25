import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from './anthropic-provider.js';

import type { AICompletionRequest } from './provider.js';

/**
 * Designed signatures (must be matched exactly by implementer — F1-T5 PR-A,
 * red step):
 *
 *   export interface AnthropicProviderOptions {
 *     apiKey: string;
 *     model?: string; // no existing model-name string found anywhere in
 *       // this repo (searched for "claude"/"anthropic" case-insensitively);
 *       // implementer picks a clearly-labeled placeholder default, e.g.
 *       // `DEFAULT_ANTHROPIC_MODEL = 'claude-placeholder-model'`, and
 *       // documents it as a placeholder pending a real
 *       // models/pricing reference doc.
 *     }
 *   export class AnthropicProvider implements AIProvider {
 *     constructor(options: AnthropicProviderOptions, client?: AnthropicClientLike);
 *     complete(request: AICompletionRequest): Promise<AICompletionResult>;
 *   }
 *
 * ASSUMED SDK SHAPE (`@anthropic-ai/sdk` is not installed anywhere in this
 * repo yet, so this cannot be verified against the real package — implementer
 * MUST re-check this against the actually-installed SDK version and adjust
 * both this test file and `anthropic-provider.ts` if the real shape differs):
 *
 *   client.messages.create({
 *     model: string,
 *     max_tokens: number,
 *     messages: [{ role: 'user', content: string }],
 *   }) => Promise<{
 *     content: [{ type: 'text', text: string }],
 *     usage: { input_tokens: number, output_tokens: number },
 *   }>
 *
 * The API key is passed as a constructor parameter, never read from
 * `process.env` inside this class (mirrors `apps/server/src/db/client.ts`'s
 * `createDatabaseClient(connectionString)` convention — env-reading is the
 * caller's job). The underlying SDK client is injectable (second
 * constructor parameter) so tests never touch the real network/SDK.
 *
 * `complete()` must wrap its call to the injected client in `withRetry`
 * (`./retry.ts`) per the "max 2 deneme" acceptance criterion — proven below
 * by a client whose `messages.create` rejects once then succeeds.
 *
 * Non-retryable-error distinction: this design has no way (without
 * installing the real SDK and inspecting its actual error classes/status
 * codes) to verify how Anthropic's SDK distinguishes a retryable transient
 * error from a non-retryable one (e.g. 401/invalid-API-key vs. 529
 * overloaded). Per the task's guidance, we do NOT guess at SDK internals we
 * cannot verify — `AnthropicProvider` is assumed, for this red step, to
 * retry everything via `withRetry`'s default `isRetryable` (retry
 * everything), and no test pins a non-retryable-error fast path. A later
 * step should revisit this once the real SDK is installed and its error
 * shapes can be inspected directly.
 */

interface FakeAnthropicMessage {
  content: { type: string; text: string }[];
  usage: { input_tokens: number; output_tokens: number };
}

interface FakeAnthropicClient {
  messages: {
    create: (params: {
      model: string;
      max_tokens?: number;
      messages: { role: string; content: string }[];
    }) => Promise<FakeAnthropicMessage>;
  };
}

function buildRequest(overrides: Partial<AICompletionRequest> = {}): AICompletionRequest {
  return {
    prompt: 'Summarize this ticket in one sentence.',
    ...overrides,
  };
}

function fixedClient(message: FakeAnthropicMessage): {
  client: FakeAnthropicClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => {
    await Promise.resolve();
    return message;
  });
  return { client: { messages: { create } }, create };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AnthropicProvider — request shape', () => {
  it('calls the injected client.messages.create with the model, prompt as a user message, and max_tokens', async () => {
    const { client, create } = fixedClient({
      content: [{ type: 'text', text: 'a summary' }],
      usage: { input_tokens: 12, output_tokens: 4 },
    });

    const provider = new AnthropicProvider({ apiKey: 'test-api-key', model: 'test-model' }, client);

    await provider.complete(buildRequest({ prompt: 'summarize X', maxTokens: 256 }));

    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]?.[0] as {
      model: string;
      max_tokens?: number;
      messages: { role: string; content: string }[];
    };

    expect(callArgs.model).toBe('test-model');
    expect(callArgs.max_tokens).toBe(256);
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'summarize X' }]);
  });

  it('never reads process.env itself — the API key must come only from the constructor options', async () => {
    const { client } = fixedClient({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    // No ANTHROPIC_API_KEY is set in this test's environment; the provider
    // must still work purely off the injected `apiKey` option.
    delete process.env.ANTHROPIC_API_KEY;

    const provider = new AnthropicProvider({ apiKey: 'explicit-key' }, client);

    await expect(provider.complete(buildRequest())).resolves.toEqual({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });
});

describe('AnthropicProvider — response mapping', () => {
  it('maps the SDK response shape to { text, usage: { inputTokens, outputTokens } }', async () => {
    const { client } = fixedClient({
      content: [{ type: 'text', text: 'the mapped completion text' }],
      usage: { input_tokens: 42, output_tokens: 7 },
    });

    const provider = new AnthropicProvider({ apiKey: 'k' }, client);

    const result = await provider.complete(buildRequest());

    expect(result).toEqual({
      text: 'the mapped completion text',
      usage: { inputTokens: 42, outputTokens: 7 },
    });
  });
});

describe('AnthropicProvider — retry (max 2 deneme)', () => {
  it('wraps the client call in withRetry: a first rejection followed by a success still resolves complete()', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const create = vi.fn(async () => {
      await Promise.resolve();
      callCount += 1;
      if (callCount === 1) {
        throw new Error('transient overload error');
      }
      return {
        content: [{ type: 'text', text: 'succeeded on retry' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      };
    });
    const client: FakeAnthropicClient = { messages: { create } };

    const provider = new AnthropicProvider({ apiKey: 'k' }, client);

    const promise = provider.complete(buildRequest());
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;

    expect(result.text).toBe('succeeded on retry');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('propagates the final error when both attempts fail, calling the client exactly 2 times (not more)', async () => {
    vi.useFakeTimers();

    const create = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('persistent overload error');
    });
    const client: FakeAnthropicClient = { messages: { create } };

    const provider = new AnthropicProvider({ apiKey: 'k' }, client);

    const promise = provider.complete(buildRequest());
    const settled = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).rejects.toThrow('persistent overload error');
    await settled;
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('AnthropicProvider — never logs prompt or completion text', () => {
  it('does not call console.log/console.error/console.warn while completing a request containing a recognizable prompt', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { client } = fixedClient({
      content: [{ type: 'text', text: 'SECRET-COMPLETION-MARKER-98765' }],
      usage: { input_tokens: 3, output_tokens: 3 },
    });

    const provider = new AnthropicProvider({ apiKey: 'k' }, client);

    await provider.complete(buildRequest({ prompt: 'SECRET-PROMPT-MARKER-12345' }));

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
