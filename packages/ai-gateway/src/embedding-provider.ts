/**
 * Provider-agnostic text-embedding contract. This is a SEPARATE contract
 * from `AIProvider` (see `provider.ts`) — it deliberately does not extend or
 * modify it, so `AnthropicProvider` stays untouched and no real embedding
 * vendor choice is presupposed yet (see ADR-0013 §c).
 */

export interface EmbeddingRequest {
  text: string;
}

export interface EmbeddingResult {
  vector: number[];
}

export interface EmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}
