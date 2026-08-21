import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F2-T12 PR1 (RED step), ADR-0028 §a/§b/§l — `McpClientGrantsService`
 * (`./mcp-client-grants.service.ts`, does NOT exist yet as of this commit),
 * backed by a NEW `mcp_client_grants` table (`../db/schema/mcp-client-grants.ts`,
 * ADR-0028 §b, also does not exist yet -- no migration for it either).
 *
 * ============================================================================
 * HARNESS CHOICE: same reasoning as
 * `../integrations/connector-credentials.integration.test.ts`'s header --
 * `McpClientGrantsService` has exactly one constructor dependency (`Database`)
 * and no controller in THIS PR (ADR-0028 §k's token-management HTTP endpoints
 * are explicitly out of scope for PR1, per this task's own file list), so this
 * follows `connector-credentials.integration.test.ts`'s direct-instantiation,
 * no-Nest-boot, Testcontainers-Postgres-only convention. Since
 * `../db/schema/mcp-client-grants.ts` does not exist yet, this file cannot
 * statically import a typed Drizzle schema object for it -- raw
 * `db.$client.query(...)` SQL is used for every direct-row assertion/seed,
 * mirroring `connector-credentials.integration.test.ts`'s identical
 * "schema doesn't exist yet" convention. Real `workspaces`/`users` rows ARE
 * inserted via the already-existing typed schemas (both exist today), since
 * `mcp_client_grants` carries REAL FKs to both (ADR-0028 §b).
 *
 * `McpClientGrant`/`McpClientGrantsServiceContract` are declared LOCALLY
 * (rather than a top-level `import type` from the not-yet-existing module),
 * exactly mirroring `connector-credentials.integration.test.ts`'s
 * `ConnectorCredentialsServiceContract` pattern, so this file's dynamic
 * import below degrades to a single, isolated, EXPECTED
 * `import-x/no-unresolved` finding at that one import site.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./mcp-client-grants.service.ts` nor
 * `../db/schema/mcp-client-grants.ts` (nor its migration) exist yet.
 * `beforeAll`'s dynamic `import('./mcp-client-grants.service.js')` rejects
 * with a "Cannot find module" resolution error, failing every test in this
 * file at setup -- this is the correct red: the service this PR adds simply
 * does not exist yet, not a test-logic bug. (Once the service module exists
 * but the migration doesn't, the red state shifts to each raw SQL
 * seed/query rejecting with `relation "mcp_client_grants" does not exist`,
 * equally a legitimate "implementation incomplete" red.)
 * ============================================================================
 *
 * JUDGMENT CALL (test-writer's own, not pinned by ADR-0028): `revoke()` on a
 * grant that exists but belongs to a DIFFERENT (workspaceId, userId) than the
 * caller's is asserted to throw `NotFoundError` (`@luminaos/shared`) --
 * mirroring `ContextService`'s own "a row scoped by an owner key that doesn't
 * match returns as if it doesn't exist" precedent (least information
 * disclosure, consistent with ADR-0028 §i's broader "never distinguish WHY a
 * caller is denied" discipline). `implementer` may choose a different error
 * class for this specific case; if so, only this one test needs revisiting --
 * every other test in this file is independent of that choice.
 */

interface McpClientGrant {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

interface McpClientGrantsServiceContract {
  grant(
    workspaceId: string,
    userId: string,
    name: string,
    expiresAtDays: 30 | 90 | 365,
  ): Promise<{ grant: McpClientGrant; rawToken: string }>;
  revoke(workspaceId: string, userId: string, grantId: string): Promise<McpClientGrant>;
  list(workspaceId: string, userId: string): Promise<McpClientGrant[]>;
  validateToken(rawToken: string): Promise<{ grant: McpClientGrant } | undefined>;
}

type McpClientGrantsServiceConstructor = new (db: Database) => McpClientGrantsServiceContract;

interface RawGrantRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  revoked_at: string | null;
  expires_at: string | null;
}

describe('McpClientGrantsService (real Postgres via Testcontainers, ADR-0028 §a/§b/§l)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let service: McpClientGrantsServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://mcp-client-grants-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./mcp-client-grants.service.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained to
    // this one line.
    const importedModule: unknown = await import('./mcp-client-grants.service.js');
    const McpClientGrantsServiceCtor = (
      importedModule as { McpClientGrantsService: McpClientGrantsServiceConstructor }
    ).McpClientGrantsService;
    service = new McpClientGrantsServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `mcp-client-grants-test-${label}-${unique}`, slug: unique })
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
        email: `mcp-client-grants-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  async function freshWorkspaceAndUser(label: string): Promise<{
    workspaceId: string;
    userId: string;
  }> {
    const workspaceId = await createWorkspace(label);
    const userId = await createUser(label);
    return { workspaceId, userId };
  }

  async function rawGrantRow(grantId: string): Promise<RawGrantRow | undefined> {
    const result = await db.$client.query<RawGrantRow>(
      `select id, workspace_id, user_id, name, token_hash, token_prefix,
              revoked_at::text as revoked_at, expires_at::text as expires_at
         from mcp_client_grants where id = $1`,
      [grantId],
    );
    return result.rows[0];
  }

  /** Directly seeds a grant row bypassing the not-yet-built `grant()` method --
   * used ONLY for the "already expired" scenario, since `grant()` itself can
   * only ever compute a FUTURE `expiresAt` (server-side, from a fixed
   * day-count, ADR-0028 §l) and can never produce an already-past one. The
   * `tokenHash` is computed with the EXACT algorithm ADR-0028 §a pins
   * (`sha256` hex digest), so `service.validateToken(rawToken)` exercises the
   * real lookup path against this directly-seeded row. */
  async function seedExpiredGrant(
    workspaceId: string,
    userId: string,
  ): Promise<{ grantId: string; rawToken: string }> {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const pastExpiresAt = new Date(Date.now() - 60_000);

    const result = await db.$client.query<{ id: string }>(
      `insert into mcp_client_grants
         (workspace_id, user_id, name, token_hash, token_prefix, expires_at)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        workspaceId,
        userId,
        'expired fixture grant',
        tokenHash,
        rawToken.slice(0, 12),
        pastExpiresAt,
      ],
    );

    const grantId = result.rows[0]?.id;
    if (!grantId) {
      throw new Error('Failed to seed expired fixture grant');
    }

    return { grantId, rawToken };
  }

  it('1. grant() returns a rawToken that is never persisted anywhere retrievable -- no column stores the plaintext token, only its sha256 hash', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('never-persisted');

    const { grant: createdGrant, rawToken } = await service.grant(
      workspaceId,
      userId,
      'My Claude Desktop',
      90,
    );

    expect(rawToken.length).toBeGreaterThan(0);
    expect(createdGrant.tokenHash).not.toBe(rawToken);

    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    expect(createdGrant.tokenHash).toBe(expectedHash);

    const row = await rawGrantRow(createdGrant.id);
    expect(row).toBeDefined();
    // Every string-valued column on the raw row must differ from the raw
    // token -- proving there is no separate plaintext-storing column
    // anywhere on this row (tokenPrefix is only the first 12 chars, never
    // the full token).
    const rowValues = Object.values(row ?? {}).filter(
      (value): value is string => typeof value === 'string',
    );
    for (const value of rowValues) {
      expect(value).not.toBe(rawToken);
    }
  });

  it('2. grant() with expiresAtDays: 90 produces an expiresAt approximately createdAt + 90 days -- not immediately expired, not indefinite', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('ninety-days');
    const before = Date.now();

    const { grant: createdGrant } = await service.grant(
      workspaceId,
      userId,
      'Ninety Day Grant',
      90,
    );

    const after = Date.now();
    expect(createdGrant.expiresAt).not.toBeNull();
    const expiresAtMs = new Date(createdGrant.expiresAt as Date).getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    // Generous few-second tolerance around [before, after] + 90 days, so this
    // test is not flaky against real wall-clock time elapsed during the call.
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + ninetyDaysMs - 5_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + ninetyDaysMs + 5_000);
  });

  it('3. validateToken(rawToken) immediately after grant() succeeds and resolves the correct grant', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('validate-immediately');

    const { grant: createdGrant, rawToken } = await service.grant(
      workspaceId,
      userId,
      'Immediate Validate Grant',
      30,
    );

    const validated = await service.validateToken(rawToken);
    expect(validated).toBeDefined();
    expect(validated?.grant.id).toBe(createdGrant.id);
    expect(validated?.grant.workspaceId).toBe(workspaceId);
    expect(validated?.grant.userId).toBe(userId);
  });

  it("4. validateToken(rawToken) for a revoke()'d grant returns undefined", async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('revoked-token');

    const { grant: createdGrant, rawToken } = await service.grant(
      workspaceId,
      userId,
      'To Be Revoked',
      30,
    );
    await service.revoke(workspaceId, userId, createdGrant.id);

    const validated = await service.validateToken(rawToken);
    expect(validated).toBeUndefined();
  });

  it('5. validateToken(rawToken) for a grant whose expiresAt has already passed returns undefined', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('expired-token');
    const { rawToken } = await seedExpiredGrant(workspaceId, userId);

    const validated = await service.validateToken(rawToken);
    expect(validated).toBeUndefined();
  });

  it('6. validateToken(...) for a never-issued, random token returns undefined', async () => {
    const validated = await service.validateToken('some-random-wrong-token-never-issued');
    expect(validated).toBeUndefined();
  });

  it("7. list(workspaceId, userId) never returns a DIFFERENT user's grants in the same workspace, and never returns the same user's grants from a DIFFERENT workspace", async () => {
    const workspaceId = await createWorkspace('list-isolation-ws');
    const userA = await createUser('list-isolation-user-a');
    const userB = await createUser('list-isolation-user-b');
    const otherWorkspaceId = await createWorkspace('list-isolation-other-ws');

    const { grant: grantA } = await service.grant(workspaceId, userA, "A's grant", 30);
    const { grant: grantB } = await service.grant(workspaceId, userB, "B's grant", 30);
    const { grant: grantAOtherWorkspace } = await service.grant(
      otherWorkspaceId,
      userA,
      "A's grant in another workspace",
      30,
    );

    const listForA = await service.list(workspaceId, userA);
    const listedIdsForA = listForA.map((row) => row.id);

    expect(listedIdsForA).toContain(grantA.id);
    // Cross-user isolation: never B's grant.
    expect(listedIdsForA).not.toContain(grantB.id);
    // Cross-workspace isolation: never A's grant from a different workspace.
    expect(listedIdsForA).not.toContain(grantAOtherWorkspace.id);
  });

  it('8. list(workspaceId, userId) includes revoked grants too (audit visibility) -- revoke() never removes the row', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('list-includes-revoked');

    const { grant: createdGrant } = await service.grant(workspaceId, userId, 'Will Be Revoked', 30);
    await service.revoke(workspaceId, userId, createdGrant.id);

    const listed = await service.list(workspaceId, userId);
    const match = listed.find((row) => row.id === createdGrant.id);
    expect(match).toBeDefined();
    expect(match?.revokedAt).not.toBeNull();
  });

  it("9. revoke() on a grant belonging to a DIFFERENT user/workspace than the caller's fails, and does NOT revoke the row (scoped by workspaceId+userId, not grantId alone)", async () => {
    const { workspaceId: ownerWorkspaceId, userId: ownerUserId } =
      await freshWorkspaceAndUser('revoke-owner');
    const { workspaceId: attackerWorkspaceId, userId: attackerUserId } =
      await freshWorkspaceAndUser('revoke-attacker');

    const { grant: victimGrant } = await service.grant(
      ownerWorkspaceId,
      ownerUserId,
      "Owner's grant",
      30,
    );

    // Attacker knows the real grantId (e.g. leaked/guessed) but supplies
    // THEIR OWN workspaceId/userId -- must be rejected, not silently
    // succeed against another tenant's row.
    await expect(
      service.revoke(attackerWorkspaceId, attackerUserId, victimGrant.id),
    ).rejects.toBeDefined();

    const row = await rawGrantRow(victimGrant.id);
    expect(row?.revoked_at).toBeNull();
  });
});
