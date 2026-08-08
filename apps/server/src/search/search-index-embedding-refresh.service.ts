import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { EmbeddingProvider } from '@luminaos/ai-gateway';

import { EMBEDDING_PROVIDER } from '../ai/embedding-provider.token.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { searchIndex } from '../db/schema/search-index.js';

import type { Database } from '../db/client.js';

/**
 * F1-T13 PR4 (ADR-0013 §(e)): the piece that actually FILLS
 * `search_index.embedding`, left `NULL` by PR3a/PR3b. Called by
 * `SearchIndexEmbeddingScheduler` after its debounce window elapses.
 */
@Injectable()
export class SearchIndexEmbeddingRefreshService {
  private readonly logger = new Logger(SearchIndexEmbeddingRefreshService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async refreshEmbedding(objectId: string): Promise<void> {
    const [row] = await this.db
      .select({ title: searchIndex.title, docText: searchIndex.docText })
      .from(searchIndex)
      .where(eq(searchIndex.objectId, objectId))
      .limit(1);

    if (!row) {
      // A race — e.g. the object was deleted between `schedule()` and the
      // timer firing — must be a silent no-op, never a throw.
      this.logger.warn(
        'Skipped a scheduled search index embedding refresh: no matching search_index row.',
      );
      return;
    }

    const combinedText = [row.title, row.docText]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ');

    const { vector } = await this.embeddingProvider.embed({ text: combinedText });

    await this.db
      .update(searchIndex)
      .set({ embedding: vector })
      .where(eq(searchIndex.objectId, objectId));
  }
}
