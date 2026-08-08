/**
 * Provider-agnostic AI completion contract. All concrete providers (mock,
 * Anthropic, ...) implement this interface so callers never depend on a
 * specific vendor SDK — see CLAUDE.md: "AI çağrıları yalnızca
 * packages/ai-gateway üzerinden; sağlayıcı SDK'sını doğrudan import etme."
 */

export interface AICompletionRequest {
  prompt: string;
  maxTokens?: number;
  model?: string;
}

export interface AITokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AICompletionResult {
  text: string;
  usage: AITokenUsage;
  /**
   * The model that actually produced this result, when the provider knows it
   * (e.g. `AnthropicProvider` always reports the exact string it sent to the
   * SDK — `request.model ?? this.model`). Optional so `MockProvider`/existing
   * fixtures aren't forced to supply it. A caller computing cost from `usage`
   * should still prefer whatever model value IT explicitly requested (if any)
   * over re-deriving it from this field — this exists as a single source of
   * truth for callers that omitted `request.model` and need to know after the
   * fact what was actually billed, not as the primary channel.
   */
  model?: string;
}

export interface AIProvider {
  complete(request: AICompletionRequest): Promise<AICompletionResult>;
}
