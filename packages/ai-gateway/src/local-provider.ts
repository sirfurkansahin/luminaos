import type { AICompletionRequest, AICompletionResult, AIProvider } from './provider.js';

const LOCAL_PROVIDER_MODEL = 'local-stub-v0';
const LOCAL_PROVIDER_TEXT =
  'On-device inference is not yet available in this build. This is a stub response.';

/**
 * v0 STUB local provider — see `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md`
 * Karar (c). There is no real on-device inference and no model weights are
 * loaded here yet; the point of this class is purely routing: requests
 * classified as tier0/tier1/tier2 (see `routing-policy.ts`) resolve to this
 * provider instead of a cloud vendor. The resolved `usage` is ALWAYS
 * `{ inputTokens: 0, outputTokens: 0 }`, completely independent of the
 * request's contents — cost is always zero because no real inference runs.
 */
export class LocalProvider implements AIProvider {
  complete(request: AICompletionRequest): Promise<AICompletionResult> {
    void request;
    return Promise.resolve({
      text: LOCAL_PROVIDER_TEXT,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: LOCAL_PROVIDER_MODEL,
    });
  }
}
