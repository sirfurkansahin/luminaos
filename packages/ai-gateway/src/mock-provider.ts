import type { AICompletionRequest, AICompletionResult, AIProvider } from './provider.js';

export type MockResponder = (
  request: AICompletionRequest,
) => AICompletionResult | Promise<AICompletionResult>;

/**
 * A thin, deterministic test double for `AIProvider`. It calls the supplied
 * `responder` with the request and returns/propagates exactly what the
 * responder returns/throws (sync or async) — no swallowing, no
 * transformation. This is the mechanism scenario tests use to script
 * "fail once, then succeed" sequences via a call-counting closure.
 */
export class MockProvider implements AIProvider {
  constructor(private readonly responder: MockResponder) {}

  async complete(request: AICompletionRequest): Promise<AICompletionResult> {
    return this.responder(request);
  }

  static fixed(result: AICompletionResult): MockProvider {
    return new MockProvider(() => result);
  }
}
