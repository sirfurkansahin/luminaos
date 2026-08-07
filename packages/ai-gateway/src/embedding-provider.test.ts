import { describe, expect, it } from 'vitest';

import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from './embedding-provider.js';

/**
 * Designed signatures (must be matched exactly by implementer — F1-T13 PR1,
 * red step; see ADR-0013 §c). This is a SEPARATE contract from `AIProvider`:
 * it deliberately does NOT extend/modify `provider.ts`, so `AnthropicProvider`
 * is untouched and no real embedding-vendor choice is presupposed.
 *
 *   export interface EmbeddingRequest { text: string; }
 *   export interface EmbeddingResult { vector: number[]; }
 *   export interface EmbeddingProvider {
 *     embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
 *   }
 *
 * The interface itself has no runtime behaviour, so this file only proves the
 * types exist and compose as designed (a compile-time contract smoke test).
 * All behavioural expectations live in `mock-embedding-provider.test.ts`.
 */

describe('EmbeddingProvider contract (type-level smoke test)', () => {
  it('accepts an implementation whose embed() maps an EmbeddingRequest to a Promise<EmbeddingResult>', async () => {
    const request: EmbeddingRequest = { text: 'hello world' };

    // A minimal, inline conforming implementation — proves the interface shape
    // is satisfiable exactly as specified.
    const provider: EmbeddingProvider = {
      async embed(req: EmbeddingRequest): Promise<EmbeddingResult> {
        await Promise.resolve();
        return { vector: [req.text.length] };
      },
    };

    const result: EmbeddingResult = await provider.embed(request);

    expect(result.vector).toEqual([request.text.length]);
  });
});
