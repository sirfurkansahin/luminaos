import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T10 PR1: real, end-to-end integration test for workspace-CREATION-TIME
 * field seeding — `WorkspacesService.createWorkspace` must, after its
 * workspace+owner-membership transaction commits, seed two `select` custom
 * fields (`status`, `priority`) for the `task` object type via
 * `FieldDefinitionsService.define()` (no new seeding mechanism — this exact
 * existing method, per the plan's PR1 section). Mirrors
 * `../fields/field-definitions.integration.test.ts`'s pattern exactly (same
 * Testcontainers Postgres 16 + Redis 7 pair, same dynamic
 * `import('../app.module.js')` AFTER `DATABASE_URL`/`REDIS_URL` are set,
 * same fixture helpers copied verbatim). Nothing here is mocked.
 *
 * ============================================================================
 * RED STATE (expected, today): `WorkspacesService.createWorkspace`
 * (`./workspaces.service.ts`) only inserts a `workspaces` row and the
 * creator's `owner` `memberships` row inside its transaction — it does not
 * call `FieldDefinitionsService.define()` at all, and `WorkspacesModule`
 * (`./workspaces.module.ts`) does not import `FieldsModule`. Additionally,
 * `field-type-registry.ts`'s `optionsConfigSchema` (as of this writing) still
 * accepts `options: string[]`, not this PR's pinned `{value,label,isDone?}[]`
 * shape (see `packages/core-objects/src/fields/field-type-registry*.test.ts`
 * for that half of PR1's red state) — so even a hand-rolled seed call would
 * currently reject the option objects used below.
 *
 * Concretely, every test below is expected to fail as follows:
 * - Test 1 and 2: `POST /workspaces` still succeeds (201) — workspace
 *   creation itself is unaffected — but the subsequent
 *   `GET /workspaces/:id/object-types/task/fields` returns an EMPTY
 *   `fieldDefinitions: []`, so `.find((fd) => fd.key === 'status')` etc.
 *   resolve to `undefined` and the assertions on their shape fail with
 *   something like "Cannot read properties of undefined (reading 'options')".
 * - Test 3: the PATCH against a `fieldDefinitionId` that was never created
 *   (because nothing was seeded) fails at the very first assertion, since
 *   `statusField` is `undefined` before the PATCH is even issued.
 *
 * `implementer` must: (a) land PR1's `optionsConfigSchema` shape change in
 * `field-type-registry.ts`, (b) add `FieldsModule` to `WorkspacesModule`'s
 * imports, (c) after `createWorkspace`'s transaction commits, call
 * `FieldDefinitionsService.define()` twice (`status`, `priority`) for the
 * `task` object type, catching/swallowing a `ConflictError` from an already-
 * seeded key per the plan's idempotency note (this file does not exercise
 * that idempotency path directly — see the note at the bottom of this file).
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * On `POST /workspaces` success, TWO `select` field definitions exist for
 * `(workspaceId, 'task')` once seeding has run:
 *
 *   `status`  — 3 options, `value` in `'todo' | 'doing' | 'done'`, Turkish
 *               `label`s "Yapılacak"/"Sürüyor"/"Bitti". `isDone: true` is set
 *               ONLY on the `done`/"Bitti" option; the other two options omit
 *               `isDone` (or it is falsy).
 *   `priority` — 4 options, `value` in
 *               `'low' | 'medium' | 'high' | 'urgent'`, Turkish `label`s
 *               "Düşük"/"Orta"/"Yüksek"/"Acil". No option carries `isDone`.
 *
 * These are ordinary field definitions created through
 * `FieldDefinitionsService.define()` — they are readable via the standard
 * `GET .../fields` route and mutable via the standard
 * `PATCH .../fields/:fieldDefinitionId` route, with no special-casing.
 *
 * The seed is PER-WORKSPACE: two independently created workspaces (even by
 * different users) each get their own `status`/`priority` definitions —
 * seeding is not global/shared across workspaces.
 * ---------------------------------------------------------------------------
 *
 * NOTE ON IDEMPOTENCY: the spec's acceptance criterion also requires "seed
 * ikinci kez çalıştırılırsa yinelenmez (idempotent)". There is currently no
 * HTTP-reachable way to re-trigger seeding for an ALREADY-existing workspace
 * (it only happens once, synchronously inside `createWorkspace`), so that
 * idempotency property is not independently testable at the HTTP layer in
 * this PR — it is exercised at the unit level instead (wherever
 * `FieldDefinitionsService.define`'s existing `ConflictError`/
 * `onConflictDoNothing` swallow path is unit-tested), not invented here via a
 * fake re-trigger endpoint.
 * ---------------------------------------------------------------------------
 *
 * ===========================================================================
 * F1-T10 PR5 ADDITION (reminder fields, spec item 5 / Kabul Kriterleri bullet
 * 4): the SAME `seedTaskFields` seeding mechanism, per the spec's own
 * wording, must ALSO provision `remindAt`/`remindAcknowledged` as two more
 * Custom Fields (not an embedded `LuminaObject` field like `checklist`/
 * `recurrenceRule` from PR2/PR4) — verified directly against
 * `apps/server/src/objects/query-builder.ts` (`isFixedColumnKey`: only
 * `title`/`createdAt`/`updatedAt` are queryable "fixed columns"; there is no
 * mechanism to make an arbitrary embedded field queryable without a new
 * migration/projection change) and
 * `packages/core-objects/src/fields/query/filter-operators.ts`
 * (`DATE_OPERATORS` covers `datetime`'s `before`/`after`/`equals`/`between`/
 * `isEmpty`/`isNotEmpty`; `CHECKBOX_OPERATORS` covers only `equals`) — both
 * exactly what "`remindAt <= now() AND remindAcknowledged = false`" needs,
 * with ZERO new query-layer code. `remindAt`: fieldType `'datetime'`, empty
 * config (per `field-type-registry.ts`'s `emptyConfigSchema`, same as
 * `date`/`checkbox`). `remindAcknowledged`: fieldType `'checkbox'`, empty
 * config, and — UNLIKE `status`/`priority`, which seed with no
 * `defaultValue` — MUST be seeded with `defaultValue: false`. This is a
 * necessary detail this PR is the first to pin down: per
 * `packages/core-objects/src/fields/field-value-commands.ts`'s
 * `applyDefaultFieldValues`, only a field definition with a non-`undefined`
 * `defaultValue` gets an automatic `FieldValueChanged` at object-creation
 * time; without `defaultValue: false` here, a freshly created task's
 * `remindAcknowledged` key would be ABSENT from `field_values` until a
 * caller explicitly writes it, and `query-builder.ts`'s
 * `buildCheckboxPredicate` compiles `equals: false` to
 * `(field_values ->> 'remindAcknowledged')::boolean = false` — which
 * evaluates to SQL `NULL` (never `true`) when the key is absent, silently
 * excluding every task whose reminder was never explicitly acknowledged
 * from the "due reminder" query. That is the exact common-case workflow the
 * spec describes (user sets `remindAt`, never having touched
 * `remindAcknowledged` at all, until they see and dismiss the reminder), so
 * this default is load-bearing, not cosmetic. See
 * `../objects/reminder-query.integration.test.ts` for the end-to-end query
 * proof.
 *
 * RED STATE (expected, today, for the new test below): `seedTaskFields`
 * (`./workspaces.service.ts`) only defines `status`/`priority` — it does not
 * define `remindAt`/`remindAcknowledged` at all, so
 * `GET .../object-types/task/fields` will not contain either key; the new
 * test's `.find((fd) => fd.key === 'remindAt')` /
 * `.find((fd) => fd.key === 'remindAcknowledged')` resolve to `undefined`,
 * and every subsequent assertion on their shape fails with something like
 * "Cannot read properties of undefined (reading 'fieldType')" /
 * "expected undefined to be 'datetime'".
 * ===========================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FieldOptionBody {
  value: string;
  label: string;
  isDone?: boolean;
}

interface FieldDefinitionBody {
  id: string;
  workspaceId: string;
  objectType: string;
  key: string;
  label: string;
  fieldType: string;
  config: { options?: FieldOptionBody[] };
  defaultValue?: unknown;
  lifecycle: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface FieldDefinitionListEnvelope {
  fieldDefinitions: FieldDefinitionBody[];
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

/** See `../auth/tenant-isolation.integration.test.ts` for the full rationale
 * behind this exact helper (copied verbatim, per this task's instructions). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

/** Generates a fresh, never-reused email per call so tests can register
 * independent users without colliding on the `email` unique constraint. */
function freshEmail(): string {
  emailCounter += 1;
  return `workspaces-seed-test-user-${String(emailCounter)}@example.com`;
}

describe('Workspace creation seeds status/priority fields (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per
    // `field-definitions.integration.test.ts`'s established convention.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  /** Registers a brand-new user and returns their session cookie + id. */
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

  /** Creates a workspace as the given (cookie-authenticated) user and
   * returns its id. The creator is always `owner`. */
  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  /** Registers a fresh user + a fresh workspace they own (role: `owner`,
   * which passes the admin-gate), in one call. */
  async function registerAdminWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

  function fieldsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/object-types/task/fields`;
  }

  it('POST /workspaces seeds "status" (3 options, "Bitti" isDone:true, others not) and "priority" (4 options, no isDone) for the "task" object type', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const listResponse = await request(server).get(fieldsUrl(workspaceId)).set('Cookie', cookie);

    expect(listResponse.status).toBe(200);
    const { fieldDefinitions } = listResponse.body as FieldDefinitionListEnvelope;

    const statusField = fieldDefinitions.find((fd) => fd.key === 'status');
    const priorityField = fieldDefinitions.find((fd) => fd.key === 'priority');

    expect(statusField).toBeDefined();
    expect(priorityField).toBeDefined();

    // --- status: 3 options, exactly one isDone:true, labeled "Bitti" ---
    expect(statusField?.fieldType).toBe('select');
    expect(statusField?.objectType).toBe('task');

    const statusOptions = statusField?.config.options ?? [];
    expect(statusOptions).toHaveLength(3);

    const doneOptions = statusOptions.filter((option) => option.isDone === true);
    expect(doneOptions).toHaveLength(1);
    expect(doneOptions[0]?.label).toBe('Bitti');

    const notDoneOptions = statusOptions.filter((option) => option.value !== doneOptions[0]?.value);
    expect(notDoneOptions).toHaveLength(2);
    for (const option of notDoneOptions) {
      expect(option.isDone).toBeFalsy();
    }

    const statusLabels = statusOptions.map((option) => option.label).sort();
    expect(statusLabels).toEqual(['Bitti', 'Sürüyor', 'Yapılacak'].sort());

    // --- priority: 4 options, no isDone anywhere ---
    expect(priorityField?.fieldType).toBe('select');
    expect(priorityField?.objectType).toBe('task');

    const priorityOptions = priorityField?.config.options ?? [];
    expect(priorityOptions).toHaveLength(4);
    for (const option of priorityOptions) {
      expect(option.isDone).toBeFalsy();
    }

    const priorityLabels = priorityOptions.map((option) => option.label).sort();
    expect(priorityLabels).toEqual(['Acil', 'Düşük', 'Orta', 'Yüksek'].sort());
  });

  it('POST /workspaces also seeds "remindAt" (datetime, empty config) and "remindAcknowledged" (checkbox, empty config, defaultValue:false) for the "task" object type (F1-T10 PR5, spec item 5)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const listResponse = await request(server).get(fieldsUrl(workspaceId)).set('Cookie', cookie);

    expect(listResponse.status).toBe(200);
    const { fieldDefinitions } = listResponse.body as FieldDefinitionListEnvelope;

    const remindAtField = fieldDefinitions.find((fd) => fd.key === 'remindAt');
    const remindAcknowledgedField = fieldDefinitions.find((fd) => fd.key === 'remindAcknowledged');

    expect(remindAtField).toBeDefined();
    expect(remindAtField?.fieldType).toBe('datetime');
    expect(remindAtField?.objectType).toBe('task');
    expect(remindAtField?.config).toEqual({});

    expect(remindAcknowledgedField).toBeDefined();
    expect(remindAcknowledgedField?.fieldType).toBe('checkbox');
    expect(remindAcknowledgedField?.objectType).toBe('task');
    expect(remindAcknowledgedField?.config).toEqual({});

    // Load-bearing, not cosmetic -- see this file's header comment
    // ("F1-T10 PR5 ADDITION") and `../objects/reminder-query.integration
    // .test.ts` for the full reasoning: without an explicit
    // `defaultValue: false`, a freshly created task's `remindAcknowledged`
    // key never gets auto-populated by `applyDefaultFieldValues`, and the
    // spec's `remindAcknowledged = false` query leg would silently exclude
    // every never-touched reminder.
    expect(remindAcknowledgedField?.defaultValue).toBe(false);
  });

  it('the seed is per-workspace: a second, independent workspace (different user) gets its own status/priority fields', async () => {
    const first = await registerAdminWithWorkspace();
    const second = await registerAdminWithWorkspace();

    expect(first.workspaceId).not.toBe(second.workspaceId);

    const firstListResponse = await request(server)
      .get(fieldsUrl(first.workspaceId))
      .set('Cookie', first.cookie);
    const secondListResponse = await request(server)
      .get(fieldsUrl(second.workspaceId))
      .set('Cookie', second.cookie);

    expect(firstListResponse.status).toBe(200);
    expect(secondListResponse.status).toBe(200);

    const firstKeys = (firstListResponse.body as FieldDefinitionListEnvelope).fieldDefinitions.map(
      (fd) => fd.key,
    );
    const secondKeys = (
      secondListResponse.body as FieldDefinitionListEnvelope
    ).fieldDefinitions.map((fd) => fd.key);

    expect(firstKeys).toContain('status');
    expect(firstKeys).toContain('priority');
    expect(secondKeys).toContain('status');
    expect(secondKeys).toContain('priority');

    // Sanity: the two workspaces' seeded field definitions are genuinely
    // distinct rows, not the same field visible through both URLs.
    const firstStatusId = (
      firstListResponse.body as FieldDefinitionListEnvelope
    ).fieldDefinitions.find((fd) => fd.key === 'status')?.id;
    const secondStatusId = (
      secondListResponse.body as FieldDefinitionListEnvelope
    ).fieldDefinitions.find((fd) => fd.key === 'status')?.id;

    expect(firstStatusId).toBeDefined();
    expect(secondStatusId).toBeDefined();
    expect(firstStatusId).not.toBe(secondStatusId);
  });

  it('the seeded "status" field is a real, ordinary field definition: the workspace owner can PATCH it via the standard fields route', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const listResponse = await request(server).get(fieldsUrl(workspaceId)).set('Cookie', cookie);
    const statusField = (listResponse.body as FieldDefinitionListEnvelope).fieldDefinitions.find(
      (fd) => fd.key === 'status',
    );

    expect(statusField).toBeDefined();
    expect(statusField?.id).toBeDefined();
    // Narrowed via the assertions above (not a real domain fallback) —
    // `restrict-template-expressions` requires a definite `string` here.
    const statusFieldId = statusField?.id as string;

    const patchResponse = await request(server)
      .patch(`${fieldsUrl(workspaceId)}/${statusFieldId}`)
      .set('Cookie', cookie)
      .send({ label: 'Task Status (renamed by owner)' });

    expect(patchResponse.status).toBe(200);
    expect((patchResponse.body as FieldDefinitionEnvelope).fieldDefinition.label).toBe(
      'Task Status (renamed by owner)',
    );
  });
});
