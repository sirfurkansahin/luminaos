import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CLAUDE_HAIKU_4_5, CLAUDE_SONNET_5, calculateCostUsd } from '@luminaos/ai-gateway';
import type { AIProvider } from '@luminaos/ai-gateway';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { MockInstance } from 'vitest';

/**
 * F1-T5 PR-C (RED step) — server-side AI FIELDS integration: the new
 * `POST .../objects/:objectId/fields/:fieldKey/refresh` route, quota
 * enforcement, direct-write rejection, and the `onSourceChange`
 * debounce-then-refresh cascade (with the "AI kaynaklı değişiklik yeni AI
 * yenilemesi tetiklemez" no-cascade guarantee). Same Testcontainers
 * Postgres 16 + Redis 7 pair, dynamic `import('../app.module.js')` AFTER env
 * vars are set, `toCookieHeader`/`registerUser`/`createWorkspace` conventions
 * as every other integration test file here (self-contained, duplicated
 * rather than imported, per this codebase's established convention).
 *
 * Nothing under test here exists yet:
 *   - `apps/server/src/fields/dto/define-field.schema.ts`'s hardcoded
 *     `FIELD_TYPES` array does not include `'ai'` (mirrors the exact
 *     `'formula'`-was-missing gap `../fields/field-definitions-formula.integration.test.ts`
 *     already documented and turned green) -- every `defineField(...)` helper
 *     call below with `fieldType: 'ai'` 400s at the DTO boundary, before
 *     reaching `FieldDefinitionsService`, let alone the domain layer.
 *   - `POST .../objects/:objectId/fields/:fieldKey/refresh` does not exist
 *     on `ObjectsController` at all -- every `refreshField(...)` call below
 *     404s.
 *   - No `AIProvider` is wired into Nest's DI container at all yet.
 *   - `apps/server/src/db/schema/ai-usage.ts` (the `ai_usage_records` table,
 *     Part 3 below) does not exist -- migrations for it don't exist either.
 *   - `../ai/ai-refresh-scheduler.service.ts` does not exist
 *     (`./ai-refresh-scheduler.service.test.ts` pins its own contract
 *     separately, as a pure unit) -- nothing calls `.schedule(...)` from
 *     `ObjectsService.setFieldValues` yet.
 *   - `../config/env.ts` does not yet read `ANTHROPIC_API_KEY` /
 *     `AI_TOKEN_QUOTA_PER_WORKSPACE` / `AI_REFRESH_DEBOUNCE_MS`
 *     (`../config/env-ai.test.ts` pins that contract separately).
 * `implementer` must build all of the above; every test below is expected to
 * fail (red) until then.
 *
 * ============================================================================
 * DESIGN DECISIONS THIS TEST FILE MAKES EXPLICIT (no other source of truth
 * exists for these yet -- `implementer` must match them precisely):
 *
 * --- 1. The scripted MockProvider response convention ---------------------
 *
 * The running test app's `AIProvider` DI binding MUST resolve to
 * `@luminaos/ai-gateway`'s `MockProvider` (never a real `AnthropicProvider`)
 * because `ANTHROPIC_API_KEY` is never set anywhere in this file -- per
 * `../config/env-ai.test.ts`'s pinned contract, an absent `ANTHROPIC_API_KEY`
 * means `env.anthropicApiKey === undefined`, and THAT is the exact signal the
 * DI wiring (`AiModule`, not written yet) must use to fall back to
 * `MockProvider` instead of constructing a real `AnthropicProvider`.
 *
 * Every test in this file needs a DIFFERENT scripted response from the SAME
 * shared `MockProvider` instance (one Nest app is built once, in `beforeAll`,
 * for the whole file -- rebuilding a fresh app per test/scenario would be
 * needlessly slow and diverge from every other integration test file here).
 * This requires the DI-wired `MockProvider`'s `responder` to be a function of
 * the REQUEST it receives (the RENDERED prompt text, i.e. after
 * `{sourceFieldKey}` placeholders have already been substituted with that
 * object's actual field values), not a fixed canned reply.
 *
 * THE CONVENTION (pinned here; `implementer` must build the DI-wired
 * `MockProvider`'s responder to honor this EXACTLY):
 *
 *   If the rendered prompt text contains the literal substring `"RETURN:"`,
 *   the mock responds with `{ text, usage }` where `text` is EVERY character
 *   from immediately after `"RETURN:"` to the end of the prompt string (so
 *   every `promptTemplate` used by this file places its `RETURN:<value>`
 *   directive as the FINAL segment of the template, after any
 *   `{sourceFieldKey}` interpolation) -- and `usage` is a FIXED, constant
 *   value on EVERY call, regardless of prompt content:
 *
 *       usage: { inputTokens: 100, outputTokens: 20 }   // 120 tokens/call
 *
 *   A fixed per-call usage (rather than a second mini-DSL segment for
 *   scripting usage too) keeps quota-consumption math simple and
 *   deterministic across every test in this file: every REAL call to
 *   `AIProvider.complete()` -- whether its result is ultimately valid or
 *   invalid -- costs exactly 120 tokens.
 *
 *   If the rendered prompt does NOT contain `"RETURN:"` at all, the mock
 *   THROWS (a deliberate tripwire: every test below always embeds the
 *   marker, so hitting this path means a test or the interpolation logic
 *   itself has a bug, not a legitimate "no marker" scenario).
 *
 * --- 2. Quota is checked ONCE per refresh OPERATION, not per retry attempt -
 *
 * `refreshAIField` may call `AIProvider.complete()` UP TO TWICE for a single
 * refresh operation (once, then once more on retry if `outputType: 'select'`
 * and the first response isn't a valid option -- per the spec's "değilse
 * yeniden dene→#ERROR"). Quota (`env.aiTokenQuotaPerWorkspace`) is checked
 * EXACTLY ONCE, before the FIRST `complete()` call of an operation: if this
 * workspace's cumulative recorded usage (`SUM(inputTokens + outputTokens)`
 * over `ai_usage_records` for this `workspaceId`) is already `>=` the quota,
 * the WHOLE operation is rejected immediately with `QuotaExceededError`
 * (HTTP 429, `error.code === 'QUOTA_EXCEEDED'`) WITHOUT calling the provider
 * at all -- no usage is recorded for a request rejected this way. The retry
 * within an already-started, already-quota-cleared operation NEVER re-checks
 * quota mid-operation. This is why this file uses a SINGLE, very low, SHARED
 * `AI_TOKEN_QUOTA_PER_WORKSPACE` value (`'10'`, far below one call's 120
 * tokens) across every test: every test's FIRST refresh call, in its own
 * freshly-registered workspace, starts at 0 prior usage and is therefore
 * ALWAYS allowed (`0 < 10`) regardless of how many attempts that one
 * operation itself ends up making internally; only a workspace's SECOND
 * separate refresh OPERATION (a second `POST .../refresh` call) is ever
 * blocked, once the first operation's 120 tokens have already been recorded
 * (`120 >= 10`). This is exercised deliberately, and only, by the "Quota
 * rejection" test below.
 *
 * --- 3. AI_REFRESH_DEBOUNCE_MS: making the debounce window testable -------
 *
 * `../ai/ai-refresh-scheduler.service.ts`'s `AIRefreshScheduler` defaults to
 * a real 5-second delay in production. This file sets the NEW
 * `AI_REFRESH_DEBOUNCE_MS` env var (pinned, alongside the other two AI env
 * vars, in `../config/env-ai.test.ts`) to `'50'` before importing
 * `app.module.js`, so `onSourceChange` DI wiring is expected to construct
 * `new AIRefreshScheduler(env.aiRefreshDebounceMs)`. This file then waits a
 * short REAL wall-clock delay (`sleep(...)`, comfortably longer than 50ms)
 * past a source-field write before asserting the cascaded refresh has landed
 * -- this is the simpler of the two options this task's spec offered
 * (env-configurable delay vs. reaching into Nest's DI container for the
 * scheduler instance directly), and is proposed here explicitly for
 * `implementer` to wire.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `POST /workspaces/:workspaceId/objects/:objectId/fields/:fieldKey/refresh`
 * -> `200 { object }`, same guard stack as every other object mutation route
 * (`SessionAuthGuard` + `WorkspaceMembershipGuard`, no extra role gating).
 *
 * `outputType: 'text'` -> the field's value becomes the scripted response
 * text, verbatim.
 *
 * `outputType: 'select'` with a FIRST response that IS one of `options` ->
 * the field's value becomes that option, no retry needed.
 *
 * `outputType: 'select'` with BOTH attempts returning something that is NOT
 * one of `options` -> the field's value becomes
 * `{ aiFieldError: true, message: string }` (an `AIFieldErrorValue`, per
 * `packages/core-objects/src/fields/ai/ai-value.ts`), surfaced verbatim over
 * HTTP at that field's key in `object.fieldValues`.
 *
 * `PATCH .../objects/:objectId/fields` targeting an `ai`-typed field key
 * directly -> some 4xx (mirrors the existing `formula` direct-write
 * rejection already covered exhaustively by
 * `./object-formula-recompute.integration.test.ts`; this file only smoke-tests
 * it once for `ai`).
 *
 * Quota exceeded -> `429`, `error.code === 'QUOTA_EXCEEDED'`.
 *
 * A plain (non-`ai`) source field write, via the ordinary
 * `PATCH .../objects/:objectId/fields` route, schedules (debounced) refreshes
 * for every `onSourceChange` `ai` field that lists it in `sourceFields` --
 * and an `ai` field's OWN system-computed `FieldValueChanged` write (from
 * either a manual `POST .../refresh` or an auto `onSourceChange` cascade)
 * must NEVER itself schedule a further `onSourceChange` refresh for anything
 * that depends on THAT `ai` field ("AI kaynaklı değişiklik yeni AI
 * yenilemesi tetiklemez").
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface FieldDefinitionBody {
  id: string;
  key: string;
  objectType: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface ObjectBody {
  id: string;
  type: string;
  title: string;
  workspaceId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: string;
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

const EDIT_ALL_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
};

/** The only permission shape an `ai` field may legally have -- no role ever
 * gets `'edit'` (mirrors `formula`'s own restriction, per
 * `packages/core-objects/src/fields/field-commands-ai.test.ts`). */
const AI_VIEW_ONLY_PERMISSIONS: FieldPermissionsBody = {
  owner: 'view',
  admin: 'view',
  member: 'view',
  guest: 'hidden',
};

/** Every scripted prompt in this file embeds this directive as the FINAL
 * segment of its `promptTemplate` -- see this file's header, design
 * decision 1, for the full convention `implementer`'s DI-wired
 * `MockProvider` must honor. */
function returnDirective(value: string): string {
  return `RETURN:${value}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * F1-T14 PR3 (RED step) — model routing + cost calculation, wired into the
 * SAME `performAIFieldRefresh` flow this file already exercises end-to-end.
 * Nothing below this comment exists yet on `main`:
 *
 *   performAIFieldRefresh now:
 *     1. Calls selectAIModel({ outputType: config.outputType }) to pick a model.
 *     2. Passes that model into resolveAIFieldValue({ ..., model }).
 *     3. recordAIUsage(workspaceId, fieldDefinitionId, objectId, usage, model) — NEW
 *        5th parameter — computes costUsd = calculateCostUsd(model, usage) and
 *        includes BOTH model and costUsd in the AIUsageRecorded event payload.
 *
 * Until `implementer` builds this, every `ai_usage_records` row inserted by
 * this file's refreshes has `model`/`cost_usd` = NULL (the columns exist,
 * per PR2, merged — only the wiring that POPULATES them is missing), so the
 * new assertions below (on a non-null `model`/`cost_usd`) are expected to
 * fail for that reason, not a missing-column/migration error.
 *
 * `assertAITokenQuotaNotExceeded`'s own SQL (`SUM(input_tokens +
 * output_tokens)`, grouped by `workspace_id`) reads neither `model` nor
 * `cost_usd` at all -- this PR's wiring cannot regress the existing
 * token-quota tests above (`assertAITokenQuotaNotExceeded` and its
 * cost-based successor are explicitly out of scope here, deferred to PR4).
 */

interface RawAIUsageRow {
  model: string | null;
  cost_usd: string | null;
  input_tokens: number;
  output_tokens: number;
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `ai-field-refresh-test-user-${String(emailCounter)}@example.com`;
}

describe('AI field refresh (real Postgres + real HTTP via Testcontainers + supertest, MockProvider-backed)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let aiProvider: AIProvider;
  let completeSpy: MockInstance<AIProvider['complete']>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // Deliberately NOT set -- forces the DI wiring to fall back to
    // MockProvider, per this file's header design decision 1.
    delete process.env.ANTHROPIC_API_KEY;

    // Far below one call's 120 scripted tokens -- see design decision 2.
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = '10';

    // A short real debounce window -- see design decision 3.
    process.env.AI_REFRESH_DEBOUNCE_MS = '50';

    // F1-T14 PR4 (RED step) -- a generous $ budget, deliberately far above
    // anything this file's real MockProvider-backed calls could ever
    // naturally accumulate (a handful of calls at ~$0.0006 each), so it
    // never interferes with any EXISTING test above. The dedicated
    // cost-budget-rejection test below never relies on natural
    // accumulation to exceed it -- it seeds a prior `ai_usage_records` row
    // with a `cost_usd` far above this budget directly via `rawDb`, for
    // its own freshly-registered workspace, so the very FIRST refresh
    // operation in that workspace is rejected before any provider call.
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

    // F1-T14 PR4 (RED step) -- the SAME MockProvider instance the whole app
    // resolves `AI_PROVIDER` to, spied on so cost-budget-rejection tests can
    // assert "the provider's complete() was never invoked for THIS
    // operation" by diffing the spy's call count before/after, rather than
    // asserting a global `toHaveBeenCalledTimes(0)` (other tests in this
    // same file legitimately call it many times, sharing one app instance).
    aiProvider = app.get<AIProvider>(AI_PROVIDER);
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

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `AI Field Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

  function fieldsUrl(workspaceId: string, objectType: string): string {
    return `/workspaces/${workspaceId}/object-types/${objectType}/fields`;
  }

  function objectsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects`;
  }

  async function defineField(
    cookie: string,
    workspaceId: string,
    objectType: string,
    body: {
      key: string;
      label: string;
      fieldType: string;
      config: unknown;
      defaultValue?: unknown;
      permissions: FieldPermissionsBody;
    },
  ): Promise<FieldDefinitionBody> {
    const response = await request(server)
      .post(fieldsUrl(workspaceId, objectType))
      .set('Cookie', cookie)
      .send(body);

    expect(response.status).toBe(201);
    return (response.body as FieldDefinitionEnvelope).fieldDefinition;
  }

  async function createObject(
    cookie: string,
    workspaceId: string,
    objectType: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(objectsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ objectType, title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
  }

  function setFieldValues(
    cookie: string,
    workspaceId: string,
    objectId: string,
    values: Record<string, unknown>,
  ): request.Test {
    return request(server)
      .patch(`${objectsUrl(workspaceId)}/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values });
  }

  function getObject(cookie: string, workspaceId: string, objectId: string): request.Test {
    return request(server)
      .get(`${objectsUrl(workspaceId)}/${objectId}`)
      .set('Cookie', cookie);
  }

  function refreshField(
    cookie: string,
    workspaceId: string,
    objectId: string,
    fieldKey: string,
  ): request.Test {
    return request(server)
      .post(`${objectsUrl(workspaceId)}/${objectId}/fields/${fieldKey}/refresh`)
      .set('Cookie', cookie)
      .send();
  }

  /**
   * Raw SQL (not the Drizzle `aiUsageRecords` schema object) mirroring
   * `../ai/ai-usage.projection.integration.test.ts`'s own `getRawRow`
   * convention -- returns the MOST RECENT `ai_usage_records` row for a given
   * `field_definition_id` (each test below refreshes a field defined fresh
   * for that test, so there is exactly one row per field, except the
   * pre-existing quota test above which never asserts on this helper at
   * all).
   */
  async function getLatestUsageRow(fieldDefinitionId: string): Promise<RawAIUsageRow | undefined> {
    const result = await rawDb.$client.query<RawAIUsageRow>(
      'select model, cost_usd, input_tokens, output_tokens from ai_usage_records where field_definition_id = $1 order by created_at desc limit 1',
      [fieldDefinitionId],
    );
    return result.rows[0];
  }

  /**
   * F1-T14 PR4 (RED step) -- inserts a synthetic `ai_usage_records` row
   * directly via raw SQL (bypassing `performAIFieldRefresh`/`recordAIUsage`
   * entirely) so a workspace's cumulative recorded COST can be pushed above
   * `AI_COST_BUDGET_USD_PER_WORKSPACE` WITHOUT needing any real provider
   * call first -- the whole point of the dedicated rejection test below is
   * proving the cost-budget check runs, and rejects, BEFORE the first
   * provider call of an operation, so accumulating cost via real calls
   * first would defeat the point. `field_definition_id`/`object_id` are
   * plain `varchar` columns with no FK constraint (see
   * `../db/schema/ai-usage.ts`), so any non-empty placeholder string is
   * valid here.
   */
  async function seedPriorUsageCost(workspaceId: string, costUsd: string): Promise<void> {
    await rawDb.$client.query(
      `insert into ai_usage_records
         (id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        randomUUID(),
        workspaceId,
        'seeded-field-definition-id',
        'seeded-object-id',
        0,
        0,
        null,
        costUsd,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Manual refresh, text output
  // -------------------------------------------------------------------------

  it('a manual refresh of a text-output ai field sets the field value to the scripted AI response text', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'notes',
      label: 'Notes',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'summary',
      label: 'Summary',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize: {notes}\n${returnDirective('This is the scripted AI summary.')}`,
        sourceFields: ['notes'],
        outputType: 'text',
        refreshMode: 'manual',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Manual text refresh task');
    await setFieldValues(cookie, workspaceId, created.id, { notes: 'some raw notes' });

    const refreshResponse = await refreshField(cookie, workspaceId, created.id, 'summary');

    expect(refreshResponse.status).toBe(200);
    expect((refreshResponse.body as ObjectEnvelope).object.fieldValues['summary']).toBe(
      'This is the scripted AI summary.',
    );
  });

  // -------------------------------------------------------------------------
  // Manual refresh, select output, valid first response
  // -------------------------------------------------------------------------

  it('a manual refresh of a select-output ai field sets the field value to the scripted response when it IS a valid option', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'description',
      label: 'Description',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    // NOT `'priority'`: workspace creation now auto-seeds a `priority`
    // field for `task` (F1-T10 PR1) — a distinct key avoids a spurious 409
    // conflict with that seeded field.
    await defineField(cookie, workspaceId, 'task', {
      key: 'urgencyLevel',
      label: 'Urgency Level',
      fieldType: 'ai',
      config: {
        promptTemplate: `Classify urgency: {description}\n${returnDirective('medium')}`,
        sourceFields: ['description'],
        outputType: 'select',
        refreshMode: 'manual',
        options: ['low', 'medium', 'high'],
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Manual select refresh task');
    await setFieldValues(cookie, workspaceId, created.id, { description: 'server is on fire' });

    const refreshResponse = await refreshField(cookie, workspaceId, created.id, 'urgencyLevel');

    expect(refreshResponse.status).toBe(200);
    expect((refreshResponse.body as ObjectEnvelope).object.fieldValues['urgencyLevel']).toBe(
      'medium',
    );
  });

  // -------------------------------------------------------------------------
  // Manual refresh, select output, invalid-then-error
  // -------------------------------------------------------------------------

  it('a manual refresh of a select-output ai field whose response is NEVER a valid option (both attempts) results in an AIFieldErrorValue, not a 5xx', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'description2',
      label: 'Description 2',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'category',
      label: 'Category',
      fieldType: 'ai',
      config: {
        // The MockProvider is deterministic per exact rendered prompt (see
        // header, design decision 1) -- since retry sends the SAME rendered
        // prompt again, BOTH attempts return this same out-of-options text.
        promptTemplate: `Classify: {description2}\n${returnDirective('invalid-response')}`,
        sourceFields: ['description2'],
        outputType: 'select',
        refreshMode: 'manual',
        options: ['low', 'medium', 'high'],
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Retry-then-error task');
    await setFieldValues(cookie, workspaceId, created.id, { description2: 'ambiguous input' });

    const refreshResponse = await refreshField(cookie, workspaceId, created.id, 'category');

    expect(refreshResponse.status).toBe(200);
    const fieldValue = (refreshResponse.body as ObjectEnvelope).object.fieldValues['category'];

    expect(fieldValue).toMatchObject({ aiFieldError: true });
    expect(typeof (fieldValue as { message: unknown }).message).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Direct-write rejection
  // -------------------------------------------------------------------------

  it('attempting to PATCH an ai-typed field directly (via the normal setFieldValues route) is rejected (some 4xx, never a 2xx)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'sourceText',
      label: 'Source Text',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'computedSummary',
      label: 'Computed Summary',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize: {sourceText}\n${returnDirective('irrelevant')}`,
        sourceFields: ['sourceText'],
        outputType: 'text',
        refreshMode: 'manual',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Direct-write rejection task');

    const response = await setFieldValues(cookie, workspaceId, created.id, {
      computedSummary: 'manually typed value, should never be accepted',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    const getResponse = await getObject(cookie, workspaceId, created.id);
    expect((getResponse.body as ObjectEnvelope).object.fieldValues['computedSummary']).not.toBe(
      'manually typed value, should never be accepted',
    );
  });

  // -------------------------------------------------------------------------
  // Quota rejection
  // -------------------------------------------------------------------------

  it('a SECOND refresh operation in the same workspace, after the first has already consumed the (tiny, shared) quota, is rejected with 429 QUOTA_EXCEEDED', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'quotaSource',
      label: 'Quota Source',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'quotaField',
      label: 'Quota Field',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize: {quotaSource}\n${returnDirective('first call response')}`,
        sourceFields: ['quotaSource'],
        outputType: 'text',
        refreshMode: 'manual',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Quota rejection task');
    await setFieldValues(cookie, workspaceId, created.id, { quotaSource: 'anything' });

    // First operation: this workspace's prior cumulative usage is 0, which is
    // below the shared quota of 10 -- always allowed, per design decision 2.
    const firstRefresh = await refreshField(cookie, workspaceId, created.id, 'quotaField');
    expect(firstRefresh.status).toBe(200);
    expect((firstRefresh.body as ObjectEnvelope).object.fieldValues['quotaField']).toBe(
      'first call response',
    );

    // Second operation: prior cumulative usage is now 120 (this file's fixed
    // per-call mock usage) >= the quota of 10 -- rejected before any provider
    // call.
    const secondRefresh = await refreshField(cookie, workspaceId, created.id, 'quotaField');

    expect(secondRefresh.status).toBe(429);
    expect((secondRefresh.body as ApiErrorEnvelope).error.code).toBe('QUOTA_EXCEEDED');
  });

  // -------------------------------------------------------------------------
  // Quota rejection under CONCURRENCY (security review finding, F1-T5 PR-C):
  // the quota check must not have a TOCTOU race that lets two simultaneous
  // refresh operations both read the same (0) prior usage and both proceed.
  // -------------------------------------------------------------------------

  it('two CONCURRENT refresh operations in the same freshly-created workspace never BOTH succeed -- exactly one succeeds and the other is rejected with 429 QUOTA_EXCEEDED, even though both start from the same (0) prior usage', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'concurrentSource',
      label: 'Concurrent Source',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'concurrentField',
      label: 'Concurrent Field',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize: {concurrentSource}\n${returnDirective('concurrent response')}`,
        sourceFields: ['concurrentSource'],
        outputType: 'text',
        refreshMode: 'manual',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Concurrent refresh task');
    await setFieldValues(cookie, workspaceId, created.id, { concurrentSource: 'anything' });

    // Both requests are fired truly concurrently, targeting the SAME
    // workspace's SAME (tiny, shared) quota of 10, both starting from a
    // prior usage of 0 -- without a serializing lock around the
    // check-then-record critical section, both could read 0 before either
    // records its 120 tokens of usage, and both would incorrectly succeed,
    // letting this workspace's actual spend silently exceed the quota.
    const [first, second] = await Promise.all([
      refreshField(cookie, workspaceId, created.id, 'concurrentField'),
      refreshField(cookie, workspaceId, created.id, 'concurrentField'),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);

    const rejected = first.status === 429 ? first : second;
    expect((rejected.body as ApiErrorEnvelope).error.code).toBe('QUOTA_EXCEEDED');
  });

  // -------------------------------------------------------------------------
  // onSourceChange debounce + AI-to-AI non-cascade
  // -------------------------------------------------------------------------

  it("changing a plain source field debounces then auto-refreshes an onSourceChange ai field, but that ai field's OWN system-computed write does NOT itself cascade into a further onSourceChange refresh of a field depending on IT", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'summary',
      label: 'Summary',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize this price: {price}\n${returnDirective('auto-generated summary for price change')}`,
        sourceFields: ['price'],
        outputType: 'text',
        refreshMode: 'onSourceChange',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'summaryOfSummary',
      label: 'Summary Of Summary',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize this summary: {summary}\n${returnDirective('should-never-appear')}`,
        sourceFields: ['summary'],
        outputType: 'text',
        refreshMode: 'onSourceChange',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'onSourceChange cascade task');

    // Sanity: neither ai field has ever been computed yet.
    const beforeResponse = await getObject(cookie, workspaceId, created.id);
    expect((beforeResponse.body as ObjectEnvelope).object.fieldValues['summary']).toBeUndefined();
    expect(
      (beforeResponse.body as ObjectEnvelope).object.fieldValues['summaryOfSummary'],
    ).toBeUndefined();

    // Trigger: a plain-field write via the ordinary setFieldValues route.
    const patchResponse = await setFieldValues(cookie, workspaceId, created.id, { price: 42 });
    expect(patchResponse.status).toBe(200);

    // Past the debounce window (AI_REFRESH_DEBOUNCE_MS=50 for this app,
    // comfortable real-time buffer for the HTTP roundtrip + MockProvider's
    // near-instant resolution).
    await sleep(500);

    const afterCascadeResponse = await getObject(cookie, workspaceId, created.id);
    expect((afterCascadeResponse.body as ObjectEnvelope).object.fieldValues['summary']).toBe(
      'auto-generated summary for price change',
    );

    // Critical assertion: `summary`'s own system-computed FieldValueChanged
    // write must NOT itself have scheduled a debounced refresh for
    // `summaryOfSummary`, even though `summaryOfSummary.sourceFields`
    // includes `'summary'` and `refreshMode: 'onSourceChange'`. Waiting a
    // FURTHER debounce window (past when any such -- incorrect -- cascade
    // would have fired) and still finding it unset is exactly the "AI
    // kaynaklı değişiklik yeni AI yenilemesi tetiklemez" acceptance
    // criterion, proven end-to-end over real HTTP.
    await sleep(500);

    const finalResponse = await getObject(cookie, workspaceId, created.id);
    expect(
      (finalResponse.body as ObjectEnvelope).object.fieldValues['summaryOfSummary'],
    ).toBeUndefined();
  }, 15_000);

  // -------------------------------------------------------------------------
  // F1-T14 PR3 — model routing + cost calculation wired into the refresh flow
  // -------------------------------------------------------------------------

  it("a text-output ai field refresh's ai_usage_records row records model = CLAUDE_SONNET_5 and a cost_usd matching calculateCostUsd for that model + the actual recorded usage", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'costTextSource',
      label: 'Cost Text Source',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    const summaryField = await defineField(cookie, workspaceId, 'task', {
      key: 'costTextSummary',
      label: 'Cost Text Summary',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize: {costTextSource}\n${returnDirective('text model routing response')}`,
        sourceFields: ['costTextSource'],
        outputType: 'text',
        refreshMode: 'manual',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Cost text-output task');
    await setFieldValues(cookie, workspaceId, created.id, { costTextSource: 'anything' });

    const refreshResponse = await refreshField(cookie, workspaceId, created.id, 'costTextSummary');
    expect(refreshResponse.status).toBe(200);

    const row = await getLatestUsageRow(summaryField.id);
    expect(row).toBeDefined();
    expect(row?.model).toBe(CLAUDE_SONNET_5);
    expect(row?.cost_usd).not.toBeNull();

    // This file's fixed per-call scripted usage (see header, design decision
    // 1): every real provider call costs exactly 100 input / 20 output
    // tokens -- one call for a text-output field (no retry path).
    const expectedCost = calculateCostUsd(CLAUDE_SONNET_5, {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
    });
    expect(Number(row?.cost_usd)).toBeCloseTo(expectedCost, 6);
  });

  it("a select-output ai field refresh's ai_usage_records row records model = CLAUDE_HAIKU_4_5 (the real Haiku model id) and a cost_usd computed from THAT model's (cheaper) pricing table entry, not Sonnet's", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'costSelectSource',
      label: 'Cost Select Source',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    const urgencyField = await defineField(cookie, workspaceId, 'task', {
      key: 'costUrgency',
      label: 'Cost Urgency',
      fieldType: 'ai',
      config: {
        promptTemplate: `Classify urgency: {costSelectSource}\n${returnDirective('medium')}`,
        sourceFields: ['costSelectSource'],
        outputType: 'select',
        refreshMode: 'manual',
        options: ['low', 'medium', 'high'],
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Cost select-output task');
    await setFieldValues(cookie, workspaceId, created.id, {
      costSelectSource: 'server is on fire',
    });

    const refreshResponse = await refreshField(cookie, workspaceId, created.id, 'costUrgency');
    expect(refreshResponse.status).toBe(200);
    expect((refreshResponse.body as ObjectEnvelope).object.fieldValues['costUrgency']).toBe(
      'medium',
    );

    const row = await getLatestUsageRow(urgencyField.id);
    expect(row).toBeDefined();
    expect(row?.model).toBe(CLAUDE_HAIKU_4_5);
    expect(row?.model).not.toBe(CLAUDE_SONNET_5);
    expect(row?.cost_usd).not.toBeNull();

    // Proves the RIGHT pricing table entry was used: computing the cost
    // against Sonnet's (more expensive) rates must NOT match this row's
    // persisted cost_usd, only Haiku's does.
    const usage = { inputTokens: row?.input_tokens ?? 0, outputTokens: row?.output_tokens ?? 0 };
    const expectedHaikuCost = calculateCostUsd(CLAUDE_HAIKU_4_5, usage);
    const sonnetCostForSameUsage = calculateCostUsd(CLAUDE_SONNET_5, usage);

    expect(Number(row?.cost_usd)).toBeCloseTo(expectedHaikuCost, 6);
    expect(expectedHaikuCost).not.toBeCloseTo(sonnetCostForSameUsage, 6);
  });

  // -------------------------------------------------------------------------
  // F1-T14 PR4 (RED step) — the $ cost-budget quota, alongside the existing
  // token-count quota. Nothing under test in this section exists yet:
  // `assertAICostBudgetNotExceeded` (or equivalent) is not wired into
  // `performAIFieldRefresh` at all, and `env.aiCostBudgetUsdPerWorkspace`
  // does not exist on `Env` yet (see `../config/env-ai.test.ts`'s own RED
  // contract for that field) -- every test below is expected to fail until
  // `implementer` builds both.
  // -------------------------------------------------------------------------

  it('a refresh operation whose workspace has ALREADY recorded cumulative cost above AI_COST_BUDGET_USD_PER_WORKSPACE is rejected with 429 QUOTA_EXCEEDED BEFORE calling the provider at all', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'costBudgetSource',
      label: 'Cost Budget Source',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'costBudgetField',
      label: 'Cost Budget Field',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize: {costBudgetSource}\n${returnDirective('should never be reached')}`,
        sourceFields: ['costBudgetSource'],
        outputType: 'text',
        refreshMode: 'manual',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Cost budget rejection task');
    await setFieldValues(cookie, workspaceId, created.id, { costBudgetSource: 'anything' });

    // Seeded FAR above this file's shared AI_COST_BUDGET_USD_PER_WORKSPACE
    // ('10') -- this workspace's cumulative recorded cost is already over
    // budget before the very FIRST refresh operation of this test even
    // starts, so the rejection must happen without ever calling the
    // provider (unlike the token-quota test above, which needs a SECOND
    // operation to observe the rejection).
    await seedPriorUsageCost(workspaceId, '20.000000');

    const callsBefore = completeSpy.mock.calls.length;

    const refreshResponse = await refreshField(cookie, workspaceId, created.id, 'costBudgetField');

    expect(refreshResponse.status).toBe(429);
    expect((refreshResponse.body as ApiErrorEnvelope).error.code).toBe('QUOTA_EXCEEDED');

    // The provider must never have been invoked for this operation -- the
    // cost-budget check runs BEFORE the first provider call, per
    // `performAIFieldRefresh`'s existing "quota checked once, before any
    // provider call" design (mirrors `assertAITokenQuotaNotExceeded`'s own
    // placement).
    expect(completeSpy.mock.calls.length).toBe(callsBefore);
  });

  it('a refresh operation in a workspace whose cumulative recorded cost is comfortably BELOW AI_COST_BUDGET_USD_PER_WORKSPACE succeeds normally, unaffected by the cost-budget check', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'costBudgetOkSource',
      label: 'Cost Budget OK Source',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'costBudgetOkField',
      label: 'Cost Budget OK Field',
      fieldType: 'ai',
      config: {
        promptTemplate: `Summarize: {costBudgetOkSource}\n${returnDirective('within budget response')}`,
        sourceFields: ['costBudgetOkSource'],
        outputType: 'text',
        refreshMode: 'manual',
      },
      permissions: AI_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Cost budget happy-path task');
    await setFieldValues(cookie, workspaceId, created.id, { costBudgetOkSource: 'anything' });

    // No seeded prior usage at all -- this freshly-registered workspace's
    // cumulative recorded cost starts at 0, far below the shared $10
    // budget, so this single refresh operation must succeed exactly as it
    // would have before this PR's cost-budget check existed.
    const refreshResponse = await refreshField(
      cookie,
      workspaceId,
      created.id,
      'costBudgetOkField',
    );

    expect(refreshResponse.status).toBe(200);
    expect((refreshResponse.body as ObjectEnvelope).object.fieldValues['costBudgetOkField']).toBe(
      'within budget response',
    );
  });
});
