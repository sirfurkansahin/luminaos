/**
 * Provider-agnostic AI completion contract. All concrete providers (mock,
 * Anthropic, ...) implement this interface so callers never depend on a
 * specific vendor SDK — see CLAUDE.md: "AI çağrıları yalnızca
 * packages/ai-gateway üzerinden; sağlayıcı SDK'sını doğrudan import etme."
 */

export interface AICompletionRequest {
  prompt: string;
  maxTokens?: number;
}

export interface AITokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AICompletionResult {
  text: string;
  usage: AITokenUsage;
}

export interface AIProvider {
  complete(request: AICompletionRequest): Promise<AICompletionResult>;
}
