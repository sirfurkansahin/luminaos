import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T4 PR-C (RED step): column-level AGGREGATIONS over
 * `GET /workspaces/:workspaceId/objects`, wiring the already-tested pure
 * `computeAggregate` (`@luminaos/core-objects`,
 * `packages/core-objects/src/fields/formula/field-aggregations.ts`) into the
 * existing object-listing HTTP endpoint via a NEW `?aggregate=` query
 * parameter. No new route.
 *
 * Same Testcontainers Postgres 16 + Redis 7 pair, dynamic
 * `import('../app.module.js')` AFTER `DATABASE_URL`/`REDIS_URL` are set, and
 * `toCookieHeader`/`addMemberWithRole`-via-raw-DB-insert helpers as
 * `../objects/object-field-values.integration.test.ts` and
 * `../fields/field-definitions-security.integration.test.ts` (both copied
 * verbatim here). Nothing is mocked; everything goes through real HTTP
 * (supertest).
 *
 * ============================================================================
 * RED STATE (expected, today): `ObjectsController.list()` is a bare `@Get()`
 * with NO query-parameter handling at all, and `ObjectsService.list()` has no
 * concept of aggregation. Because NestJS does not validate/reject unknown
 * query parameters by default, every `?aggregate=...` request below is
 * silently IGNORED today rather than 400ing or 404ing — the request succeeds
 * with today's unchanged `{ objects: [...] }` body. So most assertions below
 * are expected to fail with something like:
 *
 *   expect(response.body.aggregates).toBeDefined()
 *   -> AssertionError: expected undefined to be defined
 *
 * i.e. the `aggregates` key is simply missing, NOT a thrown/mapped
 * `AppError`. The four "malformed `aggregate` -> 400" cases are the
 * exception: those are expected to fail with "expected 200 to be 400" (today
 * the malformed string is silently ignored and the request still succeeds),
 * not a 500 or a crash. `implementer` must add a zod schema for `aggregate`
 * (used via `ZodValidationPipe` on `@Query()`, per this codebase's already-
 * generic `ZodValidationPipe<T>`), wire `ObjectsService.list()` to compute
 * `computeAggregate` per requested `fieldKey:fn` pair over the SAME
 * role-filtered `fieldValues` this call already returns, and have
 * `ObjectsController.list()` include an `aggregates` key in its response body
 * only when the query parameter was present at all.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   GET /workspaces/:workspaceId/objects?aggregate=fieldKey1:sum,fieldKey2:avg
 *
 * - `aggregate` is OPTIONAL. Absent -> response body is exactly
 *   `{ objects: [...] }`, with NO `aggregates` key present at all (not
 *   `aggregates: undefined` — the key itself must be omitted, matching this
 *   codebase's `exactOptionalPropertyTypes` convention, e.g.
 *   `FieldsController.toUpdateInput`).
 * - Present -> a comma-separated list of `fieldKey:fn` pairs, `fn` one of the
 *   7 known `AggregateFn` values, CASE-SENSITIVE, exactly as spelled: `sum`,
 *   `avg`, `min`, `max`, `count`, `countUnique`, `countEmpty`.
 * - Response becomes `{ objects, aggregates: Record<string, number|null> }`,
 *   `aggregates` keyed by the EXACT `"fieldKey:fn"` string from the query
 *   (e.g. `{ "price:sum": 150, "price:avg": 37.5 }`) — the same `fieldKey`
 *   can appear multiple times with different `fn`s and get distinguishable
 *   results back.
 * - A malformed `aggregate` string (missing `:`, unknown function name, an
 *   empty segment from a trailing/double comma, or the whole thing being an
 *   empty string) -> 400, via `ZodValidationPipe`'s existing
 *   zod-issue-to-`ValidationError` behavior (`{ error: { code:
 *   'VALIDATION_ERROR', message } }`, per `AppErrorFilter`).
 * - Aggregation is computed IN-MEMORY over the SAME `objects` array this same
 *   call already returns — i.e. AFTER role-based field-value filtering has
 *   already happened. This is a SECURITY-relevant ordering: a role that
 *   cannot view a `hidden` field must not have that field's values leak into
 *   an aggregate either. A `fieldKey` absent from every object's
 *   `fieldValues` (never defined, or filtered out as hidden for the caller)
 *   is NOT a special "unknown fieldKey" error — it naturally produces
 *   `computeAggregate`'s own empty-input result for that function (0 for
 *   `sum`/`count`/`countUnique`/`countEmpty`, `null` for `avg`/`min`/`max`).
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface ObjectBody {
  id: string;
  type: string;
  title: string;
  workspaceId: string;
  fieldValues: Record<string, unknown>;
}

interface ObjectListEnvelope {
  objects: ObjectBody[];
  aggregates?: Record<string, number | null>;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
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

/** `admin` can view (but not edit) the field; `member`/`guest` cannot even
 * view it ("hidden") — used for the security-ordering test: an aggregate
 * computed as a hidden-role caller must not reflect these values at all. */
const HIDDEN_FOR_NON_ADMIN_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'view',
  member: 'hidden',
  guest: 'hidden',
};

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `objects-list-aggregate-test-user-${String(emailCounter)}@example.com`;
}

describe('GET /workspaces/:workspaceId/objects?aggregate=... (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // Imported only after DATABASE_URL/REDIS_URL are set, per the established
    // convention in every other integration test file here.
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
      `Aggregate Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  /** Registers a fresh user, adds them to `workspaceId` with `role` via a
   * raw DB insert (mirrors `field-definitions-security.integration.test.ts`'s
   * exact helper), and returns their session cookie header. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
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
  ): Promise<void> {
    const response = await request(server)
      .post(fieldsUrl(workspaceId, objectType))
      .set('Cookie', cookie)
      .send(body);

    expect(response.status).toBe(201);
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
    return (response.body as { object: ObjectBody }).object;
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

  /** Raw-query-string GET helper: `aggregate` (if given) is appended
   * VERBATIM as `?aggregate=<aggregate>` — deliberately not
   * `.query({ aggregate })`-based, so the malformed-input tests below (empty
   * string, trailing comma, missing colon) can express the EXACT raw query
   * string under test with no hidden encoding surprises. */
  function listObjects(cookie: string, workspaceId: string, aggregate?: string): request.Test {
    const suffix = aggregate === undefined ? '' : `?aggregate=${aggregate}`;
    return request(server)
      .get(`${objectsUrl(workspaceId)}${suffix}`)
      .set('Cookie', cookie);
  }

  /** Sets up one workspace/owner with an active numeric `price` field and
   * four `task` objects: three with `price` set to 10/20/30, one where
   * `price` is never touched (absent from `fieldValues` entirely). */
  async function setupDistinctPriceFixture(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    for (const price of [10, 20, 30]) {
      const object = await createObject(cookie, workspaceId, 'task', `Priced at ${String(price)}`);
      await setFieldValues(cookie, workspaceId, object.id, { price });
    }

    await createObject(cookie, workspaceId, 'task', 'Price never set');

    return { cookie, workspaceId };
  }

  // -------------------------------------------------------------------------
  // Baseline: absent `aggregate` -> unchanged response, no `aggregates` key
  // -------------------------------------------------------------------------

  it('with no `aggregate` query param, the response is unchanged: `{ objects }`, with NO `aggregates` key at all', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await createObject(cookie, workspaceId, 'task', 'Plain object, no aggregation requested');

    const response = await listObjects(cookie, workspaceId);

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).objects.length).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'aggregates')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Per-function correctness (each of the 7 `AggregateFn`s), single fieldKey
  // -------------------------------------------------------------------------

  it('`?aggregate=price:sum` sums only the objects where `price` is present, ignoring the one where it was never set', async () => {
    const { cookie, workspaceId } = await setupDistinctPriceFixture();

    const response = await listObjects(cookie, workspaceId, 'price:sum');

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).aggregates?.['price:sum']).toBe(60);
  });

  it('`?aggregate=price:avg` averages only the PRESENT numeric values (denominator is 3, not 4)', async () => {
    const { cookie, workspaceId } = await setupDistinctPriceFixture();

    const response = await listObjects(cookie, workspaceId, 'price:avg');

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).aggregates?.['price:avg']).toBe(20);
  });

  it('`?aggregate=price:min` returns the smallest set value', async () => {
    const { cookie, workspaceId } = await setupDistinctPriceFixture();

    const response = await listObjects(cookie, workspaceId, 'price:min');

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).aggregates?.['price:min']).toBe(10);
  });

  it('`?aggregate=price:max` returns the largest set value', async () => {
    const { cookie, workspaceId } = await setupDistinctPriceFixture();

    const response = await listObjects(cookie, workspaceId, 'price:max');

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).aggregates?.['price:max']).toBe(30);
  });

  it('`?aggregate=price:count` counts only the objects where `price` is present (3), not the unset one', async () => {
    const { cookie, workspaceId } = await setupDistinctPriceFixture();

    const response = await listObjects(cookie, workspaceId, 'price:count');

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).aggregates?.['price:count']).toBe(3);
  });

  it('`?aggregate=price:countEmpty` counts exactly the one object where `price` was never set', async () => {
    const { cookie, workspaceId } = await setupDistinctPriceFixture();

    const response = await listObjects(cookie, workspaceId, 'price:countEmpty');

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).aggregates?.['price:countEmpty']).toBe(1);
  });

  it('`?aggregate=price:countUnique` counts DISTINCT present values, collapsing duplicates', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    // Two objects share price=10, one has price=20 -> 2 distinct values.
    for (const price of [10, 10, 20]) {
      const object = await createObject(
        cookie,
        workspaceId,
        'task',
        `Dup fixture ${String(price)}`,
      );
      await setFieldValues(cookie, workspaceId, object.id, { price });
    }

    const response = await listObjects(cookie, workspaceId, 'price:countUnique');

    expect(response.status).toBe(200);
    expect((response.body as ObjectListEnvelope).aggregates?.['price:countUnique']).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Multiple aggregate requests in a single call
  // -------------------------------------------------------------------------

  it('`?aggregate=price:sum,price:avg,price:count` returns all three keys, each independently correct, in one response', async () => {
    const { cookie, workspaceId } = await setupDistinctPriceFixture();

    const response = await listObjects(cookie, workspaceId, 'price:sum,price:avg,price:count');

    expect(response.status).toBe(200);
    const aggregates = (response.body as ObjectListEnvelope).aggregates;
    expect(aggregates?.['price:sum']).toBe(60);
    expect(aggregates?.['price:avg']).toBe(20);
    expect(aggregates?.['price:count']).toBe(3);
  });

  it('`?aggregate=price:sum,quantity:sum` computes two DIFFERENT fieldKeys independently in one call', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'quantity',
      label: 'Quantity',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });

    const objectA = await createObject(cookie, workspaceId, 'task', 'Row A');
    await setFieldValues(cookie, workspaceId, objectA.id, { price: 5, quantity: 100 });

    const objectB = await createObject(cookie, workspaceId, 'task', 'Row B');
    await setFieldValues(cookie, workspaceId, objectB.id, { price: 7, quantity: 200 });

    const response = await listObjects(cookie, workspaceId, 'price:sum,quantity:sum');

    expect(response.status).toBe(200);
    const aggregates = (response.body as ObjectListEnvelope).aggregates;
    expect(aggregates?.['price:sum']).toBe(12);
    expect(aggregates?.['quantity:sum']).toBe(300);
  });

  // -------------------------------------------------------------------------
  // Malformed `aggregate` -> 400
  // -------------------------------------------------------------------------

  it('`?aggregate=price` (missing `:fn`) -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await listObjects(cookie, workspaceId, 'price');

    expect(response.status).toBe(400);
  });

  it('`?aggregate=price:bogus` (unknown function name) -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await listObjects(cookie, workspaceId, 'price:bogus');

    expect(response.status).toBe(400);
  });

  it('`?aggregate=` (present but empty string) -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await listObjects(cookie, workspaceId, '');

    expect(response.status).toBe(400);
  });

  it('`?aggregate=price:sum,` (trailing comma producing an empty segment) -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await listObjects(cookie, workspaceId, 'price:sum,');

    expect(response.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Security-relevant ordering: aggregation happens AFTER role-based
  // field-value filtering, so a hidden field's real values never leak into
  // an aggregate result for a role that cannot view it.
  // -------------------------------------------------------------------------

  it('SECURITY: a role with "hidden" on the aggregated field gets the EMPTY-input aggregate (0 for sum), never the real hidden sum — while an "admin" who CAN view the field gets the real sum', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const adminCookie = await addMemberWithRole(workspaceId, 'admin');
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await defineField(ownerCookie, workspaceId, 'task', {
      key: 'secret',
      label: 'Secret',
      fieldType: 'number',
      config: {},
      permissions: HIDDEN_FOR_NON_ADMIN_PERMISSIONS,
    });

    const objectA = await createObject(ownerCookie, workspaceId, 'task', 'Secret A');
    await setFieldValues(ownerCookie, workspaceId, objectA.id, { secret: 100 });

    const objectB = await createObject(ownerCookie, workspaceId, 'task', 'Secret B');
    await setFieldValues(ownerCookie, workspaceId, objectB.id, { secret: 50 });

    // Admin CAN view `secret` (permissions[admin] === 'view') -> real sum.
    const adminResponse = await listObjects(adminCookie, workspaceId, 'secret:sum');
    expect(adminResponse.status).toBe(200);
    expect((adminResponse.body as ObjectListEnvelope).aggregates?.['secret:sum']).toBe(150);

    // Guest cannot even VIEW `secret` (permissions[guest] === 'hidden') -> it
    // is stripped from every object's `fieldValues` BEFORE aggregation, so
    // this must behave exactly as if the fieldKey were entirely absent:
    // `computeAggregate('sum', [])` === 0, NOT the real hidden sum of 150,
    // and NOT `null` (that would be the empty-input result for avg/min/max,
    // not sum — pinned precisely per `field-aggregations.test.ts`).
    const guestResponse = await listObjects(guestCookie, workspaceId, 'secret:sum');
    expect(guestResponse.status).toBe(200);
    expect((guestResponse.body as ObjectListEnvelope).aggregates?.['secret:sum']).toBe(0);
    expect((guestResponse.body as ObjectListEnvelope).aggregates?.['secret:sum']).not.toBe(150);
  });
});
