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
 * F1-T6 PR-D — EXHAUSTIVE per-field-type query/filter coverage for the 8
 * `FieldType`s NOT already covered by `object-query.integration.test.ts`'s
 * own 6-type coverage (`text`, `number`, `date`, `select`, `checkbox`,
 * `formula`): `longText`, `url`, `email`, `datetime`, `multiSelect`,
 * `people`, `currency`, `ai`. Per the F1-T6 spec's own acceptance criterion:
 * "Her alan tipi için en az 2 geçerli filtre senaryosu + 1 geçersiz operatör
 * reddi testli."
 *
 * ============================================================================
 * GREEN, NOT RED: unlike most integration test files in this codebase, the
 * feature under test here (`POST /workspaces/:workspaceId/objects/query`,
 * `ObjectsService.query`, `apps/server/src/objects/query-builder.ts`,
 * `packages/core-objects/src/fields/query/filter-operators.ts`) is ALREADY
 * FULLY BUILT and merged (F1-T6 PR-A/B/C, this same branch). This file adds
 * the missing PROOF the task's own acceptance criterion requires for the 8
 * field types PR-C's own test file didn't yet exercise -- every test below is
 * expected to be GREEN today. If any test here is red, that is a genuine gap
 * in the already-merged PR-A/B/C implementation (e.g. a mismatch between
 * `filter-operators.ts`'s own operator table and `query-builder.ts`'s actual
 * predicate behavior for that type) -- report it, do not weaken the
 * assertion to force green.
 *
 * Same Testcontainers Postgres 16 + Redis 7 pair,
 * `import('../app.module.js')`-after-env-vars, and helper-duplication
 * convention as `object-query.integration.test.ts` / every other integration
 * test file here (this repo's established per-file duplication convention,
 * not shared imports).
 *
 * The two `ai`-field sub-cases (text/select `outputType`) exercise the REAL
 * `POST .../objects/:objectId/fields/:fieldKey/refresh` endpoint (backed by
 * `@luminaos/ai-gateway`'s `MockProvider`, since `ANTHROPIC_API_KEY` is never
 * set in this file -- same fallback convention as
 * `object-ai-refresh.integration.test.ts`), rather than writing the field's
 * value out-of-band -- an `ai`-typed field can never be set directly via
 * `PATCH .../objects/:objectId/fields` (`ObjectsService.setFieldValues`
 * rejects it exactly like `formula`), so a real refresh call is the only
 * legitimate way to get a real, distinctly-valued `ai` field into
 * `objects_view` for this query-layer test to filter on. Each `ai` field's
 * `promptTemplate` places its one `sourceFields` placeholder BOTH before and
 * after the `RETURN:` marker (e.g. `RETURN:{sourceNotes}`) so the mock's
 * scripted echo reflects that object's OWN source value, letting three
 * objects refresh the SAME `ai` field definition to three DISTINCT,
 * query-testable values.
 * ============================================================================
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

interface QueryFlatEnvelope {
  objects: ObjectBody[];
  nextCursor?: string;
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
 * `object-ai-refresh.integration.test.ts` / `field-commands-ai.test.ts`). */
const AI_VIEW_ONLY_PERMISSIONS: FieldPermissionsBody = {
  owner: 'view',
  admin: 'view',
  member: 'view',
  guest: 'hidden',
};

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `object-query-remaining-types-test-user-${String(emailCounter)}@example.com`;
}

describe('Lumina Object query endpoint: remaining 8 field types (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // Deliberately NOT set -- forces the `ai` field DI wiring to fall back to
    // `MockProvider`, per `object-ai-refresh.integration.test.ts`'s own
    // established convention.
    delete process.env.ANTHROPIC_API_KEY;

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the
    // established convention in every other integration test file here.
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

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Remaining Types Query Workspace ${String(emailCounter)}`,
    );
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

  async function setFieldValues(
    cookie: string,
    workspaceId: string,
    objectId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const response = await request(server)
      .patch(`${objectsUrl(workspaceId)}/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values });

    expect(response.status).toBe(200);
  }

  async function refreshField(
    cookie: string,
    workspaceId: string,
    objectId: string,
    fieldKey: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(`${objectsUrl(workspaceId)}/${objectId}/fields/${fieldKey}/refresh`)
      .set('Cookie', cookie)
      .send();

    expect(response.status).toBe(200);
    return (response.body as ObjectEnvelope).object;
  }

  function queryObjects(
    cookie: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(server)
      .post(`${objectsUrl(workspaceId)}/query`)
      .set('Cookie', cookie)
      .send(body);
  }

  function expectValidationError(response: request.Response): void {
    expect(response.status).toBe(400);
    expect((response.body as ApiErrorEnvelope).error.code).toBe('VALIDATION_ERROR');
  }

  // ===========================================================================
  // longText
  // ===========================================================================

  describe('filtering behavior: longText field ("longNotes")', () => {
    it('"contains" matches only rows containing the substring, across 3 distinct long-text values', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'longNotes',
        label: 'Long Notes',
        fieldType: 'longText',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const alpha = await createObject(cookie, workspaceId, 'task', 'Alpha task');
      await setFieldValues(cookie, workspaceId, alpha.id, {
        longNotes:
          'This entry contains a long paragraph about apples and their many varieties across the world.',
      });

      const banana = await createObject(cookie, workspaceId, 'task', 'Banana task');
      await setFieldValues(cookie, workspaceId, banana.id, {
        longNotes: 'This entry is entirely about banana bread recipes and baking tips.',
      });

      const cherry = await createObject(cookie, workspaceId, 'task', 'Cherry task');
      await setFieldValues(cookie, workspaceId, cherry.id, {
        longNotes:
          'A detailed essay about cherries, apples, and other stone fruits grown in orchards.',
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'longNotes', operator: 'contains', value: 'apples' }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort();
      expect(ids).toEqual([alpha.id, cherry.id].sort());
    });

    it('"equals" matches only an exact match', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'longNotes',
        label: 'Long Notes',
        fieldType: 'longText',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const exact = await createObject(cookie, workspaceId, 'task', 'Exact task');
      await setFieldValues(cookie, workspaceId, exact.id, {
        longNotes: 'Exact long text value for the equals test.',
      });

      const other = await createObject(cookie, workspaceId, 'task', 'Other task');
      await setFieldValues(cookie, workspaceId, other.id, {
        longNotes: 'Exact long text value for the equals test, plus extra words.',
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [
          {
            field: 'longNotes',
            operator: 'equals',
            value: 'Exact long text value for the equals test.',
          },
        ],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id);
      expect(ids).toEqual([exact.id]);
    });

    it('"gt" on a longText field -> 400 VALIDATION_ERROR (not in its operator set)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'longNotes',
        label: 'Long Notes',
        fieldType: 'longText',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'longNotes', operator: 'gt', value: 'x' }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // url
  // ===========================================================================

  describe('filtering behavior: url field ("website")', () => {
    it('"equals" matches only an exact URL match', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'website',
        label: 'Website',
        fieldType: 'url',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const alpha = await createObject(cookie, workspaceId, 'task', 'Alpha task');
      await setFieldValues(cookie, workspaceId, alpha.id, { website: 'https://example.com/a' });

      const beta = await createObject(cookie, workspaceId, 'task', 'Beta task');
      await setFieldValues(cookie, workspaceId, beta.id, { website: 'https://example.com/b' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'website', operator: 'equals', value: 'https://example.com/a' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([alpha.id]);
    });

    it('"contains" matches URLs sharing a substring, excluding an unrelated domain', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'website',
        label: 'Website',
        fieldType: 'url',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const alpha = await createObject(cookie, workspaceId, 'task', 'Alpha task');
      await setFieldValues(cookie, workspaceId, alpha.id, { website: 'https://example.com/a' });

      const beta = await createObject(cookie, workspaceId, 'task', 'Beta task');
      await setFieldValues(cookie, workspaceId, beta.id, { website: 'https://example.com/b' });

      const charlie = await createObject(cookie, workspaceId, 'task', 'Charlie task');
      await setFieldValues(cookie, workspaceId, charlie.id, { website: 'https://other.com/a' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'website', operator: 'contains', value: 'example.com' }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort();
      expect(ids).toEqual([alpha.id, beta.id].sort());
    });

    it('"between" on a url field -> 400 VALIDATION_ERROR (not in its operator set)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'website',
        label: 'Website',
        fieldType: 'url',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [
          { field: 'website', operator: 'between', value: ['https://a.com', 'https://b.com'] },
        ],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // email
  // ===========================================================================

  describe('filtering behavior: email field ("contactEmail")', () => {
    it('"equals" matches only an exact address', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'contactEmail',
        label: 'Contact Email',
        fieldType: 'email',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const alice = await createObject(cookie, workspaceId, 'task', 'Alice task');
      await setFieldValues(cookie, workspaceId, alice.id, { contactEmail: 'alice@example.com' });

      const bob = await createObject(cookie, workspaceId, 'task', 'Bob task');
      await setFieldValues(cookie, workspaceId, bob.id, { contactEmail: 'bob@example.com' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'contactEmail', operator: 'equals', value: 'alice@example.com' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([alice.id]);
    });

    it('"contains" matches a common domain substring across multiple addresses', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'contactEmail',
        label: 'Contact Email',
        fieldType: 'email',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const alice = await createObject(cookie, workspaceId, 'task', 'Alice task');
      await setFieldValues(cookie, workspaceId, alice.id, { contactEmail: 'alice@example.com' });

      const bob = await createObject(cookie, workspaceId, 'task', 'Bob task');
      await setFieldValues(cookie, workspaceId, bob.id, { contactEmail: 'bob@example.com' });

      const carol = await createObject(cookie, workspaceId, 'task', 'Carol task');
      await setFieldValues(cookie, workspaceId, carol.id, { contactEmail: 'carol@other.com' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'contactEmail', operator: 'contains', value: '@example.com' }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort();
      expect(ids).toEqual([alice.id, bob.id].sort());
    });

    it('"in" on an email field -> 400 VALIDATION_ERROR (confirmed NOT in TEXT_LIKE_OPERATORS, unlike select)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'contactEmail',
        label: 'Contact Email',
        fieldType: 'email',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'contactEmail', operator: 'in', value: ['alice@example.com'] }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // datetime
  // ===========================================================================

  describe('filtering behavior: datetime field ("startsAt")', () => {
    it('"before"/"after" bound correctly relative to a pivot ISO datetime', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'startsAt',
        label: 'Starts At',
        fieldType: 'datetime',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const early = await createObject(cookie, workspaceId, 'task', 'Early task');
      await setFieldValues(cookie, workspaceId, early.id, {
        startsAt: '2026-01-01T08:00:00.000Z',
      });

      const mid = await createObject(cookie, workspaceId, 'task', 'Mid task');
      await setFieldValues(cookie, workspaceId, mid.id, { startsAt: '2026-02-15T12:30:00.000Z' });

      const late = await createObject(cookie, workspaceId, 'task', 'Late task');
      await setFieldValues(cookie, workspaceId, late.id, { startsAt: '2026-05-01T18:45:00.000Z' });

      const beforeResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'startsAt', operator: 'before', value: '2026-03-01T00:00:00.000Z' }],
      });
      expect(beforeResponse.status).toBe(200);
      expect((beforeResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [early.id, mid.id].sort(),
      );

      const afterResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'startsAt', operator: 'after', value: '2026-03-01T00:00:00.000Z' }],
      });
      expect(afterResponse.status).toBe(200);
      expect((afterResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([late.id]);
    });

    it('"between" is inclusive of both ISO datetime bounds', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'startsAt',
        label: 'Starts At',
        fieldType: 'datetime',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const early = await createObject(cookie, workspaceId, 'task', 'Early task');
      await setFieldValues(cookie, workspaceId, early.id, {
        startsAt: '2026-01-01T08:00:00.000Z',
      });

      const mid = await createObject(cookie, workspaceId, 'task', 'Mid task');
      await setFieldValues(cookie, workspaceId, mid.id, { startsAt: '2026-02-15T12:30:00.000Z' });

      const late = await createObject(cookie, workspaceId, 'task', 'Late task');
      await setFieldValues(cookie, workspaceId, late.id, { startsAt: '2026-05-01T18:45:00.000Z' });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [
          {
            field: 'startsAt',
            operator: 'between',
            value: ['2026-02-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
          },
        ],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([mid.id]);
    });

    it('"contains" on a datetime field -> 400 VALIDATION_ERROR (not in DATE_OPERATORS)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'startsAt',
        label: 'Starts At',
        fieldType: 'datetime',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'startsAt', operator: 'contains', value: '2026' }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // multiSelect
  // ===========================================================================

  describe('filtering behavior: multiSelect field ("tags")', () => {
    it('"in" matches on ANY overlap with the object\'s multiple selected options, not exact-set-equality', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'tags',
        label: 'Tags',
        fieldType: 'multiSelect',
        config: { options: ['red', 'green', 'blue'] },
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const redGreen = await createObject(cookie, workspaceId, 'task', 'Red+green task');
      await setFieldValues(cookie, workspaceId, redGreen.id, { tags: ['red', 'green'] });

      const blueOnly = await createObject(cookie, workspaceId, 'task', 'Blue-only task');
      await setFieldValues(cookie, workspaceId, blueOnly.id, { tags: ['blue'] });

      const greenBlue = await createObject(cookie, workspaceId, 'task', 'Green+blue task');
      await setFieldValues(cookie, workspaceId, greenBlue.id, { tags: ['green', 'blue'] });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'tags', operator: 'in', value: ['green'] }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort();
      // `redGreen` (['red','green']) and `greenBlue` (['green','blue']) both
      // match on the single overlapping 'green' -- neither is an exact-set
      // match against ['green'], proving ANY-overlap semantics.
      expect(ids).toEqual([redGreen.id, greenBlue.id].sort());
      expect(ids).not.toContain(blueOnly.id);
    });

    it('"isEmpty"/"isNotEmpty" partition objects that never had the field set from those that did', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'tags',
        label: 'Tags',
        fieldType: 'multiSelect',
        config: { options: ['red', 'green', 'blue'] },
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const tagged = await createObject(cookie, workspaceId, 'task', 'Tagged task');
      await setFieldValues(cookie, workspaceId, tagged.id, { tags: ['red'] });

      const neverTagged = await createObject(cookie, workspaceId, 'task', 'Never tagged task');

      const isEmptyResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'tags', operator: 'isEmpty' }],
      });
      expect(isEmptyResponse.status).toBe(200);
      expect((isEmptyResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        neverTagged.id,
      ]);

      const isNotEmptyResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'tags', operator: 'isNotEmpty' }],
      });
      expect(isNotEmptyResponse.status).toBe(200);
      expect((isNotEmptyResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        tagged.id,
      ]);
    });

    it('"equals" on a multiSelect field -> 400 VALIDATION_ERROR (confirmed NOT in MULTI_SELECT_OPERATORS)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'tags',
        label: 'Tags',
        fieldType: 'multiSelect',
        config: { options: ['red', 'green', 'blue'] },
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'tags', operator: 'equals', value: 'red' }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // people
  // ===========================================================================

  describe('filtering behavior: people field ("assignees")', () => {
    it('"contains" matches only objects whose people array contains the given id', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'assignees',
        label: 'Assignees',
        fieldType: 'people',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const withUserOne = await createObject(cookie, workspaceId, 'task', 'Assigned to user-1');
      await setFieldValues(cookie, workspaceId, withUserOne.id, {
        assignees: ['user-1', 'user-2'],
      });

      const withUserThree = await createObject(cookie, workspaceId, 'task', 'Assigned to user-3');
      await setFieldValues(cookie, workspaceId, withUserThree.id, { assignees: ['user-3'] });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'assignees', operator: 'contains', value: 'user-1' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        withUserOne.id,
      ]);
    });

    it('"isEmpty"/"isNotEmpty" partition objects that never had the field set from those that did', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'assignees',
        label: 'Assignees',
        fieldType: 'people',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const assigned = await createObject(cookie, workspaceId, 'task', 'Assigned task');
      await setFieldValues(cookie, workspaceId, assigned.id, { assignees: ['user-1'] });

      const unassigned = await createObject(cookie, workspaceId, 'task', 'Unassigned task');

      const isEmptyResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'assignees', operator: 'isEmpty' }],
      });
      expect(isEmptyResponse.status).toBe(200);
      expect((isEmptyResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        unassigned.id,
      ]);

      const isNotEmptyResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'assignees', operator: 'isNotEmpty' }],
      });
      expect(isNotEmptyResponse.status).toBe(200);
      expect((isNotEmptyResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        assigned.id,
      ]);
    });

    it('"gt" on a people field -> 400 VALIDATION_ERROR (not in PEOPLE_OPERATORS)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'assignees',
        label: 'Assignees',
        fieldType: 'people',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'assignees', operator: 'gt', value: 'user-1' }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // currency
  // ===========================================================================

  describe('filtering behavior: currency field ("budget")', () => {
    async function createBudgetedObjects(
      cookie: string,
      workspaceId: string,
    ): Promise<Record<number, ObjectBody>> {
      const byBudget: Record<number, ObjectBody> = {};

      for (const budget of [100, 500, 1000]) {
        const object = await createObject(cookie, workspaceId, 'task', `Budget ${String(budget)}`);
        await setFieldValues(cookie, workspaceId, object.id, { budget });
        byBudget[budget] = object;
      }

      return byBudget;
    }

    it('"gt"/"lt" bound correctly', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'budget',
        label: 'Budget',
        fieldType: 'currency',
        config: { currencyCode: 'USD' },
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const byBudget = await createBudgetedObjects(cookie, workspaceId);

      const gtResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'budget', operator: 'gt', value: 300 }],
      });
      expect(gtResponse.status).toBe(200);
      expect((gtResponse.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [byBudget[500]?.id, byBudget[1000]?.id].sort(),
      );

      const ltResponse = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'budget', operator: 'lt', value: 300 }],
      });
      expect(ltResponse.status).toBe(200);
      expect((ltResponse.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([
        byBudget[100]?.id,
      ]);
    });

    it('"between" is inclusive on both ends', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'budget',
        label: 'Budget',
        fieldType: 'currency',
        config: { currencyCode: 'USD' },
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const byBudget = await createBudgetedObjects(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'budget', operator: 'between', value: [100, 500] }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort()).toEqual(
        [byBudget[100]?.id, byBudget[500]?.id].sort(),
      );
    });

    it('"contains" on a currency field -> 400 VALIDATION_ERROR (not in NUMERIC_OPERATORS)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      await defineField(cookie, workspaceId, 'task', {
        key: 'budget',
        label: 'Budget',
        fieldType: 'currency',
        config: { currencyCode: 'USD' },
        permissions: EDIT_ALL_PERMISSIONS,
      });

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'budget', operator: 'contains', value: '100' }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // ai (text outputType)
  // ===========================================================================

  describe('filtering behavior: ai field, outputType "text" ("aiSummary")', () => {
    async function defineAiTextField(cookie: string, workspaceId: string): Promise<void> {
      await defineField(cookie, workspaceId, 'task', {
        key: 'sourceNotes',
        label: 'Source Notes',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      await defineField(cookie, workspaceId, 'task', {
        key: 'aiSummary',
        label: 'AI Summary',
        fieldType: 'ai',
        config: {
          // The `{sourceNotes}` placeholder appears both before AND after
          // "RETURN:" -- once rendered, MockProvider's scripted echo (every
          // character after the literal "RETURN:" marker) is that object's
          // OWN `sourceNotes` value, letting 3 objects sharing this ONE
          // field definition end up with 3 distinct, query-testable
          // `aiSummary` values.
          promptTemplate: 'Summarize: {sourceNotes}\nRETURN:{sourceNotes}',
          sourceFields: ['sourceNotes'],
          outputType: 'text',
          refreshMode: 'manual',
        },
        permissions: AI_VIEW_ONLY_PERMISSIONS,
      });
    }

    it('"contains" matches only objects whose refreshed ai text contains the substring', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineAiTextField(cookie, workspaceId);

      const alpha = await createObject(cookie, workspaceId, 'task', 'Alpha task');
      await setFieldValues(cookie, workspaceId, alpha.id, {
        sourceNotes: 'Apple pie recipe notes',
      });
      await refreshField(cookie, workspaceId, alpha.id, 'aiSummary');

      const banana = await createObject(cookie, workspaceId, 'task', 'Banana task');
      await setFieldValues(cookie, workspaceId, banana.id, { sourceNotes: 'Banana bread notes' });
      await refreshField(cookie, workspaceId, banana.id, 'aiSummary');

      const cherry = await createObject(cookie, workspaceId, 'task', 'Cherry task');
      await setFieldValues(cookie, workspaceId, cherry.id, { sourceNotes: 'Apple tart guide' });
      await refreshField(cookie, workspaceId, cherry.id, 'aiSummary');

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'aiSummary', operator: 'contains', value: 'Apple' }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort();
      expect(ids).toEqual([alpha.id, cherry.id].sort());
    });

    it('"equals" matches only an exact refreshed ai text value', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineAiTextField(cookie, workspaceId);

      const exact = await createObject(cookie, workspaceId, 'task', 'Exact task');
      await setFieldValues(cookie, workspaceId, exact.id, { sourceNotes: 'Exact summary value' });
      await refreshField(cookie, workspaceId, exact.id, 'aiSummary');

      const other = await createObject(cookie, workspaceId, 'task', 'Other task');
      await setFieldValues(cookie, workspaceId, other.id, {
        sourceNotes: 'Exact summary value plus more',
      });
      await refreshField(cookie, workspaceId, other.id, 'aiSummary');

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'aiSummary', operator: 'equals', value: 'Exact summary value' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([exact.id]);
    });

    it('"in" on a text-output ai field -> 400 VALIDATION_ERROR (same TEXT_LIKE_OPERATORS set as text)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineAiTextField(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'aiSummary', operator: 'in', value: ['x'] }],
      });

      expectValidationError(response);
    });
  });

  // ===========================================================================
  // ai (select outputType)
  // ===========================================================================

  describe('filtering behavior: ai field, outputType "select" ("aiPriority")', () => {
    async function defineAiSelectField(cookie: string, workspaceId: string): Promise<void> {
      await defineField(cookie, workspaceId, 'task', {
        key: 'sourceLabel',
        label: 'Source Label',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });

      await defineField(cookie, workspaceId, 'task', {
        key: 'aiPriority',
        label: 'AI Priority',
        fieldType: 'ai',
        config: {
          // Same "echo the source field" trick as the text-output case
          // above -- `sourceLabel` is always set to exactly one of
          // `options` below, so the mock's echoed response is always a
          // valid option and never needs a retry.
          promptTemplate: 'Classify: {sourceLabel}\nRETURN:{sourceLabel}',
          sourceFields: ['sourceLabel'],
          outputType: 'select',
          refreshMode: 'manual',
          options: ['low', 'medium', 'high'],
        },
        permissions: AI_VIEW_ONLY_PERMISSIONS,
      });
    }

    it('"in" matches any of the listed options', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineAiSelectField(cookie, workspaceId);

      const low = await createObject(cookie, workspaceId, 'task', 'Low task');
      await setFieldValues(cookie, workspaceId, low.id, { sourceLabel: 'low' });
      await refreshField(cookie, workspaceId, low.id, 'aiPriority');

      const medium = await createObject(cookie, workspaceId, 'task', 'Medium task');
      await setFieldValues(cookie, workspaceId, medium.id, { sourceLabel: 'medium' });
      await refreshField(cookie, workspaceId, medium.id, 'aiPriority');

      const high = await createObject(cookie, workspaceId, 'task', 'High task');
      await setFieldValues(cookie, workspaceId, high.id, { sourceLabel: 'high' });
      await refreshField(cookie, workspaceId, high.id, 'aiPriority');

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'aiPriority', operator: 'in', value: ['low', 'medium'] }],
      });

      expect(response.status).toBe(200);
      const ids = (response.body as QueryFlatEnvelope).objects.map((o) => o.id).sort();
      expect(ids).toEqual([low.id, medium.id].sort());
    });

    it('"equals" matches exactly one option', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineAiSelectField(cookie, workspaceId);

      const medium = await createObject(cookie, workspaceId, 'task', 'Medium task');
      await setFieldValues(cookie, workspaceId, medium.id, { sourceLabel: 'medium' });
      await refreshField(cookie, workspaceId, medium.id, 'aiPriority');

      const high = await createObject(cookie, workspaceId, 'task', 'High task');
      await setFieldValues(cookie, workspaceId, high.id, { sourceLabel: 'high' });
      await refreshField(cookie, workspaceId, high.id, 'aiPriority');

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'aiPriority', operator: 'equals', value: 'high' }],
      });

      expect(response.status).toBe(200);
      expect((response.body as QueryFlatEnvelope).objects.map((o) => o.id)).toEqual([high.id]);
    });

    it('"contains" on a select-output ai field -> 400 VALIDATION_ERROR (same SELECT_OPERATORS set as select)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await defineAiSelectField(cookie, workspaceId);

      const response = await queryObjects(cookie, workspaceId, {
        objectType: 'task',
        filters: [{ field: 'aiPriority', operator: 'contains', value: 'high' }],
      });

      expectValidationError(response);
    });
  });
});
