import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F3-T14 PR1 (RED step), ADR-0048 §d (INSAN ONAYLI) — `FederationLinkCredentialsService`
 * (`./federation-link-credentials.service.ts`, does NOT exist yet as of this
 * commit), backed by a NEW `federation_link_credentials` table
 * (`../db/schema/federation-link-credentials.ts`, ADR-0048 §d, also does not
 * exist yet -- no migration 0047 for it either). Depends on the ALSO
 * not-yet-existing `FederationLinksService` to set up a real link fixture.
 *
 * ============================================================================
 * HARNESS CHOICE: same direct-instantiation, no-Nest-boot,
 * Testcontainers-Postgres-only convention as the other two PR1 integration
 * test files in this directory, and copied 1:1 from
 * `../mcp-server/mcp-client-grants.service.test.ts` -- this service is an
 * explicit "PAT pattern clone keyed by federationLinkId+granteeWorkspaceId
 * instead of workspaceId+userId" (ADR-0048 §d / task description), so this
 * file mirrors that sibling file's fixture/assertion style test-by-test where
 * the shapes correspond (raw-token-never-persisted, expiresAt-never-null,
 * days-offset tolerance, revoke-sets-revokedAt).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./federation-link-credentials.service.ts`
 * nor `./federation-links.service.ts` (nor their schemas/migration) exist
 * yet. `beforeAll`'s dynamic imports reject with "Cannot find module"
 * resolution errors, failing every test in this file at setup -- this is the
 * correct red, not a test-logic bug.
 * ============================================================================
 *
 * JUDGMENT CALL (test-writer's own, not pinned by ADR-0048): the task
 * description only pins `grant(linkId, granteeWorkspaceId, name,
 * expiresAtDays, actorUserId, actorRole)`'s signature explicitly; `revoke`'s
 * exact signature is inferred by direct analogy with
 * `McpClientGrantsService.revoke(workspaceId, userId, grantId)` (ADR-0028),
 * substituting that service's `(workspaceId, userId)` scoping pair for this
 * one's own `(linkId, granteeWorkspaceId)` pair per the task description's
 * explicit "federationLinkId+granteeWorkspaceId imzasıyla kopyası" framing:
 * `revoke(linkId, granteeWorkspaceId, credentialId)`. If `implementer` widens
 * this with an additional `actorUserId`/`actorRole` RBAC pair (plausible,
 * since ADR-0048's RBAC table requires host-side admin+ for credential
 * management), only the one `revoke(...)` call site below needs updating --
 * every other test in this file is independent of that choice.
 *
 * `expiresAtDays`'s TS type is the same closed union
 * (`30 | 90 | 365`) `McpClientGrantsService.grant` already pins (ADR-0028
 * §l) -- the "45 is rejected" test below deliberately casts an out-of-union
 * numeric literal through `as unknown as 30 | 90 | 365` to exercise the
 * RUNTIME validation path a real caller (e.g. a JSON request body in PR2's
 * REST controller, never type-checked by TS at that boundary) would actually
 * hit, mirroring this task's own explicit ask ("zod/tip seviyesinde
 * reddedilen bir değer... çalışma zamanı hatası").
 */

type Role = 'owner' | 'admin' | 'member' | 'guest';
type FederationLinkStatus = 'pending' | 'active' | 'revoked';

interface FederationLink {
  id: string;
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

interface FederationLinkCredential {
  id: string;
  federationLinkId: string;
  granteeWorkspaceId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdByUserId: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

interface FederationLinkCredentialsServiceContract {
  grant(
    linkId: string,
    granteeWorkspaceId: string,
    name: string,
    expiresAtDays: 30 | 90 | 365 | undefined,
    actorUserId: string,
    actorRole: Role,
  ): Promise<{ credential: FederationLinkCredential; rawToken: string }>;
  revoke(
    linkId: string,
    granteeWorkspaceId: string,
    credentialId: string,
  ): Promise<FederationLinkCredential>;
}

type FederationLinkCredentialsServiceConstructor = new (
  db: Database,
) => FederationLinkCredentialsServiceContract;

interface RawCredentialRow {
  id: string;
  federation_link_id: string;
  grantee_workspace_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  revoked_at: string | null;
  expires_at: string | null;
}

describe('FederationLinkCredentialsService (real Postgres via Testcontainers, ADR-0048 §d)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let linksService: FederationLinksServiceContract;
  let service: FederationLinkCredentialsServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://federation-link-credentials-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    const linksModule: unknown = await import('./federation-links.service.js');
    const FederationLinksServiceCtor = (
      linksModule as { FederationLinksService: FederationLinksServiceConstructor }
    ).FederationLinksService;
    linksService = new FederationLinksServiceCtor(db);

    // Deliberately unresolvable until `implementer` creates
    // `./federation-link-credentials.service.ts` -- see this file's header
    // for why the resulting `import-x/no-unresolved` finding is expected and
    // contained to this one line.
    const credentialsModule: unknown = await import('./federation-link-credentials.service.js');
    const FederationLinkCredentialsServiceCtor = (
      credentialsModule as {
        FederationLinkCredentialsService: FederationLinkCredentialsServiceConstructor;
      }
    ).FederationLinkCredentialsService;
    service = new FederationLinkCredentialsServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `federation-link-credentials-test-${label}-${unique}`, slug: unique })
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
        email: `federation-link-credentials-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  /** Creates a real, ACTIVE link between two fresh workspaces -- credentials
   * are always granted against an active (or at least existent) link in
   * these tests. Returns the host-side admin actor id (`createdByUserId`,
   * per ADR-0048 §d's schema comment: "host tarafın admin'i") and the
   * grantee workspace id credentials will be issued to. */
  async function createActiveLinkFixture(label: string): Promise<{
    linkId: string;
    hostAdminUserId: string;
    granteeWorkspaceId: string;
  }> {
    const hostWorkspaceId = await createWorkspace(`${label}-host`);
    const granteeWorkspaceId = await createWorkspace(`${label}-grantee`);
    const hostAdminUserId = await createUser(`${label}-host-admin`);
    const granteeAdminUserId = await createUser(`${label}-grantee-admin`);

    const link = await linksService.initiate(
      hostWorkspaceId,
      granteeWorkspaceId,
      hostAdminUserId,
      'admin',
    );
    await linksService.accept(link.id, granteeAdminUserId, 'admin');

    return { linkId: link.id, hostAdminUserId, granteeWorkspaceId };
  }

  async function rawCredentialRow(credentialId: string): Promise<RawCredentialRow | undefined> {
    const result = await db.$client.query<RawCredentialRow>(
      `select id, federation_link_id, grantee_workspace_id, name, token_hash, token_prefix,
              revoked_at::text as revoked_at, expires_at::text as expires_at
         from federation_link_credentials where id = $1`,
      [credentialId],
    );
    return result.rows[0];
  }

  it('grant() rejects an expiresAtDays outside {30, 90, 365} at runtime (e.g. 45)', async () => {
    const { linkId, hostAdminUserId, granteeWorkspaceId } =
      await createActiveLinkFixture('reject-45');

    await expect(
      service.grant(
        linkId,
        granteeWorkspaceId,
        'Invalid duration fixture',
        45 as unknown as 30 | 90 | 365,
        hostAdminUserId,
        'admin',
      ),
    ).rejects.toBeDefined();
  });

  it('grant() called WITHOUT an expiresAtDays argument defaults to 90 days', async () => {
    const { linkId, hostAdminUserId, granteeWorkspaceId } =
      await createActiveLinkFixture('default-ninety');
    const before = Date.now();

    const { credential } = await service.grant(
      linkId,
      granteeWorkspaceId,
      'Default duration fixture',
      undefined,
      hostAdminUserId,
      'admin',
    );

    const after = Date.now();
    expect(credential.expiresAt).not.toBeNull();
    const expiresAtMs = new Date(credential.expiresAt as Date).getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    expect(expiresAtMs).toBeGreaterThanOrEqual(before + ninetyDaysMs - 5_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + ninetyDaysMs + 5_000);
  });

  it('grant() with expiresAtDays: 30 produces an expiresAt approximately createdAt + 30 days -- expiresAt is NEVER null on any successful grant (ADR-0048 §d regression: no code path writes NULL)', async () => {
    const { linkId, hostAdminUserId, granteeWorkspaceId } =
      await createActiveLinkFixture('thirty-days');
    const before = Date.now();

    const { credential } = await service.grant(
      linkId,
      granteeWorkspaceId,
      'Thirty day fixture',
      30,
      hostAdminUserId,
      'admin',
    );

    const after = Date.now();
    expect(credential.expiresAt).not.toBeNull();
    const expiresAtMs = new Date(credential.expiresAt as Date).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    expect(expiresAtMs).toBeGreaterThanOrEqual(before + thirtyDaysMs - 5_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + thirtyDaysMs + 5_000);

    // Regression guard against the raw persisted row too, not just the
    // returned object -- the ADR-0048 §d discipline this test protects is
    // specifically about what actually lands in the database.
    const row = await rawCredentialRow(credential.id);
    expect(row?.expires_at).not.toBeNull();
  });

  it('grant() with expiresAtDays: 365 also produces a non-null expiresAt approximately createdAt + 365 days', async () => {
    const { linkId, hostAdminUserId, granteeWorkspaceId } =
      await createActiveLinkFixture('year-days');
    const before = Date.now();

    const { credential } = await service.grant(
      linkId,
      granteeWorkspaceId,
      'One year fixture',
      365,
      hostAdminUserId,
      'admin',
    );

    const after = Date.now();
    expect(credential.expiresAt).not.toBeNull();
    const expiresAtMs = new Date(credential.expiresAt as Date).getTime();
    const yearMs = 365 * 24 * 60 * 60 * 1000;

    expect(expiresAtMs).toBeGreaterThanOrEqual(before + yearMs - 5_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + yearMs + 5_000);
  });

  it('grant() returns a rawToken that is never persisted anywhere retrievable -- no column stores the plaintext token, only its sha256 hash', async () => {
    const { linkId, hostAdminUserId, granteeWorkspaceId } =
      await createActiveLinkFixture('never-persisted');

    const { credential, rawToken } = await service.grant(
      linkId,
      granteeWorkspaceId,
      'Plaintext-never-stored fixture',
      90,
      hostAdminUserId,
      'admin',
    );

    expect(rawToken.length).toBeGreaterThan(0);
    expect(credential.tokenHash).not.toBe(rawToken);

    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    expect(credential.tokenHash).toBe(expectedHash);

    const row = await rawCredentialRow(credential.id);
    expect(row).toBeDefined();
    const rowValues = Object.values(row ?? {}).filter(
      (value): value is string => typeof value === 'string',
    );
    for (const value of rowValues) {
      expect(value).not.toBe(rawToken);
    }
  });

  it('revoke() sets revokedAt on the credential, and does not delete the row', async () => {
    const { linkId, hostAdminUserId, granteeWorkspaceId } =
      await createActiveLinkFixture('revoke-sets-revoked-at');

    const { credential } = await service.grant(
      linkId,
      granteeWorkspaceId,
      'To be revoked',
      30,
      hostAdminUserId,
      'admin',
    );
    expect(credential.revokedAt).toBeNull();

    const revoked = await service.revoke(linkId, granteeWorkspaceId, credential.id);
    expect(revoked.revokedAt).not.toBeNull();

    const row = await rawCredentialRow(credential.id);
    expect(row).toBeDefined();
    expect(row?.revoked_at).not.toBeNull();
  });
});
