import { describe, expect, it } from 'vitest';

import { MockEmbeddingProvider } from './mock-embedding-provider.js';

import type { EmbeddingResult } from './embedding-provider.js';

/**
 * Designed signature (must be matched exactly by implementer — F1-T13 PR1,
 * red step; see ADR-0013 §c):
 *
 *   export class MockEmbeddingProvider implements EmbeddingProvider {
 *     embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
 *   }
 *
 * `MockEmbeddingProvider` derives a fixed-dimension, unit-normalized pseudo
 * vector from the request text via a hash. It is the deterministic test double
 * the search-index tests (PR3+) rely on to verify Kabul #2 ("finds
 * semantically-near content phrased with different words") WITHOUT a real
 * embedding vendor. Per the ADR it must be:
 *   - deterministic (same text -> same vector),
 *   - text-sensitive (different text -> different vector),
 *   - fixed-dimensionality (every vector has the same length),
 *   - unit-normalized (L2 norm == 1, to simplify downstream cosine).
 *
 * The fixed dimensionality is pinned here so the implementer has a concrete
 * target; if a different constant is chosen, update this single constant.
 */
const EMBEDDING_DIMENSIONS = 16;

function l2Norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
}

describe('MockEmbeddingProvider — determinism', () => {
  it('returns the SAME vector when the SAME text is embedded twice', async () => {
    const provider = new MockEmbeddingProvider();

    const first = await provider.embed({ text: 'hello world' });
    const second = await provider.embed({ text: 'hello world' });

    expect(first.vector).toEqual(second.vector);
  });

  it('is deterministic across independent provider instances', async () => {
    const a = await new MockEmbeddingProvider().embed({ text: 'context is king' });
    const b = await new MockEmbeddingProvider().embed({ text: 'context is king' });

    expect(a.vector).toEqual(b.vector);
  });
});

describe('MockEmbeddingProvider — text sensitivity (hash-based)', () => {
  it('returns DIFFERENT vectors for DIFFERENT text', async () => {
    const provider = new MockEmbeddingProvider();

    const hello = await provider.embed({ text: 'hello world' });
    const goodbye = await provider.embed({ text: 'goodbye moon' });

    expect(hello.vector).not.toEqual(goodbye.vector);
  });

  it('distinguishes texts that differ by a single character', async () => {
    const provider = new MockEmbeddingProvider();

    const cat = await provider.embed({ text: 'cat' });
    const car = await provider.embed({ text: 'car' });

    expect(cat.vector).not.toEqual(car.vector);
  });
});

describe('MockEmbeddingProvider — fixed dimensionality', () => {
  it('returns a vector of the fixed dimension for a short string', async () => {
    const provider = new MockEmbeddingProvider();

    const result = await provider.embed({ text: 'hi' });

    expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('returns the SAME dimension for a very long string as for a short one', async () => {
    const provider = new MockEmbeddingProvider();

    const short = await provider.embed({ text: 'hi' });
    const long = await provider.embed({
      text: 'the quick brown fox jumps over the lazy dog '.repeat(200),
    });

    expect(short.vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(long.vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(long.vector).toHaveLength(short.vector.length);
  });
});

describe('MockEmbeddingProvider — unit normalization', () => {
  it('returns a vector whose L2 norm is 1', async () => {
    const provider = new MockEmbeddingProvider();

    const result = await provider.embed({ text: 'normalize me' });

    expect(l2Norm(result.vector)).toBeCloseTo(1, 5);
  });

  it('keeps the L2 norm at 1 for a variety of inputs', async () => {
    const provider = new MockEmbeddingProvider();
    const texts = ['alpha', 'a longer piece of text with several words', 'ünïcödé ✨'];

    for (const text of texts) {
      const result = await provider.embed({ text });
      expect(l2Norm(result.vector)).toBeCloseTo(1, 5);
    }
  });
});

describe('MockEmbeddingProvider — empty-string edge case', () => {
  it('does not throw on empty text and still returns a fixed-dimension, unit-normalized vector', async () => {
    const provider = new MockEmbeddingProvider();

    const result: EmbeddingResult = await provider.embed({ text: '' });

    expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(l2Norm(result.vector)).toBeCloseTo(1, 5);
  });
});
