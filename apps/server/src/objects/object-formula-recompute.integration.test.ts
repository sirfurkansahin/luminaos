import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { events } from '../db/schema/events.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { objectsView } from '../db/schema/objects-view.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T4 PR-B (RED step) — server-side FORMULA RECOMPUTE wiring on Lumina
 * Objects. Same Testcontainers Postgres 16 + Redis 7 pair,
 * `import('../app.module.js')`-after-env-vars, `toCookieHeader` convention as
 * every other integration test file here. Self-contained (does not import
 * from `./object-field-values.integration.test.ts`, which is left untouched).
 *
 * ============================================================================
 * RED STATE (expected, today): TWO stacked gaps -- see
 * `../fields/field-definitions-formula.integration.test.ts`'s own header for
 * the full detail on the first:
 *
 *   0. `apps/server/src/fields/dto/define-field.schema.ts`'s hardcoded
 *      `FIELD_TYPES` array does not include `'formula'` yet, so EVERY
 *      `defineField(...)` helper call below that defines a `formula`-typed
 *      field (`subtotal`/`discounted`/`total`/`ratio`/`doubled`/
 *      `computedDirect`/etc.) 400s at the DTO boundary, before even reaching
 *      `FieldDefinitionsService`. Concretely, this means every test below
 *      fails immediately inside the `defineField` helper's own
 *      `expect(response.status).toBe(201)` the first time it is asked to
 *      define a `formula` field -- an easy-to-read, unambiguous failure
 *      pointing straight at the missing DTO wiring.
 *   1. Once gap 0 is closed, `ObjectsService.create`/`.setFieldValues`
 *      (`./objects.service.ts`) build their `FieldValueChanged` drafts (user
 *      input, or `applyDefaultFieldValues` for `create`) and append them in
 *      one `eventStore.append()` call -- there is NO recompute step at all.
 *      Concretely:
 *     - Setting upstream plain-field dependencies will only ever change
 *       those plain fields in `object.fieldValues` -- the formula fields
 *       (`subtotal`/`discounted`/`total` below) will simply be ABSENT from
 *       the response (`undefined`), because nothing ever computes or
 *       appends a `FieldValueChanged` for them.
 *     - The "#ERROR propagation" test will fail the same way: `ratio`/
 *       `doubled` never appear in `fieldValues` at all.
 *     - The "direct write to a formula field" test may currently pass for an
 *       unrelated-but-compatible reason once gap 0 is closed (formula fields
 *       can never have `'edit'` permission for any role, per PR-A2's
 *       already-wired `defineField` rule, so `ObjectsService.setFieldValues`'s
 *       existing `canEditField` check already 403s it) -- this is expected
 *       and fine; it does NOT mean recompute itself is wired.
 *     - AC #5 will fail at the very first assertion (the seeded target
 *       object's `subtotal` will not reflect the new `price`), long before
 *       its performance/no-fan-out assertions are even meaningfully
 *       exercised.
 * `implementer` must (a) add `'formula'` to `define-field.schema.ts`'s
 * `FIELD_TYPES` array, (b) wire `FieldDefinitionsService.define`/`.update` to
 * pass real `existingFieldDefinitions`, and (c) add a recompute step to both
 * `ObjectsService.create` and `.setFieldValues`, per this task's pinned
 * design (fetch this object type's active `formula` field definitions,
 * derive `dependsOn` via `parseFormula`, find affected keys via
 * `getAffectedFormulaKeysInOrder`, evaluate each via `evaluateFormula`
 * against the current field-value map with `now = new Date()`, append any
 * changed ones as additional `FieldValueChanged` drafts with
 * `actor: { type: 'system', id: 'formula-engine' }` in the SAME `append()`
 * call as the user/default drafts) to turn this green.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `PATCH .../objects/:objectId/fields` (and `create`, for default-driven
 * recompute) recomputes every formula field transitively affected by the
 * fields just changed, IN DEPENDENCY ORDER, and includes the results in the
 * SAME response's `object.fieldValues` -- no extra round trip needed.
 *
 * A formula's runtime error (`#ERROR`-equivalent) is represented over HTTP as
 * `{ formulaError: true, message: string }` at that field's key in
 * `fieldValues`, and propagates through any downstream formula that
 * references it.
 *
 * Recompute triggers on any UPSTREAM dependency change, not only a direct
 * write to the formula field itself.
 *
 * A formula field can never be targeted directly via
 * `PATCH .../objects/:objectId/fields` -- some 4xx rejection, never a 2xx.
 *
 * AC #5: recompute cost is proportional to the ONE object being written, not
 * to how many other objects of the same type exist in the workspace (no
 * accidental full-table-scan/fan-out).
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

/** The only permission shape a formula field may legally have -- no role
 * ever gets `'edit'`. */
const FORMULA_VIEW_ONLY_PERMISSIONS: FieldPermissionsBody = {
  owner: 'view',
  admin: 'view',
  member: 'view',
  guest: 'hidden',
};

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `formula-recompute-test-user-${String(emailCounter)}@example.com`;
}

/** Splits `items` into chunks of at most `size` -- used to keep bulk-insert
 * statements under Postgres's per-query bound-parameter limit when seeding
 * thousands of rows at once (AC #5). */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

describe('Formula field RECOMPUTE on Lumina Objects (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  async function registerOwnerWithWorkspace(): Promise<{
    cookie: string;
    workspaceId: string;
    userId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Formula Recompute Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId, userId };
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

  // -------------------------------------------------------------------------
  // 3-level chained recompute
  // -------------------------------------------------------------------------

  it('a single PATCH setting only price/qty recomputes subtotal, discounted, AND total in one shot', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'price',
      label: 'Price',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'qty',
      label: 'Quantity',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'subtotal',
      label: 'Subtotal',
      fieldType: 'formula',
      config: { expression: '{price} * {qty}' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'discounted',
      label: 'Discounted',
      fieldType: 'formula',
      config: { expression: '{subtotal} - 10' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'total',
      label: 'Total',
      fieldType: 'formula',
      config: { expression: 'ROUND({discounted}, 2)' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Chained formula task');

    const patchResponse = await setFieldValues(cookie, workspaceId, created.id, {
      price: 10,
      qty: 3,
    });

    expect(patchResponse.status).toBe(200);
    const patchedFieldValues = (patchResponse.body as ObjectEnvelope).object.fieldValues;

    expect(patchedFieldValues['price']).toBe(10);
    expect(patchedFieldValues['qty']).toBe(3);
    expect(patchedFieldValues['subtotal']).toBe(30);
    expect(patchedFieldValues['discounted']).toBe(20);
    expect(patchedFieldValues['total']).toBe(20);

    // Read-your-writes: a follow-up GET reflects the same recomputed chain.
    const getResponse = await getObject(cookie, workspaceId, created.id);
    expect(getResponse.status).toBe(200);
    const gotFieldValues = (getResponse.body as ObjectEnvelope).object.fieldValues;
    expect(gotFieldValues['subtotal']).toBe(30);
    expect(gotFieldValues['discounted']).toBe(20);
    expect(gotFieldValues['total']).toBe(20);
  });

  it('changing only an upstream dependency (price) later, without touching subtotal/discounted/total directly, still recomputes all three', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'price2',
      label: 'Price 2',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'qty2',
      label: 'Quantity 2',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'subtotal2',
      label: 'Subtotal 2',
      fieldType: 'formula',
      config: { expression: '{price2} * {qty2}' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'discounted2',
      label: 'Discounted 2',
      fieldType: 'formula',
      config: { expression: '{subtotal2} - 10' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'total2',
      label: 'Total 2',
      fieldType: 'formula',
      config: { expression: 'ROUND({discounted2}, 2)' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Dependency-triggered task');

    const firstPatch = await setFieldValues(cookie, workspaceId, created.id, {
      price2: 5,
      qty2: 2,
    });
    expect(firstPatch.status).toBe(200);
    expect((firstPatch.body as ObjectEnvelope).object.fieldValues['subtotal2']).toBe(10);
    expect((firstPatch.body as ObjectEnvelope).object.fieldValues['discounted2']).toBe(0);
    expect((firstPatch.body as ObjectEnvelope).object.fieldValues['total2']).toBe(0);

    // Only `price2` is set this time -- `subtotal2`/`discounted2`/`total2`
    // are never mentioned in this PATCH's body at all.
    const secondPatch = await setFieldValues(cookie, workspaceId, created.id, { price2: 100 });

    expect(secondPatch.status).toBe(200);
    const fieldValues = (secondPatch.body as ObjectEnvelope).object.fieldValues;
    expect(fieldValues['price2']).toBe(100);
    expect(fieldValues['qty2']).toBe(2);
    expect(fieldValues['subtotal2']).toBe(200);
    expect(fieldValues['discounted2']).toBe(190);
    expect(fieldValues['total2']).toBe(190);
  });

  // -------------------------------------------------------------------------
  // #ERROR propagation
  // -------------------------------------------------------------------------

  it('a division-by-zero error in an upstream formula propagates (as a { formulaError, message } value) through a downstream formula referencing it', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'a',
      label: 'A',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'b',
      label: 'B',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'ratio',
      label: 'Ratio',
      fieldType: 'formula',
      config: { expression: '{a} / {b}' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'doubled',
      label: 'Doubled',
      fieldType: 'formula',
      config: { expression: 'CONCAT("ratio: ", {ratio})' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Error propagation task');

    const patchResponse = await setFieldValues(cookie, workspaceId, created.id, { a: 10, b: 0 });

    expect(patchResponse.status).toBe(200);
    const fieldValues = (patchResponse.body as ObjectEnvelope).object.fieldValues;

    expect(fieldValues['ratio']).toMatchObject({ formulaError: true });
    expect(typeof (fieldValues['ratio'] as { message: unknown }).message).toBe('string');

    expect(fieldValues['doubled']).toMatchObject({ formulaError: true });
    expect(typeof (fieldValues['doubled'] as { message: unknown }).message).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Direct-write rejection
  // -------------------------------------------------------------------------

  it('attempting to PATCH a formula-typed field directly is rejected (some 4xx, never a 2xx)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await defineField(cookie, workspaceId, 'task', {
      key: 'source',
      label: 'Source',
      fieldType: 'number',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    });
    await defineField(cookie, workspaceId, 'task', {
      key: 'computedDirect',
      label: 'Computed Direct',
      fieldType: 'formula',
      config: { expression: '{source} + 1' },
      permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
    });

    const created = await createObject(cookie, workspaceId, 'task', 'Direct-write rejection task');

    const response = await setFieldValues(cookie, workspaceId, created.id, {
      computedDirect: 999,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    // Whatever the rejection, the field's value must never actually have
    // been set to the directly-submitted 999.
    const getResponse = await getObject(cookie, workspaceId, created.id);
    expect((getResponse.body as ObjectEnvelope).object.fieldValues['computedDirect']).not.toBe(999);
  });

  // -------------------------------------------------------------------------
  // AC #5 -- 10,000-object scale: incremental-only recompute, no fan-out
  // -------------------------------------------------------------------------

  describe('AC #5: recompute at scale touches only the written object', () => {
    it('seeding 10,000 task objects directly, then PATCHing exactly ONE via HTTP recomputes only that object, leaves the other 9,999 untouched, and completes quickly', async () => {
      const { cookie, workspaceId, userId } = await registerOwnerWithWorkspace();

      // --- 1. Field definitions, inserted directly (bypassing HTTP: the
      // thing under test is recompute cost, not field-definition-creation
      // cost, and this workspace's field-definition wiring is exercised
      // exhaustively by the other tests in this file already). ---
      const now = new Date();

      await rawDb.insert(fieldDefinitions).values([
        {
          id: newObjectId(),
          streamId: randomUUID(),
          workspaceId,
          objectType: 'task',
          key: 'price',
          label: 'Price',
          fieldType: 'number',
          config: {},
          permissions: EDIT_ALL_PERMISSIONS,
          lifecycle: 'active',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: newObjectId(),
          streamId: randomUUID(),
          workspaceId,
          objectType: 'task',
          key: 'qty',
          label: 'Quantity',
          fieldType: 'number',
          config: {},
          permissions: EDIT_ALL_PERMISSIONS,
          lifecycle: 'active',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: newObjectId(),
          streamId: randomUUID(),
          workspaceId,
          objectType: 'task',
          key: 'subtotal',
          label: 'Subtotal',
          fieldType: 'formula',
          config: { expression: '{price} * {qty}' },
          permissions: FORMULA_VIEW_ONLY_PERMISSIONS,
          lifecycle: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // --- 2. The ONE target object: a real, fully consistent event
      // history (ObjectCreated + 3 FieldValueChanged), because THIS one
      // object's stream is genuinely read/appended-to via the real HTTP
      // command path below. ---
      const targetObjectId = newObjectId();
      const targetStreamId = randomUUID();
      const seedPrice = 10;
      const seedQty = 5;
      const seedSubtotal = seedPrice * seedQty;

      await rawDb.insert(events).values([
        {
          id: randomUUID(),
          streamId: targetStreamId,
          streamType: 'lumina-object',
          workspaceId,
          type: 'ObjectCreated',
          version: 1,
          payload: {
            objectId: targetObjectId,
            objectType: 'task',
            workspaceId,
            title: 'Scale target task',
          },
          actor: { type: 'user', id: userId },
          occurredAt: now,
        },
        {
          id: randomUUID(),
          streamId: targetStreamId,
          streamType: 'lumina-object',
          workspaceId,
          type: 'FieldValueChanged',
          version: 2,
          payload: { objectId: targetObjectId, fieldKey: 'price', value: seedPrice },
          actor: { type: 'user', id: userId },
          occurredAt: now,
        },
        {
          id: randomUUID(),
          streamId: targetStreamId,
          streamType: 'lumina-object',
          workspaceId,
          type: 'FieldValueChanged',
          version: 3,
          payload: { objectId: targetObjectId, fieldKey: 'qty', value: seedQty },
          actor: { type: 'user', id: userId },
          occurredAt: now,
        },
        {
          id: randomUUID(),
          streamId: targetStreamId,
          streamType: 'lumina-object',
          workspaceId,
          type: 'FieldValueChanged',
          version: 4,
          payload: { objectId: targetObjectId, fieldKey: 'subtotal', value: seedSubtotal },
          actor: { type: 'user', id: userId },
          occurredAt: now,
        },
      ]);

      await rawDb.insert(objectsView).values({
        id: targetObjectId,
        streamId: targetStreamId,
        type: 'task',
        workspaceId,
        title: 'Scale target task',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        lifecycle: 'active',
        fieldValues: { price: seedPrice, qty: seedQty, subtotal: seedSubtotal },
      });

      // --- 3. 9,999 decoy objects: `objects_view` rows only (nothing ever
      // reads/appends to their event streams in this test, so no matching
      // `events` rows are needed for them). ---
      const decoyCount = 9_999;
      const decoyPrice = 1;
      const decoyQty = 2;
      const decoySubtotal = decoyPrice * decoyQty;

      const decoyIds: string[] = [];
      const decoyRows: (typeof objectsView.$inferInsert)[] = [];

      for (let index = 0; index < decoyCount; index += 1) {
        const decoyId = newObjectId();
        decoyIds.push(decoyId);

        decoyRows.push({
          id: decoyId,
          streamId: randomUUID(),
          type: 'task',
          workspaceId,
          title: `Decoy task ${String(index)}`,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
          lifecycle: 'active',
          fieldValues: { price: decoyPrice, qty: decoyQty, subtotal: decoySubtotal },
        });
      }

      for (const batch of chunk(decoyRows, 1_000)) {
        await rawDb.insert(objectsView).values(batch);
      }

      // --- 4. The actual write under test: ONE real HTTP PATCH, changing
      // only `price` on the target object. ---
      const newPrice = 20;
      const expectedSubtotal = newPrice * seedQty;

      const start = performance.now();
      const patchResponse = await setFieldValues(cookie, workspaceId, targetObjectId, {
        price: newPrice,
      });
      const elapsedMs = performance.now() - start;

      // 4a. Correctness: the target object's subtotal is recomputed.
      expect(patchResponse.status).toBe(200);
      expect((patchResponse.body as ObjectEnvelope).object.fieldValues['subtotal']).toBe(
        expectedSubtotal,
      );

      const getResponse = await getObject(cookie, workspaceId, targetObjectId);
      expect(getResponse.status).toBe(200);
      expect((getResponse.body as ObjectEnvelope).object.fieldValues['subtotal']).toBe(
        expectedSubtotal,
      );

      // 4b. No fan-out: a sample of the OTHER 9,999 objects, read directly
      // from `objects_view`, must be COMPLETELY unchanged.
      const sampleSize = 8;
      const sampleIds = Array.from(
        { length: sampleSize },
        (_, index) => decoyIds[Math.floor((index * decoyCount) / sampleSize)] ?? decoyIds[0],
      ).filter((id): id is string => id !== undefined);

      const sampledRows = await rawDb
        .select({ id: objectsView.id, fieldValues: objectsView.fieldValues })
        .from(objectsView)
        .where(inArray(objectsView.id, sampleIds));

      expect(sampledRows).toHaveLength(sampleIds.length);

      for (const row of sampledRows) {
        expect(row.fieldValues).toEqual({
          price: decoyPrice,
          qty: decoyQty,
          subtotal: decoySubtotal,
        });
      }

      // 4c. Performance sanity: secondary evidence alongside 4b -- a
      // single-object write must not scale with workspace object count.
      // Generous bound (real Postgres round trips via Testcontainers).
      expect(elapsedMs).toBeLessThan(2_000);
    }, 120_000);
  });
});
