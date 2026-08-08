import { Module } from '@nestjs/common';

import { MockEmbeddingProvider } from '@luminaos/ai-gateway';
import type { EmbeddingProvider } from '@luminaos/ai-gateway';

import { EMBEDDING_PROVIDER } from './embedding-provider.token.js';

export { EMBEDDING_PROVIDER };

/**
 * ADR-0013 §(c): a real embedding vendor choice is a deferred future task —
 * identical discipline to F1-T12's `CALENDAR_CONNECTOR` always-Mock factory.
 * This module ALWAYS provides `MockEmbeddingProvider`, with no env branching.
 */
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (): EmbeddingProvider => new MockEmbeddingProvider(),
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingProviderModule {}
