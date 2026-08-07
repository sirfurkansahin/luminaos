import { createHash } from 'node:crypto';

import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from './embedding-provider.js';

export const EMBEDDING_DIMENSIONS = 16;

const INT32_RANGE = 2 ** 31;

function dimensionValue(text: string, dimension: number): number {
  const digest = createHash('sha256').update(text).update(String(dimension)).digest();
  return digest.readInt32BE(0) / INT32_RANGE;
}

function l2Norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

/**
 * Deterministic test double for `EmbeddingProvider` (see ADR-0013 §c). Each
 * dimension is derived from an independent SHA-256 digest of the text salted
 * with the dimension index, so the vector is a pure, text-sensitive function
 * of the input rather than a length- or randomness-based stand-in. The
 * fallback unit vector guards a norm of exactly zero, which is
 * cryptographically implausible but would otherwise divide by zero (e.g. if
 * every digest happened to read as INT32_MIN across all dimensions).
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    await Promise.resolve();

    const raw = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, dimension) =>
      dimensionValue(request.text, dimension),
    );

    const norm = l2Norm(raw);
    if (norm === 0) {
      const fallback = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) =>
        index === 0 ? 1 : 0,
      );
      return { vector: fallback };
    }

    return { vector: raw.map((value) => value / norm) };
  }
}
