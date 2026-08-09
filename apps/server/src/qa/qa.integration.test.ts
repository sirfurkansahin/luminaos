import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';
import type { AIProvider, EmbeddingProvider } from '@luminaos/ai-gateway';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { EMBEDDING_PROVIDER } from '../ai/embedding-provider.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { searchIndex } from '../db/schema/search-index.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { MockInstance } from 'vitest';

/**
 * F1-T15 PR4 (RED step) — the FINAL sub-PR of the RAG question-answering
 * feature: wires `SearchService` (F1-T15 PR1's `snippet`-bearing
 * `SearchResult`), `AIUsageService` (PR2), `answerQuestion` (PR3), and
 * `selectAIModel({ outputType: 'qa' })` (PR3) into a brand-new
 * `POST /workspaces/:workspaceId/qa` endpoint.
 *
 * Nothing under test here exists yet:
 *   - `apps/server/src/qa/qa.controller.ts` / `qa.service.ts` / `qa.module.ts`
 *     / `dto/ask-question.schema.ts` do not exist at all.
 *   - `QAModule` is not registered in `../app.module.ts`'s own `imports`
 *     array.
 * Every request below to `POST /workspaces/:workspaceId/qa` therefore 404s
 * ("Cannot POST ...") — this is the correct RED state; none of the specific
 * status-code assertions below (200/403/429/400) can pass until
 * `implementer` builds the above.
 *
 * IMPORTANT flag for `implementer` (not fixed by this PR — test files may
 * only touch `*.test.ts`): `../search/search.module.ts` currently has
 * `providers: [SearchService, ...]` with NO `exports: [...]` array at all,
 * so `SearchService` is not importable by another module today. The new
 * `QAModule` needs `SearchService` injected (to build RAG passages) — this
 * requires a one-line, non-breaking addition of `exports: [SearchService]`
 * to `SearchModule` before `QAModule` can `imports: [SearchModule]` and
 * inject `SearchService`.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   POST /workspaces/:workspaceId/qa
 *   Body: { question: string }   Zod: z.object({ question: z.string().min(1).max(MAX_QUESTION_LENGTH) }).strict()
 *     MAX_QUESTION_LENGTH = 500 — same "DoS-cap-via-validation-REJECTION"
 *     convention as `../search/dto/search-workspace.schema.ts`'s
 *     `MAX_QUERY_LENGTH` (reject, never truncate). 500 (vs. search's 200) is
 *     a deliberate, documented choice: a natural-language QUESTION is
 *     typically a full sentence (or several), structurally longer than a
 *     keyword search box query.
 *   Response 200: { answer: string, sources: { objectId: string; title: string; snippet: string }[] }
 *   Guards: @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard), same
 *     class-level stack + PARAMETER-level `@Body(new ZodValidationPipe(...))`
 *     convention as `SearchController` (never a method-level `@UsePipes`,
 *     per the F1-T12 PR5a pipe-scoping lesson).
 *
 *   `QAService` orchestration (per the approved plan):
 *     1. `SearchService.search(workspaceId, question, TOP_K)` — TOP_K = 5,
 *        a fixed constant DISTINCT from search's own `DEFAULT_LIMIT = 10`:
 *        RAG context should stay smaller than a user-facing search results
 *        page (fewer, higher-signal passages keep the prompt focused and
 *        cheap). This file does not assert the exact TOP_K value directly
 *        (an implementation-detail tuning knob, not a spec'd acceptance
 *        criterion) — only the end-to-end retrieval/answer/source behavior
 *        it produces.
 *     2. Map `SearchResult[]` -> `QAPassage[]` ({ objectId, title, snippet }).
 *     3. `AIUsageService.withWorkspaceAILock(workspaceId, async () => { ... })`
 *        wrapping `assertAITokenQuotaNotExceeded` + `assertAICostBudgetNotExceeded`
 *        (checked BEFORE calling `answerQuestion`/the provider — same "once
 *        per operation" discipline as `performAIFieldRefresh`,
 *        see `../objects/object-ai-refresh.integration.test.ts`).
 *     4. `selectAIModel({ outputType: 'qa' })` -> `CLAUDE_SONNET_5` (F1-T15 PR3).
 *     5. `answerQuestion({ provider, question, passages, model, recordUsage: (usage) =>
 *          aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model) })`
 *        — `fieldDefinitionId`/`objectId` are BOTH `undefined` for QA usage
 *        records (the whole point of PR2's nullable-column migration).
 *     6. Returns `{ answer, sources }` verbatim from `answerQuestion`'s result.
 *
 * ============================================================================
 * THE DETERMINISTIC-RETRIEVAL TRICK THIS FILE USES (mirrors
 * `../search/search.integration.test.ts`'s own AC5 precedent):
 *
 * `search_index.tsv` is currently derived from TITLE ONLY (see
 * `../db/schema/search-index.ts`'s own column comment — `doc_text` is not
 * yet folded into `tsv`), and `plainto_tsquery('simple', query)` ANDs every
 * token of the query together. A natural-language QUESTION (many words, most
 * of which will never appear in a short object title) would almost never
 * satisfy that AND — so this file does NOT rely on keyword/`ts_rank`
 * matching for its happy-path/quota/cost tests. Instead, exactly like
 * `search.integration.test.ts`'s AC5, it resolves the SAME `EmbeddingProvider`
 * the app's `SearchService` uses, computes the QUESTION's own embedding
 * vector, and writes it DIRECTLY onto a seeded object's `search_index.embedding`
 * column (bypassing the projection/scheduler). Cosine similarity to itself is
 * 1.0, so that object is deterministically retrieved via the semantic
 * retrieval axis regardless of keyword overlap.
 *
 * The `"RETURN:<answer>"` marker (see
 * `../ai/ai-provider.module.ts`'s `unconfiguredResponder`, and
 * `../objects/object-ai-refresh.integration.test.ts`'s identical
 * `returnDirective` convention) is planted as the FINAL segment of the
 * QUESTION text itself (never inside a passage) — since `answerQuestion`'s
 * prompt template (`../ai/answer-question.ts`'s `renderQAPrompt`) always
 * places `Question: ${question}` as the LAST line of the rendered prompt,
 * with nothing after it, "everything after RETURN: to the end of the
 * prompt string" is then EXACTLY the planted answer text, with no trailing
 * content to strip.
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
interface QASource {
  objectId: string;
  title: string;
  snippet: string;
}
interface QAEnvelope {
  answer: string;
  sources: QASource[];
}
interface ApiErrorEnvelope {
  error: { code: string; message: string };
}
interface RawAIUsageRow {
  field_definition_id: string | null;
  object_id: string | null;
  model: string | null;
  cost_usd: string | null;
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `qa-api-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

/** Same convention as `../objects/object-ai-refresh.integration.test.ts`'s
 * own `returnDirective` — planted as the FINAL segment of the QUESTION text
 * (see this file's header for why, unlike that file's prompt-template
 * placement). */
function returnDirective(value: string): string {
  return `RETURN:${value}`;
}

describe('F1-T15 PR4 (RED step): POST /workspaces/:workspaceId/qa (real Postgres + Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let aiProvider: AIProvider;
  let embeddingProvider: EmbeddingProvider;
  let completeSpy: MockInstance<AIProvider['complete']>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // Deliberately NOT set -- forces the DI wiring to fall back to
    // MockProvider (`unconfiguredResponder`'s RETURN: marker convention).
    delete process.env.ANTHROPIC_API_KEY;

    // A tiny shared token quota (far below one call's fixed 120 scripted
    // tokens) -- mirrors `object-ai-refresh.integration.test.ts`'s design
    // decision 2 exactly: every test's FIRST QA call, in its own
    // freshly-registered workspace, starts at 0 prior usage and is always
    // allowed (0 < 10); only a SECOND call in the SAME workspace is ever
    // blocked by this.
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '10';

    // Matches `env.ts`'s own default (10) -- set explicitly for this file's
    // own documentation clarity, mirroring
    // `object-ai-refresh.integration.test.ts`'s identical explicit override.
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = '10';

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());

    aiProvider = app.get<AIProvider>(AI_PROVIDER);
    embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
    completeSpy = vi.spyOn(aiProvider, 'complete');
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
      `QA API test workspace ${String(emailCounter)}`,
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

  async function askQuestion(
    cookie: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(server).post(`/workspaces/${workspaceId}/qa`).set('Cookie', cookie).send(body);
  }

  /**
   * The deterministic-retrieval trick this file's header documents: computes
   * `text`'s own embedding via the app's REAL `EmbeddingProvider` DI binding
   * and overwrites `objectId`'s `search_index.embedding` row directly,
   * bypassing the projection/scheduler entirely (mirrors
   * `search.integration.test.ts`'s AC5 precedent).
   */
  async function attachEmbeddingForText(objectId: string, text: string): Promise<void> {
    const { vector } = await embeddingProvider.embed({ text });
    await rawDb
      .update(searchIndex)
      .set({ embedding: vector })
      .where(eq(searchIndex.objectId, objectId));
  }

  async function getLatestUsageRow(workspaceId: string): Promise<RawAIUsageRow | undefined> {
    const result = await rawDb.$client.query<RawAIUsageRow>(
      'select field_definition_id, object_id, model, cost_usd from ai_usage_records where workspace_id = $1 order by created_at desc limit 1',
      [workspaceId],
    );
    return result.rows[0];
  }

  async function countUsageRows(workspaceId: string): Promise<number> {
    const result = await rawDb.$client.query<{ count: string }>(
      'select count(*)::text as count from ai_usage_records where workspace_id = $1',
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  /**
   * Seeds a synthetic `ai_usage_records` row directly via raw SQL (bypassing
   * `AIUsageService.recordAIUsage` entirely), with NULL `field_definition_id`/
   * `object_id` -- exactly the shape a REAL QA-originated usage record has
   * (PR2's nullable-column migration) -- so a workspace's cumulative
   * recorded COST can be pushed above `AI_COST_BUDGET_USD_PER_WORKSPACE`
   * WITHOUT needing any real provider call first. Mirrors
   * `object-ai-refresh.integration.test.ts`'s own `seedPriorUsageCost`
   * helper.
   */
  async function seedPriorUsageCost(workspaceId: string, costUsd: string): Promise<void> {
    await rawDb.$client.query(
      `insert into ai_usage_records
         (id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd, created_at)
       values ($1, $2, NULL, NULL, $3, $4, $5, $6, now())`,
      [randomUUID(), workspaceId, 0, 0, null, costUsd],
    );
  }

  // ---------------------------------------------------------------------
  // AC1 — happy-path retrieval + deterministic scripted answer + sources
  // ---------------------------------------------------------------------

  describe('AC1 (Kabul Kriteri #1/#2): a question whose embedding matches a seeded object returns that object as a source and the exact scripted answer', () => {
    it('200 with answer === the planted RETURN: text and sources containing { objectId, title, snippet }', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const title = 'Aurora Project Status Update';
      const objectId = await createObject(cookie, workspaceId, 'task', title);
      const docText = 'Aurora project is progressing well and will launch next quarter.';
      await rawDb.update(searchIndex).set({ docText }).where(eq(searchIndex.objectId, objectId));

      const plantedAnswer = 'The aurora project is progressing well and will launch next quarter.';
      const question = `What is the status of the Aurora project? ${returnDirective(plantedAnswer)}`;
      await attachEmbeddingForText(objectId, question);

      const response = await askQuestion(cookie, workspaceId, { question });

      expect(response.status).toBe(200);
      const body = response.body as QAEnvelope;
      expect(body.answer).toBe(plantedAnswer);

      const source = body.sources.find((entry) => entry.objectId === objectId);
      expect(source).toBeDefined();
      expect(source?.title).toBe(title);
      expect(typeof source?.snippet).toBe('string');
    });
  });

  // ---------------------------------------------------------------------
  // AC2 — cross-workspace isolation
  // ---------------------------------------------------------------------

  describe('AC2 (Kabul Kriteri #3, ADR-0013 §f inherited): a QA question in workspace A never surfaces workspace B’s content as a source', () => {
    it('sources contains workspace A’s object and never workspace B’s, even though both were engineered with an IDENTICAL matching embedding', async () => {
      const { cookie: cookieA, workspaceId: workspaceA } = await registerUserWithWorkspace();
      const { cookie: cookieB, workspaceId: workspaceB } = await registerUserWithWorkspace();

      const objectAId = await createObject(cookieA, workspaceA, 'task', 'Nebula Report Alpha');
      const objectBId = await createObject(cookieB, workspaceB, 'task', 'Nebula Report Beta');

      const question = 'What does the nebula report say?';
      await attachEmbeddingForText(objectAId, question);
      await attachEmbeddingForText(objectBId, question);

      const response = await askQuestion(cookieA, workspaceA, { question });

      expect(response.status).toBe(200);
      const body = response.body as QAEnvelope;
      const sourceIds = body.sources.map((entry) => entry.objectId);
      expect(sourceIds).toContain(objectAId);
      expect(sourceIds).not.toContain(objectBId);
      expect(JSON.stringify(body)).not.toContain('Beta');
    });
  });

  // ---------------------------------------------------------------------
  // AC3 — non-member rejected before any retrieval/AI call
  // ---------------------------------------------------------------------

  describe('AC3 (RBAC, F0-T5): a user who is not a member of the target workspace is rejected before any retrieval/AI-provider call happens', () => {
    it('returns 403 (mirrors WorkspaceMembershipGuard’s existing status code) and leaks no sources/title/answer', async () => {
      const { cookie: ownerCookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(
        ownerCookie,
        workspaceId,
        'task',
        'Confidential Object Title',
      );

      const { cookie: outsiderCookie } = await registerUser();

      const callsBefore = completeSpy.mock.calls.length;
      const response = await askQuestion(outsiderCookie, workspaceId, {
        question: 'What is confidential here?',
      });

      expect(response.status).toBe(403);
      const bodyText = JSON.stringify(response.body);
      expect(bodyText).not.toContain('sources');
      expect(bodyText).not.toContain(objectId);
      expect(bodyText).not.toContain('Confidential Object Title');
      expect(completeSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 — empty-passages short circuit: no hallucination, no wasted cost
  // ---------------------------------------------------------------------

  describe('AC4 (no-hallucination / no-wasted-cost, approved plan): a question matching nothing in the workspace short-circuits end-to-end', () => {
    it('200 with the FIXED "no relevant content" answer, sources: [], no provider call, and no new ai_usage_records row', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      // Deliberately no objects created in this workspace at all -- search
      // returns zero results regardless of the question text.

      const callsBefore = completeSpy.mock.calls.length;
      const response = await askQuestion(cookie, workspaceId, {
        question: 'Anything at all in this empty workspace?',
      });

      expect(response.status).toBe(200);
      const body = response.body as QAEnvelope;
      // Exact string pinned by `../ai/answer-question.ts`'s
      // `EMPTY_PASSAGES_ANSWER` constant.
      expect(body.answer).toBe(
        'No relevant content was found in this workspace to answer this question.',
      );
      expect(body.sources).toEqual([]);

      expect(completeSpy.mock.calls.length).toBe(callsBefore);

      const usageCount = await countUsageRows(workspaceId);
      expect(usageCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // AC5 — token quota exceeded
  // ---------------------------------------------------------------------

  describe('AC5 (F1-T14 quota discipline inherited): a SECOND QA call in the same workspace, after the first consumed the shared low token quota, is rejected', () => {
    it('first call succeeds (200); second call in the same workspace is rejected with 429 QUOTA_EXCEEDED', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(cookie, workspaceId, 'task', 'Quota Test Object');
      const question = `Tell me about the quota test object. ${returnDirective('first call answer')}`;
      await attachEmbeddingForText(objectId, question);

      const first = await askQuestion(cookie, workspaceId, { question });
      expect(first.status).toBe(200);
      expect((first.body as QAEnvelope).answer).toBe('first call answer');

      // Second operation: prior cumulative usage is now 120 (this file's
      // fixed per-call MockProvider usage, since the RETURN: marker was
      // present) >= the shared quota of 10 -- rejected before any further
      // provider call.
      const second = await askQuestion(cookie, workspaceId, { question });

      expect(second.status).toBe(429);
      expect((second.body as ApiErrorEnvelope).error.code).toBe('QUOTA_EXCEEDED');
    });
  });

  // ---------------------------------------------------------------------
  // AC6 — cost budget exceeded
  // ---------------------------------------------------------------------

  describe('AC6 (F1-T14 PR4 $ budget discipline inherited): a workspace whose cumulative recorded cost already exceeds the budget is rejected before any provider call', () => {
    it('429 QUOTA_EXCEEDED, and the provider is never invoked, even though a matching passage exists', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(cookie, workspaceId, 'task', 'Cost Budget Test Object');
      const question = `Tell me about the cost budget object. ${returnDirective('should never be reached')}`;
      await attachEmbeddingForText(objectId, question);

      // Seeded FAR above this file's shared AI_COST_BUDGET_USD_PER_WORKSPACE
      // ('10') -- this workspace's cumulative recorded cost is already over
      // budget before the very FIRST QA call even starts.
      await seedPriorUsageCost(workspaceId, '20.000000');

      const callsBefore = completeSpy.mock.calls.length;
      const response = await askQuestion(cookie, workspaceId, { question });

      expect(response.status).toBe(429);
      expect((response.body as ApiErrorEnvelope).error.code).toBe('QUOTA_EXCEEDED');
      expect(completeSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  // ---------------------------------------------------------------------
  // AC7 — usage recorded correctly on success
  // ---------------------------------------------------------------------

  describe('AC7 (Kabul Kriteri #4): a successful QA answer records a NULL-context ai_usage_records row with model + cost_usd populated', () => {
    it('field_definition_id and object_id are both NULL, model === CLAUDE_SONNET_5 (selectAIModel({outputType:"qa"})), cost_usd is non-null', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const objectId = await createObject(cookie, workspaceId, 'task', 'Usage Accounting Object');
      const question = `Tell me about the usage accounting object. ${returnDirective('usage accounting answer')}`;
      await attachEmbeddingForText(objectId, question);

      const response = await askQuestion(cookie, workspaceId, { question });
      expect(response.status).toBe(200);

      const row = await getLatestUsageRow(workspaceId);
      expect(row).toBeDefined();
      expect(row?.field_definition_id).toBeNull();
      expect(row?.object_id).toBeNull();
      expect(row?.model).toBe(CLAUDE_SONNET_5);
      expect(row?.cost_usd).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // AC8 — DTO validation: DoS cap + .strict()
  // ---------------------------------------------------------------------

  describe('AC8 (zod validation, DoS-cap-via-rejection convention mirrors searchWorkspaceSchema): malformed request bodies are rejected with 400', () => {
    it('missing `question` field', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await askQuestion(cookie, workspaceId, {});
      expect(response.status).toBe(400);
    });

    it('empty-string `question`', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await askQuestion(cookie, workspaceId, { question: '' });
      expect(response.status).toBe(400);
    });

    it('`question` exceeding MAX_QUESTION_LENGTH (501 characters) is rejected, not truncated', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await askQuestion(cookie, workspaceId, { question: 'a'.repeat(501) });
      expect(response.status).toBe(400);
    });

    it('an unknown extra field on the body is rejected (.strict() convention)', async () => {
      const { cookie, workspaceId } = await registerUserWithWorkspace();
      const response = await askQuestion(cookie, workspaceId, {
        question: 'A valid question',
        extra: 'nope',
      });
      expect(response.status).toBe(400);
    });
  });
});
