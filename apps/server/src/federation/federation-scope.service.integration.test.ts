import crypto, { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';
import { ForbiddenError, NotFoundError, ValidationError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { objectsView } from '../db/schema/objects-view.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F3-T14 PR1 (RED step), ADR-0048 §e — `FederationScopeService`
 * (`./federation-scope.service.ts`, does NOT exist yet as of this commit),
 * backed by a NEW `federation_scope_objects` table
 * (`../db/schema/federation-scope-objects.ts`, ADR-0048 §e, also does not
 * exist yet -- no migration 0047 for it either), and depending on the ALSO
 * not-yet-existing `FederationLinksService` (`./federation-links.service.ts`)
 * to set up real link fixtures.
 *
 * ============================================================================
 * HARNESS CHOICE: same direct-instantiation, no-Nest-boot,
 * Testcontainers-Postgres-only convention as
 * `./federation-links.service.integration.test.ts` and
 * `../mcp-server/mcp-client-grants.service.test.ts`. Both not-yet-existing
 * services are loaded via a single dynamic `import()` each in `beforeAll`
 * (after `DATABASE_URL`/`REDIS_URL` are set), never a static top-level
 * import -- see those two files' own headers for the full rationale. Local
 * contract interfaces stand in for both real (not-yet-existing) exported
 * classes.
 *
 * `objectsView` (`../db/schema/objects-view.ts`) ALREADY EXISTS today, so it
 * is imported normally and used to insert real fixture "Lumina Object" rows
 * directly (bypassing the full event-sourcing write path -- this table is a
 * plain, directly-insertable Drizzle-mapped read-model table, not a genuine
 * Postgres `VIEW`), mirroring `relations.service.ts`'s own
 * `assertObjectExists(workspaceId, objectId)` query shape (Bağlam madde 4)
 * that `FederationScopeService.addObject` is expected to reuse.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): none of `./federation-scope.service.ts`,
 * `./federation-links.service.ts`, or their schemas/migration exist yet.
 * `beforeAll`'s dynamic imports reject with "Cannot find module" resolution
 * errors, failing every test in this file at setup -- this is the correct
 * red, not a test-logic bug.
 * ============================================================================
 *
 * SCHEMA-MISMATCH FLAG for `implementer` (test-writer's own finding, not an
 * ADR-0048 typo this file works around): ADR-0048 §e's own code draft types
 * `federation_scope_objects.object_id` as a Postgres `uuid` column, but real
 * Lumina Object ids (`@luminaos/core-objects`'s `newObjectId()`, and
 * `objects_view.id`'s own column type) are 26-character Crockford-base32
 * ULIDs, NOT UUIDs -- a ULID string cannot be inserted into a `uuid` column.
 * This file uses REAL `newObjectId()` values throughout (the only values that
 * will ever actually reach this table at runtime), so if `implementer`
 * follows the ADR's draft literally, the "successful add" and "re-add after
 * tombstone" tests below will fail with a Postgres `invalid input syntax for
 * type uuid` error rather than a plain assertion failure -- a legitimate,
 * ADR-preceding catch, not a bug in this test file. The fix is a one-line
 * schema change (`varchar('object_id', { length: 26 })` instead of
 * `uuid('object_id')`), left to `implementer`/`security-reviewer` to confirm
 * and, if needed, escalate as an ADR amendment.
 */

type Role = 'owner' | 'admin' | 'member' | 'guest';
type FederationLinkStatus = 'pending' | 'active' | 'revoked';

interface FederationLink {
  id: string;
  initiatorWorkspaceId: string;
  counterpartWorkspaceId: string;
  status: FederationLinkStatus;
}

interface FederationLinksServiceContract {
  initiate(
    initiatorWorkspaceId: string,
    counterpartWorkspaceId: string,
    actorUserId: string,
    actorRole: Role,
  ): Promise<FederationLink>;
  accept(linkId: string, actorUserId: string, actorRole: Role): Promise<FederationLink>;
}

type FederationLinksServiceConstructor = new (db: Database) => FederationLinksServiceContract;

interface FederationScopeObject {
  id: string;
  federationLinkId: string;
  objectId: string;
  ownerWorkspaceId: string;
  addedByUserId: string;
  addedAt: Date;
  removedAt: Date | null;
}

interface FederationScopeServiceContract {
  addObject(
    linkId: string,
    objectId: string,
    ownerWorkspaceId: string,
    actorUserId: string,
    actorRole: Role,
  ): Promise<FederationScopeObject>;
  removeObject(linkId: string, objectId: string, actorRole: Role): Promise<FederationScopeObject>;
}

type FederationScopeServiceConstructor = new (db: Database) => FederationScopeServiceContract;

interface RawScopeRow {
  id: string;
  federation_link_id: string;
  object_id: string;
  owner_workspace_id: string;
  removed_at: string | null;
}

describe('FederationScopeService (real Postgres via Testcontainers, ADR-0048 §e)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let linksService: FederationLinksServiceContract;
  let scopeService: FederationScopeServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://federation-scope-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    const linksModule: unknown = await import('./federation-links.service.js');
    const FederationLinksServiceCtor = (
      linksModule as { FederationLinksService: FederationLinksServiceConstructor }
    ).FederationLinksService;
    linksService = new FederationLinksServiceCtor(db);

    // Deliberately unresolvable until `implementer` creates
    // `./federation-scope.service.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained to
    // this one line.
    const scopeModule: unknown = await import('./federation-scope.service.js');
    const FederationScopeServiceCtor = (
      scopeModule as { FederationScopeService: FederationScopeServiceConstructor }
    ).FederationScopeService;
    scopeService = new FederationScopeServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `federation-scope-test-${label}-${unique}`, slug: unique })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${label}"`);
    }

    return workspace.id;
  }

  async function createUser(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [user] = await db
      .insert(users)
      .values({
        email: `federation-scope-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  /** Directly inserts a fixture "Lumina Object" row into `objects_view`,
   * bypassing the full event-sourcing create path -- sufficient for
   * `assertObjectExists`-style existence/workspace-scope checks, which only
   * ever read this table (Bağlam madde 4). */
  async function createObjectFixture(workspaceId: string, title: string): Promise<string> {
    const objectId = newObjectId();
    const now = new Date();

    await db.insert(objectsView).values({
      id: objectId,
      streamId: randomUUID(),
      type: 'task',
      workspaceId,
      title,
      createdBy: 'federation-scope-test-fixture',
      createdAt: now,
      updatedAt: now,
      lifecycle: 'active',
    });

    return objectId;
  }

  /** Creates a real, ACTIVE link between two fresh workspaces, returning both
   * workspace ids plus admin actor ids for each side. */
  async function createActiveLink(label: string): Promise<{
    linkId: string;
    initiatorWorkspaceId: string;
    counterpartWorkspaceId: string;
    initiatorAdminUserId: string;
    counterpartAdminUserId: string;
  }> {
    const initiatorWorkspaceId = await createWorkspace(`${label}-initiator`);
    const counterpartWorkspaceId = await createWorkspace(`${label}-counterpart`);
    const initiatorAdminUserId = await createUser(`${label}-initiator-admin`);
    const counterpartAdminUserId = await createUser(`${label}-counterpart-admin`);

    const link = await linksService.initiate(
      initiatorWorkspaceId,
      counterpartWorkspaceId,
      initiatorAdminUserId,
      'admin',
    );
    await linksService.accept(link.id, counterpartAdminUserId, 'admin');

    return {
      linkId: link.id,
      initiatorWorkspaceId,
      counterpartWorkspaceId,
      initiatorAdminUserId,
      counterpartAdminUserId,
    };
  }

  async function rawScopeRowsFor(linkId: string, objectId: string): Promise<RawScopeRow[]> {
    const result = await db.$client.query<RawScopeRow>(
      `select id, federation_link_id, object_id, owner_workspace_id,
              removed_at::text as removed_at
         from federation_scope_objects
        where federation_link_id = $1 and object_id = $2
        order by added_at asc`,
      [linkId, objectId],
    );
    return result.rows;
  }

  // =======================================================================
  // addObject()
  // =======================================================================

  describe('addObject', () => {
    it('a non-existent objectId throws NotFoundError', async () => {
      const { linkId, initiatorWorkspaceId, initiatorAdminUserId } =
        await createActiveLink('add-not-found');
      const neverInsertedObjectId = newObjectId();

      await expect(
        scopeService.addObject(
          linkId,
          neverInsertedObjectId,
          initiatorWorkspaceId,
          initiatorAdminUserId,
          'admin',
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('an ownerWorkspaceId that is NEITHER end of the link throws ValidationError, even for a real object that genuinely exists there', async () => {
      const { linkId, initiatorAdminUserId } = await createActiveLink('add-wrong-owner-ws');
      const unrelatedWorkspaceId = await createWorkspace('add-wrong-owner-ws-unrelated');
      const realObjectInUnrelatedWorkspace = await createObjectFixture(
        unrelatedWorkspaceId,
        'Object that exists, but in a workspace unrelated to this link',
      );

      await expect(
        scopeService.addObject(
          linkId,
          realObjectInUnrelatedWorkspace,
          unrelatedWorkspaceId,
          initiatorAdminUserId,
          'admin',
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('a caller who is not admin+ in ownerWorkspaceId throws ForbiddenError', async () => {
      const { linkId, initiatorWorkspaceId } = await createActiveLink('add-forbidden');
      const memberUserId = await createUser('add-forbidden-member');
      const objectId = await createObjectFixture(
        initiatorWorkspaceId,
        'Object owned by the initiator side',
      );

      await expect(
        scopeService.addObject(linkId, objectId, initiatorWorkspaceId, memberUserId, 'member'),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('a successful add (real object, ownerWorkspaceId on the link, admin+ caller) returns a row with removedAt null', async () => {
      const { linkId, initiatorWorkspaceId, initiatorAdminUserId } =
        await createActiveLink('add-success');
      const objectId = await createObjectFixture(
        initiatorWorkspaceId,
        'Object successfully added to federation scope',
      );

      const added = await scopeService.addObject(
        linkId,
        objectId,
        initiatorWorkspaceId,
        initiatorAdminUserId,
        'admin',
      );

      expect(added.federationLinkId).toBe(linkId);
      expect(added.objectId).toBe(objectId);
      expect(added.ownerWorkspaceId).toBe(initiatorWorkspaceId);
      expect(added.removedAt).toBeNull();
    });

    it('the counterpart side (not just the initiator) can also add an object it owns', async () => {
      const { linkId, counterpartWorkspaceId, counterpartAdminUserId } =
        await createActiveLink('add-success-counterpart');
      const objectId = await createObjectFixture(
        counterpartWorkspaceId,
        'Object owned by the counterpart side',
      );

      const added = await scopeService.addObject(
        linkId,
        objectId,
        counterpartWorkspaceId,
        counterpartAdminUserId,
        'admin',
      );

      expect(added.ownerWorkspaceId).toBe(counterpartWorkspaceId);
      expect(added.removedAt).toBeNull();
    });
  });

  // =======================================================================
  // removeObject() -- tombstone, not hard-delete
  // =======================================================================

  describe('removeObject', () => {
    it('sets removedAt (tombstone) without deleting the row', async () => {
      const { linkId, initiatorWorkspaceId, initiatorAdminUserId } =
        await createActiveLink('remove-tombstone');
      const objectId = await createObjectFixture(
        initiatorWorkspaceId,
        'Object to be removed from scope (tombstoned)',
      );
      await scopeService.addObject(
        linkId,
        objectId,
        initiatorWorkspaceId,
        initiatorAdminUserId,
        'admin',
      );

      const removed = await scopeService.removeObject(linkId, objectId, 'admin');
      expect(removed.removedAt).not.toBeNull();

      const rows = await rawScopeRowsFor(linkId, objectId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.removed_at).not.toBeNull();
    });

    it('after a tombstone, the SAME objectId can be re-added via addObject (a NEW active row, old tombstoned row untouched)', async () => {
      const { linkId, initiatorWorkspaceId, initiatorAdminUserId } =
        await createActiveLink('remove-then-readd');
      const objectId = await createObjectFixture(
        initiatorWorkspaceId,
        'Object removed then re-added to scope',
      );

      await scopeService.addObject(
        linkId,
        objectId,
        initiatorWorkspaceId,
        initiatorAdminUserId,
        'admin',
      );
      await scopeService.removeObject(linkId, objectId, 'admin');

      const readded = await scopeService.addObject(
        linkId,
        objectId,
        initiatorWorkspaceId,
        initiatorAdminUserId,
        'admin',
      );
      expect(readded.removedAt).toBeNull();

      const rows = await rawScopeRowsFor(linkId, objectId);
      // Two rows total for this (linkId, objectId): one tombstoned, one
      // active -- proving the partial-unique-index (`WHERE removed_at IS
      // NULL`) is what allows this re-add, not a silent update-in-place of
      // the original row.
      expect(rows).toHaveLength(2);
      const activeRows = rows.filter((row) => row.removed_at === null);
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0]?.id).toBe(readded.id);
    });
  });
});
