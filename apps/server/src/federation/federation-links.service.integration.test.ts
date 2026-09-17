import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ForbiddenError, ValidationError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F3-T14 PR1 (RED step), ADR-0048 §b/§c — `FederationLinksService`
 * (`./federation-links.service.ts`, does NOT exist yet as of this commit),
 * backed by a NEW `federation_links` table (`../db/schema/federation-links.ts`,
 * ADR-0048 §b, also does not exist yet -- no migration 0047 for it either).
 *
 * ============================================================================
 * HARNESS CHOICE: same reasoning as
 * `../mcp-server/mcp-client-grants.service.test.ts`'s header --
 * `FederationLinksService` has exactly one constructor dependency (`Database`)
 * and no controller in THIS PR (PR2's REST endpoints are out of scope, per
 * this task's own file list), so this follows that file's direct-instantiation,
 * no-Nest-boot, Testcontainers-Postgres-only convention. `REDIS_URL` is set to
 * an unreachable PLACEHOLDER (never actually connected to) purely to satisfy
 * `../config/env.js`'s module-level `readEnv()` fail-fast check, which some
 * transitively-imported module along the way may trigger -- mirrored 1:1 from
 * `mcp-client-grants.service.test.ts`'s own precedent.
 *
 * `FederationLink`/`FederationLinksServiceContract` are declared LOCALLY
 * (rather than a top-level `import type` from the not-yet-existing module),
 * exactly mirroring `mcp-client-grants.service.test.ts`'s own pattern, so this
 * file's dynamic import below degrades to a single, isolated, EXPECTED
 * `import-x/no-unresolved` finding at that one import site. Since
 * `../db/schema/federation-links.ts` does not exist yet either, every direct-
 * row assertion/seed below uses raw `db.$client.query(...)` SQL against the
 * table name ADR-0048 §b pins (`federation_links`), never a typed Drizzle
 * import of that not-yet-existing schema module.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./federation-links.service.ts` nor
 * `../db/schema/federation-links.ts` (nor migration 0047) exist yet.
 * `beforeAll`'s dynamic `import('./federation-links.service.js')` rejects
 * with a "Cannot find module" resolution error, failing every test in this
 * file at setup -- this is the correct red: the service this PR adds simply
 * does not exist yet, not a test-logic bug.
 * ============================================================================
 *
 * JUDGMENT CALL (test-writer's own, not pinned by ADR-0048): `accept(linkId,
 * actorUserId, actorRole)` has no explicit "which side is the caller on"
 * parameter -- ADR-0048 §c's "initiator kendi teklifini kabul edemez" rule is
 * therefore asserted here via the only signal the signature actually carries:
 * `actorUserId === link.initiatedByUserId` (the literal same person who
 * proposed the link) is rejected with `ForbiddenError`, even though they hold
 * an `admin` role. `implementer` may instead choose to thread an explicit
 * `callerWorkspaceId` through this method (checked against
 * `counterpartWorkspaceId`) -- if so, only this one test needs revisiting;
 * every other test in this file is independent of that choice. Likewise,
 * `revoke(linkId, actorUserId, actorRole)` is asserted to succeed for ANY
 * `admin+` actor regardless of which side they're nominally on (ADR-0048 §c:
 * "her iki taraftan da, her durumda") -- this PR's service layer trusts the
 * caller-supplied `actorRole` at face value; verifying the caller is REALLY a
 * member of one of the link's two workspaces is left to the real membership
 * lookup a controller/guard would perform in PR2, out of scope here.
 */

type FederationLinkStatus = 'pending' | 'active' | 'revoked';
type Role = 'owner' | 'admin' | 'member' | 'guest';

interface FederationLink {
  id: string;
  initiatorWorkspaceId: string;
  counterpartWorkspaceId: string;
  pairKey: string;
  status: FederationLinkStatus;
  initiatedByUserId: string;
  acceptedByUserId: string | null;
  revokedByUserId: string | null;
  initiatorAuditStreamId: string;
  counterpartAuditStreamId: string;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

interface FederationLinksServiceContract {
  initiate(
    initiatorWorkspaceId: string,
    counterpartWorkspaceId: string,
    actorUserId: string,
    actorRole: Role,
  ): Promise<FederationLink>;
  accept(linkId: string, actorUserId: string, actorRole: Role): Promise<FederationLink>;
  revoke(linkId: string, actorUserId: string, actorRole: Role): Promise<FederationLink>;
}

type FederationLinksServiceConstructor = new (db: Database) => FederationLinksServiceContract;

interface RawLinkCountRow {
  count: string;
}

describe('FederationLinksService (real Postgres via Testcontainers, ADR-0048 §b/§c)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let service: FederationLinksServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://federation-links-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./federation-links.service.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained to
    // this one line.
    const importedModule: unknown = await import('./federation-links.service.js');
    const FederationLinksServiceCtor = (
      importedModule as { FederationLinksService: FederationLinksServiceConstructor }
    ).FederationLinksService;
    service = new FederationLinksServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `federation-links-test-${label}-${unique}`, slug: unique })
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
        email: `federation-links-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  async function countNonRevokedLinksForPair(pairKey: string): Promise<number> {
    const result = await db.$client.query<RawLinkCountRow>(
      `select count(*)::text as count from federation_links where pair_key = $1 and status <> 'revoked'`,
      [pairKey],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  function expectedPairKey(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  // =======================================================================
  // initiate()
  // =======================================================================

  describe('initiate', () => {
    it('an admin-below role (member) is rejected with ForbiddenError', async () => {
      const initiatorWorkspaceId = await createWorkspace('initiate-member-initiator');
      const counterpartWorkspaceId = await createWorkspace('initiate-member-counterpart');
      const actorUserId = await createUser('initiate-member-actor');

      await expect(
        service.initiate(initiatorWorkspaceId, counterpartWorkspaceId, actorUserId, 'member'),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('an admin-below role (guest) is rejected with ForbiddenError', async () => {
      const initiatorWorkspaceId = await createWorkspace('initiate-guest-initiator');
      const counterpartWorkspaceId = await createWorkspace('initiate-guest-counterpart');
      const actorUserId = await createUser('initiate-guest-actor');

      await expect(
        service.initiate(initiatorWorkspaceId, counterpartWorkspaceId, actorUserId, 'guest'),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('initiatorWorkspaceId === counterpartWorkspaceId (self-link) is rejected with ValidationError, even for an admin', async () => {
      const workspaceId = await createWorkspace('initiate-self-link');
      const actorUserId = await createUser('initiate-self-link-actor');

      await expect(
        service.initiate(workspaceId, workspaceId, actorUserId, 'admin'),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('a successful call by an admin returns a link with status "pending" and no acceptedAt/revokedAt', async () => {
      const initiatorWorkspaceId = await createWorkspace('initiate-success-initiator');
      const counterpartWorkspaceId = await createWorkspace('initiate-success-counterpart');
      const actorUserId = await createUser('initiate-success-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        actorUserId,
        'admin',
      );

      expect(link.status).toBe('pending');
      expect(link.initiatorWorkspaceId).toBe(initiatorWorkspaceId);
      expect(link.counterpartWorkspaceId).toBe(counterpartWorkspaceId);
      expect(link.initiatedByUserId).toBe(actorUserId);
      expect(link.pairKey).toBe(expectedPairKey(initiatorWorkspaceId, counterpartWorkspaceId));
      expect(link.acceptedAt).toBeNull();
      expect(link.revokedAt).toBeNull();
    });

    it('an "owner" role (above admin) is also accepted -- admin+, not admin-exactly', async () => {
      const initiatorWorkspaceId = await createWorkspace('initiate-owner-initiator');
      const counterpartWorkspaceId = await createWorkspace('initiate-owner-counterpart');
      const actorUserId = await createUser('initiate-owner-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        actorUserId,
        'owner',
      );

      expect(link.status).toBe('pending');
    });
  });

  // =======================================================================
  // accept()
  // =======================================================================

  describe('accept', () => {
    it('the initiator (same actorUserId as initiatedByUserId) trying to accept their own proposal is rejected with ForbiddenError', async () => {
      const initiatorWorkspaceId = await createWorkspace('accept-self-initiator');
      const counterpartWorkspaceId = await createWorkspace('accept-self-counterpart');
      const initiatorUserId = await createUser('accept-self-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        initiatorUserId,
        'admin',
      );

      await expect(service.accept(link.id, initiatorUserId, 'admin')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('an admin-below role (member) on the counterpart side is rejected with ForbiddenError', async () => {
      const initiatorWorkspaceId = await createWorkspace('accept-member-initiator');
      const counterpartWorkspaceId = await createWorkspace('accept-member-counterpart');
      const initiatorUserId = await createUser('accept-member-initiator-actor');
      const counterpartUserId = await createUser('accept-member-counterpart-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        initiatorUserId,
        'admin',
      );

      await expect(service.accept(link.id, counterpartUserId, 'member')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('a successful accept by a different (counterpart-side) admin sets status "active" and acceptedAt', async () => {
      const initiatorWorkspaceId = await createWorkspace('accept-success-initiator');
      const counterpartWorkspaceId = await createWorkspace('accept-success-counterpart');
      const initiatorUserId = await createUser('accept-success-initiator-actor');
      const counterpartUserId = await createUser('accept-success-counterpart-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        initiatorUserId,
        'admin',
      );

      const accepted = await service.accept(link.id, counterpartUserId, 'admin');

      expect(accepted.status).toBe('active');
      expect(accepted.acceptedAt).not.toBeNull();
      expect(accepted.acceptedByUserId).toBe(counterpartUserId);
    });
  });

  // =======================================================================
  // revoke()
  // =======================================================================

  describe('revoke', () => {
    it('an admin-below role (member) is rejected with ForbiddenError', async () => {
      const initiatorWorkspaceId = await createWorkspace('revoke-member-initiator');
      const counterpartWorkspaceId = await createWorkspace('revoke-member-counterpart');
      const initiatorUserId = await createUser('revoke-member-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        initiatorUserId,
        'admin',
      );

      await expect(service.revoke(link.id, initiatorUserId, 'member')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('an admin+ can revoke a "pending" link -- status becomes "revoked", revokedAt set', async () => {
      const initiatorWorkspaceId = await createWorkspace('revoke-pending-initiator');
      const counterpartWorkspaceId = await createWorkspace('revoke-pending-counterpart');
      const initiatorUserId = await createUser('revoke-pending-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        initiatorUserId,
        'admin',
      );

      const revoked = await service.revoke(link.id, initiatorUserId, 'admin');

      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedAt).not.toBeNull();
    });

    it('an admin+ can revoke an "active" link -- status becomes "revoked", revokedAt set', async () => {
      const initiatorWorkspaceId = await createWorkspace('revoke-active-initiator');
      const counterpartWorkspaceId = await createWorkspace('revoke-active-counterpart');
      const initiatorUserId = await createUser('revoke-active-initiator-actor');
      const counterpartUserId = await createUser('revoke-active-counterpart-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        initiatorUserId,
        'admin',
      );
      await service.accept(link.id, counterpartUserId, 'admin');

      const revoked = await service.revoke(link.id, counterpartUserId, 'admin');

      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedAt).not.toBeNull();
    });

    it('revoking an already-revoked link a second time throws InvalidObjectStateError', async () => {
      const initiatorWorkspaceId = await createWorkspace('revoke-twice-initiator');
      const counterpartWorkspaceId = await createWorkspace('revoke-twice-counterpart');
      const initiatorUserId = await createUser('revoke-twice-actor');

      const link = await service.initiate(
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        initiatorUserId,
        'admin',
      );
      await service.revoke(link.id, initiatorUserId, 'admin');

      // `InvalidObjectStateError` is asserted structurally via its expected
      // `@luminaos/shared` error code rather than an `instanceof` import,
      // since importing it here would be the only reason to add that import
      // -- `.rejects.toMatchObject` on the error's `code` keeps this test
      // resilient to exactly which `AppError` subclass carries it, while
      // still pinning the ADR-0048 §b-mandated distinct-from-`ForbiddenError`
      // semantics (an already-terminal link is a STATE conflict, not an
      // authorization failure).
      await expect(service.revoke(link.id, initiatorUserId, 'admin')).rejects.toMatchObject({
        code: 'INVALID_OBJECT_STATE',
      });
    });
  });

  // =======================================================================
  // pairKey uniqueness (ConflictError) + post-revoke re-initiate
  // =======================================================================

  describe('pairKey partial-uniqueness (ADR-0048 §b)', () => {
    it('a second initiate() between the same two workspaces while the first is still "pending" throws ConflictError', async () => {
      const workspaceA = await createWorkspace('conflict-pending-a');
      const workspaceB = await createWorkspace('conflict-pending-b');
      const actorUserId = await createUser('conflict-pending-actor');

      await service.initiate(workspaceA, workspaceB, actorUserId, 'admin');

      await expect(
        service.initiate(workspaceA, workspaceB, actorUserId, 'admin'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(await countNonRevokedLinksForPair(expectedPairKey(workspaceA, workspaceB))).toBe(1);
    });

    it('a second initiate() between the same two workspaces (reversed order) while the first is "active" throws ConflictError', async () => {
      const workspaceA = await createWorkspace('conflict-active-a');
      const workspaceB = await createWorkspace('conflict-active-b');
      const initiatorUserId = await createUser('conflict-active-initiator');
      const counterpartUserId = await createUser('conflict-active-counterpart');

      const link = await service.initiate(workspaceA, workspaceB, initiatorUserId, 'admin');
      await service.accept(link.id, counterpartUserId, 'admin');

      // Reversed order (B, A) -- must still collide via the direction-
      // independent pairKey, not merely the literal (initiator, counterpart)
      // column order.
      await expect(
        service.initiate(workspaceB, workspaceA, counterpartUserId, 'admin'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(await countNonRevokedLinksForPair(expectedPairKey(workspaceA, workspaceB))).toBe(1);
    });

    it('after a revoke(), a brand-new initiate() between the same two workspaces succeeds (revoked rows are exempt from the partial-unique index)', async () => {
      const workspaceA = await createWorkspace('reinitiate-after-revoke-a');
      const workspaceB = await createWorkspace('reinitiate-after-revoke-b');
      const actorUserId = await createUser('reinitiate-after-revoke-actor');

      const firstLink = await service.initiate(workspaceA, workspaceB, actorUserId, 'admin');
      await service.revoke(firstLink.id, actorUserId, 'admin');

      const secondLink = await service.initiate(workspaceA, workspaceB, actorUserId, 'admin');

      expect(secondLink.status).toBe('pending');
      expect(secondLink.id).not.toBe(firstLink.id);
    });
  });
});
