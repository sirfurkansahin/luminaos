import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '@luminaos/ai-gateway';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { searchIndex } from '../db/schema/search-index.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { SearchIndexEmbeddingRefreshService as SearchIndexEmbeddingRefreshServiceType } from './search-index-embedding-refresh.service.js';
import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';

/**
 * F1-T13 PR4 (RED step) — ADR-0013 §(e) follow-through: `SearchIndexEmbeddingRefreshService`,
 * the piece that actually FILLS `search_index.embedding` (left `NULL` by
 * PR3a/PR3b). This tests it DIRECTLY, bypassing `SearchIndexEmbeddingScheduler`'s
 * debounce/timer entirely — `refreshEmbedding(objectId)` is called straight, no
 * need to wait for any debounce window.
 *
 * Neither `./search-index-embedding-refresh.service.ts` NOR
 * `../ai/embedding-provider.token.ts`/`../ai/embedding-provider.module.ts`
 * exists yet, so every `it` below fails at import time (module not found) —
 * the correct RED state.
 *
 * LIGHTER HARNESS than this directory's sibling
 * `search-index.projection.integration.test.ts`: this service needs ONLY a
 * real Postgres (via Testcontainers) + `DbModule` + the new
 * `EmbeddingProviderModule` — no Redis, no full `AppModule`/HTTP boot, no
 * event store. `REDIS_URL` is still set to a harmless placeholder purely
 * because `../config/env.ts`'s already-evaluated singleton fails fast
 * (`process.exit(1)`) at import time if it's absent — nothing in this file's
 * module graph ever actually connects to it.
 *
 * A `search_index` row is inserted DIRECTLY via the raw Drizzle client
 * (bypassing `SearchIndexProjection` entirely, and a real `workspaces` row is
 * inserted first to satisfy `search_index.workspace_id`'s FK) — this file is
 * about `refreshEmbedding` in isolation, not about how a row gets there in
 * production.
 *
 * ============================================================================
 * CONTRACT PINNED HERE (implementer must match precisely):
 *
 *   // ../ai/embedding-provider.token.ts
 *   export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';
 *
 *   // ../ai/embedding-provider.module.ts (ADR-0013 §(c) — ALWAYS mock, no env
 *   // branching, identical discipline to F1-T12's CALENDAR_CONNECTOR
 *   // always-Mock factory; a real embedding vendor is a deferred future task)
 *   @Module({
 *     providers: [{ provide: EMBEDDING_PROVIDER, useFactory: () => new MockEmbeddingProvider() }],
 *     exports: [EMBEDDING_PROVIDER],
 *   })
 *   export class EmbeddingProviderModule {}
 *
 *   // ./search-index-embedding-refresh.service.ts
 *   @Injectable()
 *   export class SearchIndexEmbeddingRefreshService {
 *     constructor(
 *       @Inject(DATABASE_CONNECTION) db: Database,
 *       @Inject(EMBEDDING_PROVIDER) embeddingProvider: EmbeddingProvider,
 *     );
 *
 *     async refreshEmbedding(objectId: string): Promise<void> {
 *       // 1. SELECT title, doc_text FROM search_index WHERE object_id = objectId.
 *       // 2. No row found -> log a warning (static message only) and return
 *       //    WITHOUT throwing (a race — e.g. the object was deleted between
 *       //    schedule() and the timer firing — must be a silent no-op).
 *       // 3. combinedText = [title, docText].filter((s): s is string =>
 *       //    typeof s === 'string' && s.length > 0).join(' ').
 *       // 4. const { vector } = await embeddingProvider.embed({ text: combinedText });
 *       // 5. UPDATE search_index SET embedding = vector WHERE object_id = objectId.
 *     }
 *   }
 * ============================================================================
 */

let objectCounter = 0;

/** Distinct ULID-shaped (26-char Crockford base32) object ids, one per test. */
function freshObjectId(): string {
  objectCounter += 1;
  return `01ARZ3NDEKTSV4RRFFQ69G${String(objectCounter).padStart(4, '0')}`;
}

describe('F1-T13 PR4 (RED step): SearchIndexEmbeddingRefreshService.refreshEmbedding (real Postgres, via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let rawDb: Database;
  let service: SearchIndexEmbeddingRefreshServiceType;
  let workspaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    // Never actually connected to -- see header doc comment.
    process.env.REDIS_URL = 'redis://unit-test-placeholder:6379';

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the established
    // convention in every other integration test file here (`env.ts`'s
    // already-evaluated singleton is read the moment anything in this
    // dependency graph first imports it).
    const { DbModule } = await import('../db/db.module.js');
    const { EmbeddingProviderModule } = await import('../ai/embedding-provider.module.js');
    const { SearchIndexEmbeddingRefreshService } =
      await import('./search-index-embedding-refresh.service.js');

    const moduleRef = await Test.createTestingModule({
      imports: [DbModule, EmbeddingProviderModule],
      providers: [SearchIndexEmbeddingRefreshService],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    service = app.get(SearchIndexEmbeddingRefreshService);
    rawDb = createDatabaseClient(container.getConnectionUri());

    const [workspace] = await rawDb
      .insert(workspaces)
      .values({
        name: 'Search index embedding refresh test workspace',
        slug: `search-index-embedding-refresh-test-${crypto.randomUUID()}`,
      })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error('failed to seed a workspace row for this test file');
    }
    workspaceId = workspace.id;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
  }, 60_000);

  async function insertSearchIndexRow(input: {
    objectId: string;
    title: string;
    docText: string | null;
  }): Promise<void> {
    await rawDb.insert(searchIndex).values({
      objectId: input.objectId,
      workspaceId,
      title: input.title,
      docText: input.docText,
      tsv: sql`to_tsvector('simple', ${input.title})`,
      embedding: null,
      updatedAt: new Date(),
    });
  }

  async function getEmbedding(objectId: string): Promise<number[] | null> {
    const [row] = await rawDb
      .select({ embedding: searchIndex.embedding })
      .from(searchIndex)
      .where(eq(searchIndex.objectId, objectId))
      .limit(1);

    return row?.embedding ?? null;
  }

  describe('AC1: combines title + doc_text into one embedding call, deterministic across repeated calls', () => {
    it('writes a non-null EMBEDDING_DIMENSIONS-length vector, unchanged on a second call against the same unchanged row', async () => {
      const objectId = freshObjectId();
      await insertSearchIndexRow({
        objectId,
        title: 'Quarterly Plan',
        docText: 'roadmap discussion',
      });

      await service.refreshEmbedding(objectId);

      const firstEmbedding = await getEmbedding(objectId);
      expect(firstEmbedding).not.toBeNull();
      expect(firstEmbedding).toHaveLength(EMBEDDING_DIMENSIONS);

      await service.refreshEmbedding(objectId);

      const secondEmbedding = await getEmbedding(objectId);
      expect(secondEmbedding).toEqual(firstEmbedding);
    });
  });

  describe('AC2: different combined text produces a different embedding', () => {
    it('two rows with different title/docText end up with different embeddings', async () => {
      const objectIdOne = freshObjectId();
      await insertSearchIndexRow({
        objectId: objectIdOne,
        title: 'Quarterly Plan',
        docText: 'roadmap discussion',
      });
      await service.refreshEmbedding(objectIdOne);
      const embeddingOne = await getEmbedding(objectIdOne);

      const objectIdTwo = freshObjectId();
      await insertSearchIndexRow({
        objectId: objectIdTwo,
        title: 'Completely Unrelated Subject',
        docText: 'lorem ipsum dolor sit amet',
      });
      await service.refreshEmbedding(objectIdTwo);
      const embeddingTwo = await getEmbedding(objectIdTwo);

      expect(embeddingOne).not.toBeNull();
      expect(embeddingTwo).not.toBeNull();
      expect(embeddingTwo).not.toEqual(embeddingOne);
    });
  });

  describe('AC3: doc_text is null (title-only object, e.g. a task not a doc)', () => {
    it('does not throw, and still writes a valid title-only-derived embedding', async () => {
      const objectId = freshObjectId();
      await insertSearchIndexRow({
        objectId,
        title: 'Title-only task with no document body',
        docText: null,
      });

      await expect(service.refreshEmbedding(objectId)).resolves.toBeUndefined();

      const embedding = await getEmbedding(objectId);
      expect(embedding).not.toBeNull();
      expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    });
  });

  describe('AC4: an orphan objectId (no matching search_index row) is a silent no-op', () => {
    it('resolves (does not reject/throw) when called for an objectId with no row at all', async () => {
      const orphanObjectId = freshObjectId();

      await expect(service.refreshEmbedding(orphanObjectId)).resolves.toBeUndefined();
    });
  });
});
