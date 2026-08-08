import { Module } from '@nestjs/common';

import { SearchIndexEmbeddingRefreshService } from './search-index-embedding-refresh.service.js';
import { SearchIndexEmbeddingScheduler } from './search-index-embedding-scheduler.service.js';
import { EmbeddingProviderModule } from '../ai/embedding-provider.module.js';
import { env } from '../config/env.js';
import { DbModule } from '../db/db.module.js';

/**
 * F1-T13 PR4 (ADR-0013 §(e)): provides the `search_index.embedding`
 * recompute scheduler + refresh service so consumers (`ObjectsModule`,
 * `DocsModule`) can inject them without duplicating this wiring.
 */
@Module({
  imports: [DbModule, EmbeddingProviderModule],
  providers: [
    // `SearchIndexEmbeddingScheduler`'s constructor takes a plain `number`
    // (its debounce delay), not an injectable class/token -- Nest's DI cannot
    // resolve a bare `Number` type from constructor-parameter reflection, so
    // this MUST be a factory provider (mirrors `AIRefreshScheduler`'s own
    // `useFactory` in `objects.module.ts`) rather than the bare class in this
    // array. This is also the only place `env.searchIndexEmbeddingDebounceMs`
    // is actually consumed.
    {
      provide: SearchIndexEmbeddingScheduler,
      useFactory: () => new SearchIndexEmbeddingScheduler(env.searchIndexEmbeddingDebounceMs),
    },
    SearchIndexEmbeddingRefreshService,
  ],
  exports: [SearchIndexEmbeddingScheduler, SearchIndexEmbeddingRefreshService],
})
export class SearchIndexModule {}
