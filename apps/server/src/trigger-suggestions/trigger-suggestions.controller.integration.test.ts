import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionResult } from '@luminaos/ai-gateway';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { createDatabaseClient } from '../db/client.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T17 PR2 (RED step), ADR-0034 -- HTTP wiring for `TriggerSuggestionsService`
 * (`TriggerSuggestionsController`/`TriggerSuggestionsModule`). Mirrors
 * `automation-triggers.controller.integration.test.ts`'s exact harness (full
 * Nest app boot via Testcontainers Postgres 16 + Redis 7, real
 * `SessionAuthGuard`/`WorkspaceMembershipGuard` flow, the same
 * `addMemberWithRole` raw-insert-into-`memberships` helper).
 *
 * SCOPE (test-writer judgment call, mirroring `commands.controller.
 * integration.test.ts`'s own precedent): this file does NOT re-test
 * `TriggerSuggestionsService`'s business logic exhaustively (cooldown, dedup,
 * the 5-per-run cap, the two-layer defensive re-validation, actor provenance,
 * ULID-vs-UUID id minting, AI quota/lock ordering) -- all of that is already
 * covered end-to-end by `./trigger-suggestions.service.integration.test.ts`.
 * This file focuses ONLY on what is NEW at the HTTP layer: routing, the guard
 * stack (`SessionAuthGuard`/`WorkspaceMembershipGuard`), the RBAC split
 * (member+ read / admin+ write, ADR-0034 Karar a), body validation for
 * `decide`'s `decision` enum, and the `AppError` -> HTTP-status mapping
 * (`AppErrorFilter`) for `ForbiddenError`/`NotFoundError`/`ConflictError`
 * surfacing through this specific controller.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NONE of `TriggerSuggestionsService` /
 * `TriggerSuggestionsController` / `TriggerTemplateSuggestionProjection` /
 * `TriggerSuggestionsModule` exist yet, and `AppModule` does not import any
 * such module -- every request below to
 * `/workspaces/:workspaceId/trigger-suggestions...` is expected to 404 via
 * Nest's own default "Cannot POST/GET ..." handler (no matching route at
 * all), NOT via `AppErrorFilter` mapping an `AppError`, mirroring
 * `automation-triggers.controller.integration.test.ts`'s own documented
 * red-state note for the analogous "module doesn't exist yet" situation.
 * `trigger_template_suggestions`/`trigger_suggestion_analysis_state` (PR1,
 * merged) already exist as tables -- only the HTTP layer (and the service/
 * projection it depends on) is missing.
 *
 * `implementer` must add `trigger-suggestions.service.ts`,
 * `trigger-suggestions.controller.ts`, `trigger-suggestions.projection.ts`,
 * and `trigger-suggestions.module.ts` (imported by `AppModule`), matching
 * BOTH this file's route contract below AND
 * `./trigger-suggestions.service.integration.test.ts`'s pinned service
 * contract exactly (the same `TriggerSuggestionsService` class backs both).
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * ROUTE CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/trigger-suggestions')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level.
 *
 *   GET    /workspaces/:workspaceId/trigger-suggestions
 *          -> 200 { suggestions: TriggerTemplateSuggestionSummary[] } (member+, else 403)
 *          Calls: triggerSuggestionsService.list(workspaceId, callerRole)
 *
 *   POST   /workspaces/:workspaceId/trigger-suggestions/analyze
 *          -> 201 { suggestions: TriggerTemplateSuggestionSummary[] } (admin+, else 403)
 *          Calls: triggerSuggestionsService.runAnalysis(workspaceId, actor, callerRole)
 *          A cooldown-blocked call -> ConflictError -> 409.
 *
 *   POST   /workspaces/:workspaceId/trigger-suggestions/:suggestionId/decide
 *          body: { decision: 'approve' | 'reject' }
 *            Zod: z.object({ decision: z.enum(['approve', 'reject']) }).strict()
 *          -> 200 { suggestion: TriggerTemplateSuggestionSummary } (admin+, else 403)
 *          Calls: triggerSuggestionsService.decide(workspaceId, actor, callerRole, suggestionId, decision)
 *          An unknown/cross-workspace suggestionId -> NotFoundError -> 404.
 *          An already-decided suggestionId -> ConflictError -> 409.
 *
 * The AI provider is overridden (`overrideProvider(AI_PROVIDER)`) with a
 * fully-scripted `MockProvider` for this file's ONE success-path `analyze`
 * test, rather than relying on the production `unconfiguredResponder`'s
 * `RETURN:` marker convention (`ai-provider.module.ts`) -- that convention
 * only works when the caller-supplied text is the LAST content embedded in
 * the rendered prompt, which is not the case for
 * `suggestTriggerTemplates`'s prompt template (its own fixed instructions
 * text always follows the usage-pattern summary). Overriding the provider
 * entirely sidesteps that positional constraint and mirrors
 * `object-recurrence-trigger.integration.test.ts`'s own established
 * `overrideProvider` precedent in this codebase.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface TriggerTemplateSuggestionBody {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  spec: Record<string, unknown>;
  rationale: string;
  status: string;
  createdTriggerId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface SuggestionListEnvelope {
  suggestions: TriggerTemplateSuggestionBody[];
}

interface SuggestionDecideEnvelope {
  suggestion: TriggerTemplateSuggestionBody;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `trigger-suggestion-test-user-${String(emailCounter)}@example.com`;
}

/** Always returns a scripted `{"suggestions": [...]}` envelope with exactly one safe, valid candidate -- this file only needs ONE successful analyze round-trip to prove the HTTP wiring; deep AI-orchestration edge cases live in the service-level test file. */
function scriptedAnalyzeProvider(): MockProvider {
  const responseText = JSON.stringify({
    suggestions: [
      {
        name: 'HTTP-wiring smoke-test candidate',
        rationale: 'Exercises the POST .../analyze route end-to-end.',
        spec: { kind: 'scheduled', intervalMinutes: 30, actionTemplate: { title: 'Do the thing' } },
      },
    ],
  });
  return new MockProvider((): AICompletionResult => ({
    text: responseText,
    usage: { inputTokens: 2, outputTokens: 1 },
  }));
}

describe('F2-T17 PR2 (RED step): .../trigger-suggestions -- AI-suggested automation trigger templates (real Postgres + Redis + real HTTP, via Testcontainers + supertest)', () => {
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

    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AI_PROVIDER)
      .useValue(scriptedAnalyzeProvider())
      .compile();

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

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    expect((registerResponse.body as UserEnvelope).user.id).toBeDefined();

    const workspaceResponse = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Trigger suggestion test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    const userId = (registerResponse.body as UserEnvelope).user.id;

    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  function suggestionsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/trigger-suggestions`;
  }

  function analyzeUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/trigger-suggestions/analyze`;
  }

  function decideUrl(workspaceId: string, suggestionId: string): string {
    return `/workspaces/${workspaceId}/trigger-suggestions/${suggestionId}/decide`;
  }

  // -----------------------------------------------------------------------
  // GET .../trigger-suggestions (Karar a: member+)
  // -----------------------------------------------------------------------

  it('1. GET as a "member" -> 200, { suggestions: [] } for a workspace with none yet', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .get(suggestionsUrl(workspaceId))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    const { suggestions } = response.body as SuggestionListEnvelope;
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it('2. GET as a "guest" (below member) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server)
      .get(suggestionsUrl(workspaceId))
      .set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('3. GET unauthenticated -> 401', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server).get(suggestionsUrl(workspaceId));
    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // POST .../analyze (Karar a: admin+, Karar b: cooldown)
  // -----------------------------------------------------------------------

  it('4. POST .../analyze as a "member" (not admin) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .post(analyzeUrl(workspaceId))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(403);
  });

  it('5. POST .../analyze as an admin (the workspace owner) -> 201, returns the newly-created suggestions, subsequently visible via GET', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server).post(analyzeUrl(workspaceId)).set('Cookie', cookie);

    expect(response.status).toBe(201);
    const { suggestions } = response.body as SuggestionListEnvelope;
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions.some((s) => s.name === 'HTTP-wiring smoke-test candidate')).toBe(true);

    const listResponse = await request(server)
      .get(suggestionsUrl(workspaceId))
      .set('Cookie', cookie);
    expect(listResponse.status).toBe(200);
    const { suggestions: listed } = listResponse.body as SuggestionListEnvelope;
    expect(listed.some((s) => s.name === 'HTTP-wiring smoke-test candidate')).toBe(true);
  });

  it('6. a SECOND POST .../analyze on the same workspace within the cooldown window -> 409', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const first = await request(server).post(analyzeUrl(workspaceId)).set('Cookie', cookie);
    expect(first.status).toBe(201);

    const second = await request(server).post(analyzeUrl(workspaceId)).set('Cookie', cookie);
    expect(second.status).toBe(409);
  });

  it('7. POST .../analyze unauthenticated -> 401', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server).post(analyzeUrl(workspaceId));
    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // POST .../:suggestionId/decide (Karar a: admin+)
  // -----------------------------------------------------------------------

  it('8. POST .../:suggestionId/decide {decision:"approve"} as an admin -> 200, suggestion becomes "approved" with a createdTriggerId', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const analyzeResponse = await request(server)
      .post(analyzeUrl(workspaceId))
      .set('Cookie', cookie);
    expect(analyzeResponse.status).toBe(201);
    const [created] = (analyzeResponse.body as SuggestionListEnvelope).suggestions;
    expect(created).toBeDefined();

    const response = await request(server)
      .post(decideUrl(workspaceId, created?.id ?? ''))
      .set('Cookie', cookie)
      .send({ decision: 'approve' });

    expect(response.status).toBe(200);
    const { suggestion } = response.body as SuggestionDecideEnvelope;
    expect(suggestion.status).toBe('approved');
    expect(suggestion.createdTriggerId).toBeDefined();
    expect(suggestion.createdTriggerId).not.toBeNull();
  });

  it('9. POST .../:suggestionId/decide {decision:"reject"} as an admin -> 200, suggestion becomes "rejected" with createdTriggerId null', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const analyzeResponse = await request(server)
      .post(analyzeUrl(workspaceId))
      .set('Cookie', cookie);
    expect(analyzeResponse.status).toBe(201);
    const [created] = (analyzeResponse.body as SuggestionListEnvelope).suggestions;
    expect(created).toBeDefined();

    const response = await request(server)
      .post(decideUrl(workspaceId, created?.id ?? ''))
      .set('Cookie', cookie)
      .send({ decision: 'reject' });

    expect(response.status).toBe(200);
    const { suggestion } = response.body as SuggestionDecideEnvelope;
    expect(suggestion.status).toBe('rejected');
    expect(suggestion.createdTriggerId).toBeNull();
  });

  it('10. POST .../:suggestionId/decide as a "member" (not admin) -> 403', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    const analyzeResponse = await request(server)
      .post(analyzeUrl(workspaceId))
      .set('Cookie', adminCookie);
    expect(analyzeResponse.status).toBe(201);
    const [created] = (analyzeResponse.body as SuggestionListEnvelope).suggestions;
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .post(decideUrl(workspaceId, created?.id ?? ''))
      .set('Cookie', memberCookie)
      .send({ decision: 'approve' });

    expect(response.status).toBe(403);
  });

  it('11. POST .../:suggestionId/decide with an invalid "decision" value -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const analyzeResponse = await request(server)
      .post(analyzeUrl(workspaceId))
      .set('Cookie', cookie);
    expect(analyzeResponse.status).toBe(201);
    const [created] = (analyzeResponse.body as SuggestionListEnvelope).suggestions;

    const response = await request(server)
      .post(decideUrl(workspaceId, created?.id ?? ''))
      .set('Cookie', cookie)
      .send({ decision: 'maybe-later' });

    expect(response.status).toBe(400);
  });

  it('12. POST .../:suggestionId/decide on an unknown suggestionId -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(decideUrl(workspaceId, '01ARZ3NDEKTSV4RRFFQ69G5FAV'))
      .set('Cookie', cookie)
      .send({ decision: 'approve' });

    expect(response.status).toBe(404);
  });

  it("13. cross-workspace isolation: a suggestion created in workspace A is invisible/undecidable from workspace B (404, not a data leak) and never appears in workspace B's GET list", async () => {
    const { cookie: cookieA, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    const analyzeResponse = await request(server)
      .post(analyzeUrl(workspaceAId))
      .set('Cookie', cookieA);
    expect(analyzeResponse.status).toBe(201);
    const [created] = (analyzeResponse.body as SuggestionListEnvelope).suggestions;

    const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();

    const decideResponse = await request(server)
      .post(decideUrl(workspaceBId, created?.id ?? ''))
      .set('Cookie', cookieB)
      .send({ decision: 'approve' });
    expect(decideResponse.status).toBe(404);

    const listResponseB = await request(server)
      .get(suggestionsUrl(workspaceBId))
      .set('Cookie', cookieB);
    expect(listResponseB.status).toBe(200);
    const { suggestions } = listResponseB.body as SuggestionListEnvelope;
    expect(suggestions.some((s) => s.id === created?.id)).toBe(false);
  });

  it('14. a second decide() on an already-decided suggestion -> 409', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const analyzeResponse = await request(server)
      .post(analyzeUrl(workspaceId))
      .set('Cookie', cookie);
    expect(analyzeResponse.status).toBe(201);
    const [created] = (analyzeResponse.body as SuggestionListEnvelope).suggestions;

    const firstDecide = await request(server)
      .post(decideUrl(workspaceId, created?.id ?? ''))
      .set('Cookie', cookie)
      .send({ decision: 'reject' });
    expect(firstDecide.status).toBe(200);

    const secondDecide = await request(server)
      .post(decideUrl(workspaceId, created?.id ?? ''))
      .set('Cookie', cookie)
      .send({ decision: 'approve' });
    expect(secondDecide.status).toBe(409);
  });
});
