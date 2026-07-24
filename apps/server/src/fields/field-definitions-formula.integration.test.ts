import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T4 PR-B (RED step) — formula field DEFINITION, wired end-to-end through
 * the existing `POST`/`PATCH .../fields` HTTP surface
 * (`FieldDefinitionsService`/`FieldsController`). Same Testcontainers
 * Postgres 16 + Redis 7 pair, same dynamic `import('../app.module.js')` AFTER
 * `DATABASE_URL`/`REDIS_URL` are set, same `toCookieHeader` helper copied
 * verbatim, same `registerUser`/`createWorkspace`/`addMemberWithRole`
 * conventions as `./field-definitions.integration.test.ts` (that file is left
 * untouched — everything needed is duplicated here rather than imported, per
 * this codebase's established convention of each integration test file being
 * self-contained).
 *
 * This file does NOT re-test the generic define/update/archive/list CRUD
 * mechanics already covered by `field-definitions.integration.test.ts` (admin
 * gating, 404/409 scoping, non-formula validation, etc.) — only the
 * FORMULA-SPECIFIC rules F1-T4 adds on top of that existing surface.
 *
 * ============================================================================
 * RED STATE (expected, today): TWO separate gaps, stacked:
 *
 *   1. `apps/server/src/fields/dto/define-field.schema.ts`'s own hardcoded
 *      `FIELD_TYPES` array (used to build `defineFieldSchema`'s
 *      `fieldType: z.enum(FIELD_TYPES)`) still lists only the ORIGINAL 12
 *      field types — `'formula'` is missing from it entirely. This means
 *      EVERY request below with `fieldType: 'formula'` is rejected at the
 *      DTO/`ZodValidationPipe` boundary with a 400, before the request ever
 *      reaches `FieldDefinitionsService` or the domain layer at all. This is
 *      the FIRST blocker, and it means the tests below that expect 400
 *      (unknown-reference, defaultValue, edit-permission, invalid-syntax,
 *      cycle) will very likely already "pass" today, but for the WRONG
 *      reason (a DTO enum miss, not the real domain rule being exercised) —
 *      that is still a valid red signal (nothing here is genuinely wired
 *      yet), but `implementer` must not mistake a coincidentally-green
 *      assertion for these actually being enforced correctly; re-verify them
 *      once gap 2 below is also closed.
 *   2. `packages/core-objects`'s `defineField`/`updateField` already support
 *      an optional 3rd `existingFieldDefinitions` parameter (PR-A2, already
 *      merged/tested in
 *      `packages/core-objects/src/fields/field-commands-formula.test.ts`),
 *      but `FieldDefinitionsService.define`/`.update`
 *      (`./field-definitions.service.ts`) still call them with only the old
 *      1-2 args — no `existingFieldDefinitions` is ever fetched or passed.
 *      Once gap 1 is closed, a `formula` field with a syntactically valid
 *      expression referencing an ALREADY-DEFINED plain field will still
 *      incorrectly 400 ("formula references an unknown field") because the
 *      server passes `existingFieldDefinitions = []` (the parameter's own
 *      default) instead of the real, current set of field definitions for
 *      this workspace+objectType — so EVERY reference looks unknown, even a
 *      real one. The "reject a cycle-closing update" and "accept a valid
 *      non-cyclic update" tests below fail here even after gap 1 is fixed,
 *      because `X`/`Z`'s own definition (referencing `price`) is rejected as
 *      "unknown field" before the test can even reach the update step.
 *
 * `implementer` must (a) add `'formula'` to `define-field.schema.ts`'s
 * `FIELD_TYPES` array, and (b) make `FieldDefinitionsService.define`/`.update`
 * fetch this workspace+objectType's current field definitions (the same
 * query shape as `FieldDefinitionsService.list`, minus its `canViewField`
 * role filter — schema/cycle validation is not role-scoped) and pass them as
 * the 3rd argument to `defineField`/`updateField`, to turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `POST`/`PATCH .../fields` now accept `fieldType: 'formula'` with
 * `config: { expression: string }` (no `defaultValue`; `permissions` must
 * have no `'edit'` anywhere) -> 201/200.
 *
 * Rejections (400, `ValidationError`):
 *   - `config.expression` references a `{fieldKey}` that has no matching
 *     OTHER field definition already defined for this workspace+objectType.
 *   - an explicit `defaultValue` is supplied for a `formula` field.
 *   - `permissions` grants `'edit'` to ANY role for a `formula` field.
 *   - a syntactically invalid expression.
 *   - a formula-to-formula reference that would close a dependency cycle
 *     (via `PATCH` changing an existing formula's expression to point at a
 *     formula that (transitively) depends on it).
 *
 * A valid, non-cyclic `PATCH` that changes a formula's expression to
 * reference a different, still-acyclic set of fields -> 200.
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
  workspaceId: string;
  objectType: string;
  key: string;
  label: string;
  fieldType: string;
  config: unknown;
  defaultValue?: unknown;
  permissions: FieldPermissionsBody;
  lifecycle: string;
  createdAt: string;
  updatedAt: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

/** See `../auth/tenant-isolation.integration.test.ts` for the full rationale
 * behind this exact helper (copied verbatim, per this codebase's convention). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

/** All 4 roles get `edit` — used for the plain (non-formula) supporting
 * fields a formula expression references. */
const EDIT_ALL_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
};

/** Every role is `view` or `hidden` — never `edit` — the only shape a formula
 * field's own permissions may legally take. */
const FORMULA_VIEW_ONLY_PERMISSIONS: FieldPermissionsBody = {
  owner: 'view',
  admin: 'view',
  member: 'view',
  guest: 'hidden',
};

/** Grants `edit` to `owner` — used to prove a formula field must reject this,
 * regardless of which single role carries it. */
const FORMULA_WITH_EDIT_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'view',
  member: 'view',
  guest: 'hidden',
};

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `formula-fields-test-user-${String(emailCounter)}@example.com`;
}

describe('Formula field DEFINITIONS (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  async function registerAdminWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Formula Fields Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  function fieldsUrl(workspaceId: string, objectType: string): string {
    return `/workspaces/${workspaceId}/object-types/${objectType}/fields`;
  }

  function defineField(
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
  ): request.Test {
    return request(server)
      .post(fieldsUrl(workspaceId, objectType))
      .set('Cookie', cookie)
      .send(body);
  }

  function patchField(
    cookie: string,
    workspaceId: string,
    objectType: string,
    fieldDefinitionId: string,
    body: {
      label?: string;
      config?: unknown;
      defaultValue?: unknown;
      permissions?: FieldPermissionsBody;
    },
  ): request.Test {
    return request(server)
      .patch(`${fieldsUrl(workspaceId, objectType)}/${fieldDefinitionId}`)
      .set('Cookie', cookie)
      .send(body);
  }

  it('defines a formula field with a valid expression referencing an already-defined field, no defaultValue, view-only permissions -> 201', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const priceResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    expect(priceResponse.status).toBe(201);

    const formulaResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'doubledPrice',
      label: 'Doubled Price',
      fieldType: 'formula',
      config: { expression: '{price} * 2' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    expect(formulaResponse.status).toBe(201);

    const { fieldDefinition } = formulaResponse.body as FieldDefinitionEnvelope;
    expect(fieldDefinition.fieldType).toBe('formula');
    expect(fieldDefinition.lifecycle).toBe('active');
    expect((fieldDefinition.config as { expression: string }).expression).toBe('{price} * 2');
    expect(fieldDefinition.defaultValue).toBeUndefined();
  });

  it('rejects (400) a formula whose expression references a field key with no matching definition for this workspace+objectType', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await defineField(cookie, workspaceId, 'task', {
      key: 'brokenFormula',
      label: 'Broken Formula',
      fieldType: 'formula',
      config: { expression: '{doesNotExist} + 1' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    expect(response.status).toBe(400);
  });

  it('rejects (400) a formula field with an explicit defaultValue', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const qtyResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'qty',
      label: 'Quantity',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    expect(qtyResponse.status).toBe(201);

    const response = await defineField(cookie, workspaceId, 'task', {
      key: 'qtyFormula',
      label: 'Quantity Formula',
      fieldType: 'formula',
      config: { expression: '{qty} * 1' },
      defaultValue: 5,
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    expect(response.status).toBe(400);
  });

  it('rejects (400) a formula field whose permissions grant "edit" to any role', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const baseResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'baseValue',
      label: 'Base Value',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    expect(baseResponse.status).toBe(201);

    const response = await defineField(cookie, workspaceId, 'task', {
      key: 'editableFormula',
      label: 'Editable Formula (invalid)',
      fieldType: 'formula',
      config: { expression: '{baseValue} + 1' },
      permissions: FORMULA_WITH_EDIT_PERMISSIONS,
    });

    expect(response.status).toBe(400);
  });

  it('rejects (400) a syntactically invalid formula expression', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const baseResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'aValue',
      label: 'A Value',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    expect(baseResponse.status).toBe(201);

    const response = await defineField(cookie, workspaceId, 'task', {
      key: 'invalidSyntax',
      label: 'Invalid Syntax',
      fieldType: 'formula',
      config: { expression: '{aValue} +' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    expect(response.status).toBe(400);
  });

  it('rejects (400) a PATCH that would close a formula-to-formula dependency cycle', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const priceResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    expect(priceResponse.status).toBe(201);

    // Formula X depends only on the plain field `price` — valid, no cycle.
    const xResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'X',
      label: 'X',
      fieldType: 'formula',
      config: { expression: '{price}' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    expect(xResponse.status).toBe(201);
    const xId = (xResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    // Formula Y depends on X — still valid, no cycle (Y -> X -> price).
    const yResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'Y',
      label: 'Y',
      fieldType: 'formula',
      config: { expression: '{X}' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    expect(yResponse.status).toBe(201);

    // Now redirect X's expression to depend on Y instead -- this would close
    // the cycle X -> Y -> X and must be rejected.
    const patchResponse = await patchField(cookie, workspaceId, 'task', xId, {
      config: { expression: '{Y}' },
    });

    expect(patchResponse.status).toBe(400);
  });

  it('accepts (200) a valid, non-cyclic PATCH that changes a formula field to reference a different, still-acyclic set of fields', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const priceResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    expect(priceResponse.status).toBe(201);

    const qtyResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'qty',
      label: 'Quantity',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    expect(qtyResponse.status).toBe(201);

    const zResponse = await defineField(cookie, workspaceId, 'task', {
      key: 'Z',
      label: 'Z',
      fieldType: 'formula',
      config: { expression: '{price}' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    expect(zResponse.status).toBe(201);
    const zId = (zResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    const patchResponse = await patchField(cookie, workspaceId, 'task', zId, {
      config: { expression: '{qty}' },
    });

    expect(patchResponse.status).toBe(200);
    expect((patchResponse.body as FieldDefinitionEnvelope).fieldDefinition.config).toEqual({
      expression: '{qty}',
    });
  });
});
