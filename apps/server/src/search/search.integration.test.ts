import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EmbeddingProvider } from '@luminaos/ai-gateway';

import { EMBEDDING_PROVIDER } from '../ai/embedding-provider.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { searchIndex } from '../db/schema/search-index.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T13 PR5 (RED step) — ADR-0013 §(b)/(f) "Aday seçimi" + "Query-time RBAC".
 * End-to-end HTTP proof of the NOT-YET-IMPLEMENTED
 * `POST /workspaces/:workspaceId/search` route.
 *
 * Mirrors this directory's sibling Testcontainers harness EXACTLY
 * (`search-index.projection.integration.test.ts`/
 * `search-index-embedding-wiring.integration.test.ts`): `postgres:16` +
 * `redis:7`, `runMigrations`, dynamic `import('../app.module.js')` AFTER
 * `DATABASE_URL`/`REDIS_URL` are set, `app.get(...)` for DI resolution,
 * `supertest` over the real HTTP server.
 *
 * Nothing under test here exists yet — `implementer` must create, at exactly
 * these paths (so the route this file hits actually resolves; no other names
 * are acceptable):
 *
 *   - `./dto/search-workspace.schema.ts`
 *       export const MAX_QUERY_LENGTH = 200;
 *       export const MAX_LIMIT = 50;
 *       export const DEFAULT_LIMIT = 10;
 *       export const searchWorkspaceSchema = z.object({
 *         query: z.string().min(1).max(MAX_QUERY_LENGTH),
 *         limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
 *       }).strict();
 *       export type SearchWorkspaceInput = z.infer<typeof searchWorkspaceSchema>;
 *       (mirrors `../calendar/dto/list-conflicts.schema.ts`'s exact
 *       DoS-cap-via-validation-REJECTION convention — `limit` beyond
 *       `MAX_LIMIT` must be a 400, never silently clamped.)
 *
 *   - `./search.service.ts`
 *       export class SearchService {
 *         constructor(
 *           @Inject(DATABASE_CONNECTION) db: Database,
 *           @Inject(EMBEDDING_PROVIDER) embeddingProvider: EmbeddingProvider,
 *         );
 *         async search(
 *           workspaceId: string,
 *           input: { query: string; limit?: number },
 *         ): Promise<{ results: Array<{ objectId: string; title: string; type: string; score: number }> }>;
 *       }
 *       Candidate pool = UNION of:
 *         (a) top-N (config const, e.g. 50) by `ts_rank`/`plainto_tsquery('simple', query)`
 *             over `search_index.tsv`, scoped to `workspace_id = :workspaceId`;
 *         (b) top-N (same const) by Node-side brute-force cosine similarity
 *             between `embeddingProvider.embed({ text: query })`'s vector and
 *             EVERY non-null `search_index.embedding` in this workspace.
 *       Final score = fixed-weight combination of (normalized keyword score,
 *       cosine score) over the UNION pool (ADR-0013 §b) — sorted descending,
 *       sliced to `limit ?? DEFAULT_LIMIT`.
 *       MUST join `search_index` with `objects_view` on `object_id` and
 *       filter `objects_view.workspace_id = :workspaceId AND
 *       objects_view.lifecycle != 'deleted'` — mirrors
 *       `objects.service.ts`'s own `ne(objectsView.lifecycle, 'deleted')`
 *       convention (grep that file). RBAC is query-time (`WHERE workspace_id
 *       = :id`), never fetch-then-filter (ADR-0013 §f) — a workspace-B row
 *       must never even be fetched while serving workspace A's search.
 *
 *   - `./search.controller.ts`
 *       @Controller('workspaces/:workspaceId/search')
 *       @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
 *       export class SearchController {
 *         @Post()
 *         @HttpCode(HttpStatus.OK)
 *         async search(
 *           @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
 *           @Body(new ZodValidationPipe(searchWorkspaceSchema)) body: SearchWorkspaceInput,
 *         ): Promise<{ results: ... }>;
 *       }
 *       (mirrors `objects.controller.ts`'s exact class-level guard stack +
 *       PARAMETER-level `@Body(new ZodValidationPipe(...))` — NOT a
 *       method-level `@UsePipes`, per the F1-T12 PR5a pipe-scoping lesson:
 *       a method-level `@UsePipes` would also wrongly apply to `@Param`.)
 *
 *   - `./search.module.ts` — wires `SearchController` + `SearchService`,
 *     imports `DbModule` + `EmbeddingProviderModule`; registered into
 *     `../app.module.ts`'s own `imports` array (not this file's job — but the
 *     route resolves to a bare 404 until that registration happens too).
 *
 * PROJECTION-CATCHUP TIMING (per this task's investigation of
 * `objects.service.ts`): `ObjectsService.create()` (and every other
 * event-appending method there — `rename`/`setFieldValues`/
 * `applyCommand`/`applyCommandWithFieldValues`) already calls
 * `await this.projectionRunner.catchUp(this.searchIndexProjection)`
 * SYNCHRONOUSLY before its HTTP response is sent. So every test below that
 * creates/renames/soft-deletes an object via the normal HTTP routes queries
 * `search` IMMEDIATELY after — no polling/`waitForAsync` needed for
 * `search_index.tsv`/`title` freshness. `embedding` is a SEPARATE, genuinely
 * async debounced path (`SearchIndexEmbeddingScheduler`, PR4) — this file
 * never waits on it; AC5 below sidesteps it entirely by writing the
 * `embedding` column directly.
 *
 * ============================================================================
 * F1-T15 PR1 (RED step) addendum — `SearchResult` gains a `snippet: string`
 * field, needed by a future RAG question-answering feature (F1-T15 PR3/PR4)
 * so the LLM has real passage text to cite, not just object metadata.
 *
 * `SearchService.search(...)`'s returned `SearchResult` must become:
 *
 *   interface SearchResult {
 *     objectId: string;
 *     title: string;
 *     type: string;
 *     score: number;
 *     snippet: string;
 *   }
 *
 * Snippet-building contract (pinned by AC9/AC10/AC11 below — implementer must
 * match exactly, no ambiguity left for it):
 *
 *   - Source: `search_index.doc_text` for that result's `objectId`.
 *   - Bounded length: hard-capped to the first 300 characters of `doc_text`
 *     (`doc_text.slice(0, 300)`) — no ellipsis/suffix is added, this file
 *     asserts an EXACT `slice(0, 300)` equality, not merely a length bound.
 *   - `doc_text` is nullable (see `search-index.ts`'s own column comment —
 *     `doc_text` stays `NULL` until a follow-up PR folds
 *     `DocumentContentSnapshotted` events into it). A `null` (or empty-string)
 *     `doc_text` MUST NOT crash the snippet-building step, and MUST NOT
 *     silently fall back to the object's `title` — it must produce
 *     `snippet: ''`. Rationale (deliberate choice, not an oversight): an
 *     empty string is more honest than duplicating the title into what is
 *     supposed to be body content — a future RAG/QA consumer needs to be able
 *     to tell "no body text exists" apart from "body text happens to equal
 *     the title".
 *
 * None of AC9/AC10/AC11 touch `embedding`/semantic search at all — they only
 * ever go through the keyword (`ts_rank`) retrieval path, and directly
 * `UPDATE search_index SET doc_text = ...` via `rawDb` to set up each
 * fixture, mirroring AC5's own precedent of writing straight to
 * `search_index` columns to bypass not-yet-built projection paths.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string };
}
interface WorkspaceEnvelope {
  workspace: { id: string };
}
interface ObjectEnvelope {
  object: { id: string };
}
interface SearchResult {
  objectId: string;
  title: string;
  type: string;
  score: number;
  snippet: string;
}
interface SearchEnvelope {
  results: SearchResult[];
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `search-api-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('F1-T13 PR5 (RED step): POST /workspaces/:workspaceId/search (real Postgres + Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId };
  }

  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerUserWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Search API test workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  async function createObject(
    cookie: string,
    workspaceId: string,
    objectType: string,
    title: string,
  ): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType, title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  async function softDeleteObject(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<void> {
    const response = await request(server)
      .delete(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(204);
  }

  async function search(
    cookie: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(server)
      .post(`/workspaces/${workspaceId}/search`)
      .set('Cookie', cookie)
      .send(body);
  }

  describe('AC1 (Kabul Kriteri #1): keyword-only match via the normal object-creation route', () => {
    it('finds an object by a plain substring of its title, with objectId/title/type populated', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(cookie, workspaceId, 'task', 'Quarterly Roadmap Review');

      const response = await search(cookie, workspaceId, { query: 'Roadmap' });

      expect(response.status).toBe(200);
      const { results } = response.body as SearchEnvelope;
      const match = results.find((result) => result.objectId === objectId);
      expect(match).toBeDefined();
      expect(match?.title).toBe('Quarterly Roadmap Review');
      expect(match?.type).toBe('task');
      expect(typeof match?.score).toBe('number');
    });
  });

  describe('AC2 (Kabul Kriteri #3, ADR §f): cross-workspace isolation — never returns another workspace’s row, even on a keyword collision', () => {
    it('a search in workspace A never surfaces workspace B’s object, though both titles share a distinctive word', async () => {
      const { cookie: cookieA, workspaceId: workspaceA } = await registerUserWithWorkspace();
      const { cookie: cookieB, workspaceId: workspaceB } = await registerUserWithWorkspace();

      const objectAId = await createObject(cookieA, workspaceA, 'task', 'Zephyr Project Alpha');
      const objectBId = await createObject(cookieB, workspaceB, 'task', 'Zephyr Mission Beta');

      const response = await search(cookieA, workspaceA, { query: 'Zephyr' });

      expect(response.status).toBe(200);
      const { results } = response.body as SearchEnvelope;
      const objectIds = results.map((result) => result.objectId);
      expect(objectIds).toContain(objectAId);
      expect(objectIds).not.toContain(objectBId);
    });
  });

  describe('AC3 (ADR §f): a user who is not a member of the target workspace is rejected before any search runs', () => {
    it('returns 403 and leaks no results in the error response', async () => {
      const { cookie: ownerCookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(
        ownerCookie,
        workspaceId,
        'task',
        'Confidential Roadmap Item',
      );

      const { cookie: outsiderCookie } = await registerUser();

      const response = await search(outsiderCookie, workspaceId, { query: 'Confidential' });

      expect(response.status).toBe(403);
      const bodyText = JSON.stringify(response.body);
      expect(bodyText).not.toContain('results');
      expect(bodyText).not.toContain(objectId);
      expect(bodyText).not.toContain('Confidential Roadmap Item');
    });
  });

  describe('AC4 (Kabul Kriteri #3 / lifecycle scoping): soft-deleted objects are excluded from results', () => {
    it('a distinctive title no longer matches once its object is soft-deleted', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(cookie, workspaceId, 'task', 'Vanishing Object Marker');

      const beforeDelete = await search(cookie, workspaceId, { query: 'Vanishing' });
      expect(beforeDelete.status).toBe(200);
      expect((beforeDelete.body as SearchEnvelope).results.map((r) => r.objectId)).toContain(
        objectId,
      );

      await softDeleteObject(cookie, workspaceId, objectId);

      const afterDelete = await search(cookie, workspaceId, { query: 'Vanishing' });
      expect(afterDelete.status).toBe(200);
      expect((afterDelete.body as SearchEnvelope).results.map((r) => r.objectId)).not.toContain(
        objectId,
      );
    });
  });

  describe('AC5 (Kabul Kriteri #2, ADR §b — THE critical union-design test): a zero-keyword-overlap row with a query-adjacent embedding is still found', () => {
    it('a row whose title/doc_text share NO words with the query is found via the semantic/cosine path, not ts_rank', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();

      // Real row via the normal route (so it exists in `objects_view` with
      // lifecycle='active' and gets a real `search_index` row via the
      // projection) — its title deliberately shares ZERO words with the
      // query below.
      const objectId = await createObject(cookie, workspaceId, 'task', 'Xyzzy Plugh Corge');

      // Directly resolves the SAME `EmbeddingProvider` the not-yet-built
      // `SearchService` will use, computes the query's OWN embedding, and
      // overwrites the row's `search_index.embedding` with it (bypassing the
      // projection/scheduler entirely) — proving the retrieval MECHANISM (the
      // union catches a keyword-score-zero row) independent of
      // `MockEmbeddingProvider`'s lack of real semantic understanding (by
      // design — see ADR-0013 §c and this task's own instructions).
      const embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
      const { vector } = await embeddingProvider.embed({ text: 'quantum synergy' });

      await rawDb
        .update(searchIndex)
        .set({ embedding: vector })
        .where(eq(searchIndex.objectId, objectId));

      const response = await search(cookie, workspaceId, { query: 'quantum synergy' });

      expect(response.status).toBe(200);
      const { results } = response.body as SearchEnvelope;
      expect(results.map((result) => result.objectId)).toContain(objectId);
    });
  });

  describe('AC6 (ADR §b DoS cap): `limit` is honored, and exceeding MAX_LIMIT is REJECTED, not silently clamped', () => {
    it('a `limit` of 2 with 5 matches returns at most 2 results', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();

      await Promise.all(
        ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((suffix) =>
          createObject(cookie, workspaceId, 'task', `Widget ${suffix}`),
        ),
      );

      const response = await search(cookie, workspaceId, { query: 'Widget', limit: 2 });

      expect(response.status).toBe(200);
      const { results } = response.body as SearchEnvelope;
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('a `limit` beyond the MAX_LIMIT constant (51) is rejected with 400, not clamped', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      await createObject(cookie, workspaceId, 'task', 'Widget Zeta');

      const response = await search(cookie, workspaceId, { query: 'Widget', limit: 51 });

      expect(response.status).toBe(400);
    });
  });

  describe('AC7: a query that matches nothing returns an empty array, not an error', () => {
    it('200 with { results: [] } for a nonsense query', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      await createObject(cookie, workspaceId, 'task', 'Some Ordinary Title');

      const response = await search(cookie, workspaceId, { query: 'nonexistentwordxyz123' });

      expect(response.status).toBe(200);
      expect((response.body as SearchEnvelope).results).toEqual([]);
    });
  });

  describe('AC8 (zod validation): malformed request bodies are rejected with 400', () => {
    it('missing `query` field', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await search(cookie, workspaceId, {});
      expect(response.status).toBe(400);
    });

    it('empty-string `query`', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await search(cookie, workspaceId, { query: '' });
      expect(response.status).toBe(400);
    });

    it('`query` exceeding MAX_QUERY_LENGTH (201 characters)', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await search(cookie, workspaceId, { query: 'a'.repeat(201) });
      expect(response.status).toBe(400);
    });

    it('an unknown extra field on the body is rejected (.strict() convention, mirrors list-conflicts.schema.ts)', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await search(cookie, workspaceId, { query: 'anything', extra: 'nope' });
      expect(response.status).toBe(400);
    });
  });

  describe('AC9 (F1-T15 PR1, Kabul Kriteri #1): SearchResult gains a `snippet` field derived from search_index.doc_text', () => {
    it('a result’s snippet reflects the object’s doc_text (written directly to search_index, bypassing the not-yet-built doc-text projection) rather than duplicating its title', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(cookie, workspaceId, 'task', 'Snippet Source Object');

      const docText = 'The quick brown fox jumps over the lazy dog near the riverbank.';
      await rawDb.update(searchIndex).set({ docText }).where(eq(searchIndex.objectId, objectId));

      const response = await search(cookie, workspaceId, { query: 'Snippet' });

      expect(response.status).toBe(200);
      const { results } = response.body as SearchEnvelope;
      const match = results.find((result) => result.objectId === objectId);
      expect(match).toBeDefined();
      // docText here is well under the 300-char cap exercised by AC10, so the
      // snippet should reproduce it verbatim rather than truncating.
      expect(match?.snippet).toBe(docText);
    });
  });

  describe('AC10 (F1-T15 PR1, Kabul Kriteri #2): snippet length is bounded to a fixed max (300 chars), even for a much longer doc_text', () => {
    it('truncates a 1000+ character doc_text down to exactly the first 300 characters, with no ellipsis/suffix added', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(cookie, workspaceId, 'task', 'Long Document Object');

      const longDocText = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(20);
      expect(longDocText.length).toBeGreaterThan(1000);

      await rawDb
        .update(searchIndex)
        .set({ docText: longDocText })
        .where(eq(searchIndex.objectId, objectId));

      const response = await search(cookie, workspaceId, { query: 'Long Document' });

      expect(response.status).toBe(200);
      const { results } = response.body as SearchEnvelope;
      const match = results.find((result) => result.objectId === objectId);
      expect(match).toBeDefined();
      // 300 is the fixed cap the implementer must match exactly (see this
      // file's header comment) -- asserted both as a bound and as an EXACT
      // slice(0, 300) equality, so a different truncation strategy (e.g.
      // word-boundary trimming, an appended "...") would also fail this test
      // until it matches this exact contract.
      expect(match?.snippet.length).toBeLessThanOrEqual(300);
      expect(match?.snippet).toBe(longDocText.slice(0, 300));
    });
  });

  describe('AC11 (F1-T15 PR1, Kabul Kriteri #3): a null/empty doc_text produces a safe, honest empty-string snippet — never a crash, never a silent title duplicate', () => {
    it('an object with no doc_text (title-only, never had a DocumentContentSnapshotted event) returns snippet: "" rather than crashing or echoing the title', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      // Deliberately never written to `search_index.doc_text` -- it stays
      // NULL, the schema's documented default for an object with no
      // doc-content event yet (see `search-index.ts`'s own column comment).
      const objectId = await createObject(
        cookie,
        workspaceId,
        'task',
        'Title Only No Doc Text Object',
      );

      const response = await search(cookie, workspaceId, { query: 'Title Only No Doc Text' });

      expect(response.status).toBe(200);
      const { results } = response.body as SearchEnvelope;
      const match = results.find((result) => result.objectId === objectId);
      expect(match).toBeDefined();
      // Deliberate choice (see this file's header comment): an empty string
      // is more honest than silently duplicating the title into what is
      // supposed to be body content.
      expect(match?.snippet).toBe('');
    });
  });

  /**
   * F2-T11 (RED step), ADR-0027 §c — new `POST
   * /workspaces/:workspaceId/search/external` route on the SAME
   * `SearchController`, same guard stack (`SessionAuthGuard`,
   * `WorkspaceMembershipGuard`) as the existing internal `/search` route
   * above. Backed by the not-yet-existing `ConnectedSearchService`
   * (`./connected-search.service.ts`, see `./connected-search.service.test.ts`
   * for its own unit-level RED-step coverage) — this file only proves the
   * HTTP-layer contract (auth/membership/validation/isolation), mirroring
   * AC3/AC8's exact patterns above for the new route.
   *
   * None of these tests seed any `connector_credentials` row, so every
   * connectorType is "never connected" for every fixture user — per
   * ADR-0027 §e point 1 this means `{results: [], degraded: []}` for the
   * success-path test (never-connected != degraded), which conveniently lets
   * this file avoid depending on the (also not-yet-existing-in-this-task)
   * connector-credentials seeding path entirely.
   *
   * EXPECTED RED STATE (today): the route does not exist — every request
   * below 404s (or, once the route/guard stack exists but
   * `ConnectedSearchService`/its schema file don't, 500s) instead of
   * returning the status codes asserted here. Either way this is the
   * expected "implementation incomplete" red, not a test-logic bug.
   */
  describe('F2-T11 (ADR-0027 §c): POST /workspaces/:workspaceId/search/external', () => {
    async function searchExternal(
      cookie: string,
      workspaceId: string,
      body: Record<string, unknown>,
    ): Promise<request.Response> {
      return request(server)
        .post(`/workspaces/${workspaceId}/search/external`)
        .set('Cookie', cookie)
        .send(body);
    }

    it('AC1: an authenticated member with a valid { query } body gets 200 with the {results, degraded} shape', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();

      const response = await searchExternal(cookie, workspaceId, { query: 'roadmap' });

      expect(response.status).toBe(200);
      const body = response.body as { results: unknown[]; degraded: unknown[] };
      expect(Array.isArray(body.results)).toBe(true);
      expect(Array.isArray(body.degraded)).toBe(true);
      // No connector_credentials row was ever seeded for this fresh user —
      // "never connected" must not appear in degraded (ADR-0027 §e point 1).
      expect(body.degraded).toEqual([]);
    });

    it("AC2: an unauthenticated request is rejected with 401, mirroring the existing internal /search route's auth behavior", async () => {
      const { workspaceId } = await registerUserWithWorkspace();

      const response = await request(server)
        .post(`/workspaces/${workspaceId}/search/external`)
        .send({ query: 'roadmap' });

      expect(response.status).toBe(401);
    });

    it('AC3: an authenticated user who is NOT a member of the target workspace is rejected with 403 before any external search runs', async () => {
      const { workspaceId } = await registerUserWithWorkspace();
      const { cookie: outsiderCookie } = await registerUser();

      const response = await searchExternal(outsiderCookie, workspaceId, { query: 'roadmap' });

      expect(response.status).toBe(403);
      const bodyText = JSON.stringify(response.body);
      expect(bodyText).not.toContain('results');
      expect(bodyText).not.toContain('degraded');
    });

    it('AC4 (zod validation): a missing `query` field is rejected with 400', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();

      const response = await searchExternal(cookie, workspaceId, {});

      expect(response.status).toBe(400);
    });

    it('AC4 (zod validation): an empty-string `query` is rejected with 400', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();

      const response = await searchExternal(cookie, workspaceId, { query: '' });

      expect(response.status).toBe(400);
    });

    it("AC5 (cross-workspace isolation, security-critical): a user who is a member of workspace A gets 403 hitting workspace B's external-search route, and the response never leaks any hint of B's connector state", async () => {
      const { cookie: cookieA } = await registerUserWithWorkspace();
      const { workspaceId: workspaceB } = await registerUserWithWorkspace();

      const response = await searchExternal(cookieA, workspaceB, { query: 'anything' });

      expect(response.status).toBe(403);
      const bodyText = JSON.stringify(response.body);
      expect(bodyText).not.toContain('results');
      expect(bodyText).not.toContain('degraded');
      expect(bodyText).not.toContain('accessToken');
      expect(bodyText).not.toContain('notion');
      expect(bodyText).not.toContain('slack');
    });
  });
});
