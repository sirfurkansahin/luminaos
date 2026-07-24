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
 * Regression tests from F1-T2 PR-B security review, three findings:
 *
 * 1. (High) `FieldDefinitionsService.define`'s pre-check-SELECT uniqueness
 *    guard had a check-then-act race: two concurrent `define` calls for the
 *    identical `(workspaceId, objectType, key)` could both pass the
 *    pre-check, both append their `FieldDefined` event, and then the SECOND
 *    event's projection insert would throw a raw, unhandled Postgres unique
 *    violation inside `ProjectionRunner.catchUp`'s transaction — aborting
 *    the whole batch (including the FIRST event's insert) and leaving the
 *    `field-definitions` projection checkpoint stuck forever (a permanent,
 *    cross-tenant poison pill: every later `catchUp` call, from any
 *    workspace, re-encounters the same failing event). Fixed by having the
 *    projection's `FieldDefined` case use `onConflictDoNothing` on the
 *    business-uniqueness index (never throws, checkpoint always advances)
 *    and having `define()` verify, after `catchUp`, that ITS OWN row
 *    actually landed — if not, it lost the race and now throws
 *    `ConflictError` instead of falsely reporting success.
 * 2. (Medium) `GET /fields` did not filter out field definitions whose
 *    `permissions[callerRole] === 'hidden'`, contradicting the plan and the
 *    controller's own doc comment claiming it did.
 * 3. (Low) `PATCH`/`archive` did not verify the field definition being
 *    mutated actually belongs to the `:objectType` in the URL — an admin
 *    could mutate a `doc` field via a `.../object-types/task/fields/:id`
 *    URL. Fixed by scoping the `id -> streamId` lookup by `objectType` too.
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

interface FieldDefinitionListEnvelope {
  fieldDefinitions: FieldDefinitionBody[];
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

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `fields-security-test-user-${String(emailCounter)}@example.com`;
}

describe('Field Definitions security regressions (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
    const workspaceId = await createWorkspace(cookie, `Security Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

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

  it('Finding 1: concurrent define() with an identical key resolves to exactly one 201 and one 409, never a crash, and the projection keeps working afterward', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const body = {
      key: 'race-key',
      label: 'Race',
      fieldType: 'text',
      config: {},
      permissions: EDIT_ALL_PERMISSIONS,
    };

    const [responseA, responseB] = await Promise.all([
      request(server).post(fieldsUrl(workspaceId, 'task')).set('Cookie', cookie).send(body),
      request(server).post(fieldsUrl(workspaceId, 'task')).set('Cookie', cookie).send(body),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    // The projection must not be poisoned: GET / still works and shows
    // exactly one "race-key" definition...
    const listResponse = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie);
    expect(listResponse.status).toBe(200);
    const raceKeyMatches = (
      listResponse.body as FieldDefinitionListEnvelope
    ).fieldDefinitions.filter((fd) => fd.key === 'race-key');
    expect(raceKeyMatches).toHaveLength(1);

    // ...and defining a completely unrelated field (proving the
    // `field-definitions` projection checkpoint is not stuck) still works.
    const unrelatedResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', cookie)
      .send({
        key: 'unrelated-after-race',
        label: 'Unrelated',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });
    expect(unrelatedResponse.status).toBe(201);
  });

  it('Finding 2: GET /fields omits a field definition that is "hidden" for the caller\'s role', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const hiddenForGuest = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', adminCookie)
      .send({
        key: 'secret-field',
        label: 'Secret',
        fieldType: 'text',
        config: {},
        permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'hidden' },
      });
    expect(hiddenForGuest.status).toBe(201);

    const visibleForGuest = await request(server)
      .post(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', adminCookie)
      .send({
        key: 'visible-field',
        label: 'Visible',
        fieldType: 'text',
        config: {},
        permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'view' },
      });
    expect(visibleForGuest.status).toBe(201);

    const guestListResponse = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', guestCookie);

    expect(guestListResponse.status).toBe(200);
    const guestKeys = (guestListResponse.body as FieldDefinitionListEnvelope).fieldDefinitions.map(
      (fd) => fd.key,
    );
    expect(guestKeys).toContain('visible-field');
    expect(guestKeys).not.toContain('secret-field');

    // The admin who defined it can still see both.
    const adminListResponse = await request(server)
      .get(fieldsUrl(workspaceId, 'task'))
      .set('Cookie', adminCookie);
    const adminKeys = (adminListResponse.body as FieldDefinitionListEnvelope).fieldDefinitions.map(
      (fd) => fd.key,
    );
    expect(adminKeys).toContain('secret-field');
    expect(adminKeys).toContain('visible-field');
  });

  it('Finding 3: PATCH/archive reject a fieldDefinitionId that exists but belongs to a different :objectType in the URL', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const defineResponse = await request(server)
      .post(fieldsUrl(workspaceId, 'doc'))
      .set('Cookie', cookie)
      .send({
        key: 'doc-only-field',
        label: 'Doc Only',
        fieldType: 'text',
        config: {},
        permissions: EDIT_ALL_PERMISSIONS,
      });
    expect(defineResponse.status).toBe(201);
    const fieldDefinitionId = (defineResponse.body as FieldDefinitionEnvelope).fieldDefinition.id;

    // Same field, wrong :objectType segment ("task" instead of "doc").
    const wrongTypePatch = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}`)
      .set('Cookie', cookie)
      .send({ label: 'Should not apply' });
    expect(wrongTypePatch.status).toBe(404);

    const wrongTypeArchive = await request(server)
      .post(`${fieldsUrl(workspaceId, 'task')}/${fieldDefinitionId}/archive`)
      .set('Cookie', cookie)
      .send();
    expect(wrongTypeArchive.status).toBe(404);

    // The correct :objectType segment still works.
    const correctTypePatch = await request(server)
      .patch(`${fieldsUrl(workspaceId, 'doc')}/${fieldDefinitionId}`)
      .set('Cookie', cookie)
      .send({ label: 'Applied correctly' });
    expect(correctTypePatch.status).toBe(200);
  });
});
