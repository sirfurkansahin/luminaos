import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UnauthorizedError } from '@luminaos/shared';

import { computePairKey } from './federation-link-state.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { federationLinkCredentials } from '../db/schema/federation-link-credentials.js';
import { federationLinks } from '../db/schema/federation-links.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * F3-T14 PR2 (RED step), ADR-0048 §f — `FederationTokenAuthGuard`
 * (`./federation-token-auth.guard.ts`, does NOT exist yet). ADR-0048 §f pins
 * the EXACT constructor shape this file instantiates against:
 *
 *   constructor(@Inject(DATABASE_CONNECTION) db: Database)
 *
 * ============================================================================
 * HARNESS CHOICE: mirrors `../mcp-server/mcp-token-auth.guard.test.ts` exactly
 * -- a REAL Testcontainers Postgres (the guard's own literal
 * `db.select().from(federationLinkCredentials)...`/`db.select().from
 * (federationLinks)...` lookups, ADR-0048 §f's pinned code), seeded via
 * REAL typed Drizzle inserts (`federationLinks`/`federationLinkCredentials`
 * already exist as of PR1, so no raw-SQL fallback is needed here, unlike
 * PR1's own test files which predate the schema). `ExecutionContext` is a
 * hand-built fake exposing only `switchToHttp().getRequest()`, the minimum
 * surface `canActivate` calls -- no NestJS test module boot required for a
 * plain `CanActivate` class with one constructor-injected dependency.
 *
 * `FederationRequestShape`/`federationGrant` is declared LOCALLY (rather than
 * relying on a `declare module 'express-serve-static-core'` augmentation,
 * which does not exist yet either -- that augmentation lives in
 * `../common/request-context.ts`, a non-test file `implementer` must add to,
 * not `test-writer`).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./federation-token-auth.guard.ts` does not
 * exist. `beforeAll`'s dynamic `import('./federation-token-auth.guard.js')`
 * rejects with a "Cannot find module" resolution error, failing every test in
 * this file at setup -- this is the correct red, not a test-logic bug.
 * ============================================================================
 */

interface FederationGrantShape {
  linkId: string;
  credentialId: string;
  granteeWorkspaceId: string;
  hostWorkspaceId: string;
}

interface FederationRequestShape {
  federationGrant?: FederationGrantShape;
}

type FakeRequest = Partial<Request> & FederationRequestShape;

interface FederationTokenAuthGuardConstructor {
  new (db: Database): CanActivate;
}

function fakeExecutionContext(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function fakeRequest(authorizationHeader?: string): FakeRequest {
  return {
    headers: authorizationHeader ? { authorization: authorizationHeader } : {},
  } as FakeRequest;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

describe('FederationTokenAuthGuard (real Postgres via Testcontainers, ADR-0048 §f)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let FederationTokenAuthGuardCtor: FederationTokenAuthGuardConstructor;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://federation-token-auth-guard-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./federation-token-auth.guard.ts` -- see this file's header for why
    // the resulting `import-x/no-unresolved` finding is expected and
    // contained to this one line.
    const importedModule: unknown = await import('./federation-token-auth.guard.js');
    FederationTokenAuthGuardCtor = (
      importedModule as { FederationTokenAuthGuard: FederationTokenAuthGuardConstructor }
    ).FederationTokenAuthGuard;
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  function buildGuard(): CanActivate {
    return new FederationTokenAuthGuardCtor(db);
  }

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `federation-guard-test-${label}-${unique}`, slug: unique })
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
        email: `federation-guard-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  async function createLink(options: {
    initiatorWorkspaceId: string;
    counterpartWorkspaceId: string;
    initiatedByUserId: string;
    status: 'pending' | 'active' | 'revoked';
  }): Promise<string> {
    const pairKey = computePairKey(options.initiatorWorkspaceId, options.counterpartWorkspaceId);
    const [row] = await db
      .insert(federationLinks)
      .values({
        initiatorWorkspaceId: options.initiatorWorkspaceId,
        counterpartWorkspaceId: options.counterpartWorkspaceId,
        pairKey,
        status: options.status,
        initiatedByUserId: options.initiatedByUserId,
        acceptedAt: options.status !== 'pending' ? new Date() : null,
        revokedAt: options.status === 'revoked' ? new Date() : null,
      })
      .returning({ id: federationLinks.id });

    if (!row) {
      throw new Error('Failed to insert fixture federation link');
    }

    return row.id;
  }

  async function updateLinkStatus(
    linkId: string,
    status: 'pending' | 'active' | 'revoked',
  ): Promise<void> {
    await db.update(federationLinks).set({ status }).where(eq(federationLinks.id, linkId));
  }

  async function seedCredential(options: {
    linkId: string;
    granteeWorkspaceId: string;
    createdByUserId: string;
    revoked?: boolean;
    expiresAt?: Date | null;
  }): Promise<{ credentialId: string; rawToken: string }> {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const [row] = await db
      .insert(federationLinkCredentials)
      .values({
        federationLinkId: options.linkId,
        granteeWorkspaceId: options.granteeWorkspaceId,
        name: 'guard fixture credential',
        tokenHash,
        tokenPrefix: rawToken.slice(0, 12),
        createdByUserId: options.createdByUserId,
        expiresAt:
          options.expiresAt === undefined
            ? new Date(Date.now() + NINETY_DAYS_MS)
            : options.expiresAt,
        revokedAt: options.revoked ? new Date() : null,
      })
      .returning({ id: federationLinkCredentials.id });

    if (!row) {
      throw new Error('Failed to insert fixture federation link credential');
    }

    return { credentialId: row.id, rawToken };
  }

  async function freshLinkFixture(
    label: string,
    status: 'pending' | 'active' | 'revoked',
  ): Promise<{
    linkId: string;
    initiatorWorkspaceId: string;
    counterpartWorkspaceId: string;
  }> {
    const initiatorWorkspaceId = await createWorkspace(`${label}-initiator`);
    const counterpartWorkspaceId = await createWorkspace(`${label}-counterpart`);
    const initiatedByUserId = await createUser(`${label}-initiator`);
    const linkId = await createLink({
      initiatorWorkspaceId,
      counterpartWorkspaceId,
      initiatedByUserId,
      status,
    });
    return { linkId, initiatorWorkspaceId, counterpartWorkspaceId };
  }

  it('1. missing Authorization header -> UnauthorizedError', async () => {
    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(undefined));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('2. malformed header (missing "Bearer " prefix) -> UnauthorizedError', async () => {
    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest('Token abc123'));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('3. malformed header ("Bearer " with an empty token after it) -> UnauthorizedError', async () => {
    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest('Bearer '));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('4. unknown token (never issued) -> UnauthorizedError', async () => {
    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest('Bearer never-issued-federation-token-xyz'));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('5. revoked credential (active link) -> UnauthorizedError (same error type as "unknown" -- ADR-0028 §i\'s 401-collapse discipline, ADR-0048 §f reuses it)', async () => {
    const { linkId, counterpartWorkspaceId } = await freshLinkFixture('revoked-cred', 'active');
    const createdByUserId = await createUser('revoked-cred-admin');
    const { rawToken } = await seedCredential({
      linkId,
      granteeWorkspaceId: counterpartWorkspaceId,
      createdByUserId,
      revoked: true,
    });

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('6. expired credential (active link) -> UnauthorizedError (same error type as "unknown"/"revoked")', async () => {
    const { linkId, counterpartWorkspaceId } = await freshLinkFixture('expired-cred', 'active');
    const createdByUserId = await createUser('expired-cred-admin');
    const pastExpiresAt = new Date(Date.now() - 60_000);
    const { rawToken } = await seedCredential({
      linkId,
      granteeWorkspaceId: counterpartWorkspaceId,
      createdByUserId,
      expiresAt: pastExpiresAt,
    });

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('7. valid, non-revoked, non-expired credential, but its link is still "pending" -> UnauthorizedError (link status never leaks -- same 401 as "unknown")', async () => {
    const { linkId, counterpartWorkspaceId } = await freshLinkFixture('pending-link', 'pending');
    const createdByUserId = await createUser('pending-link-admin');
    const { rawToken } = await seedCredential({
      linkId,
      granteeWorkspaceId: counterpartWorkspaceId,
      createdByUserId,
    });

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('8. valid, non-revoked, non-expired credential, but its link is "revoked" -> UnauthorizedError (same 401, live status check)', async () => {
    const { linkId, counterpartWorkspaceId } = await freshLinkFixture('revoked-link', 'revoked');
    const createdByUserId = await createUser('revoked-link-admin');
    const { rawToken } = await seedCredential({
      linkId,
      granteeWorkspaceId: counterpartWorkspaceId,
      createdByUserId,
    });

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('9. valid credential, active link, grantee is the COUNTERPART side -> returns true, request.federationGrant.hostWorkspaceId resolves to the INITIATOR (the non-grantee end)', async () => {
    const { linkId, initiatorWorkspaceId, counterpartWorkspaceId } = await freshLinkFixture(
      'happy-path-counterpart-grantee',
      'active',
    );
    const createdByUserId = await createUser('happy-path-counterpart-admin');
    const { credentialId, rawToken } = await seedCredential({
      linkId,
      granteeWorkspaceId: counterpartWorkspaceId,
      createdByUserId,
    });

    const guard = buildGuard();
    const request = fakeRequest(`Bearer ${rawToken}`);
    const context = fakeExecutionContext(request);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.federationGrant).toEqual({
      linkId,
      credentialId,
      granteeWorkspaceId: counterpartWorkspaceId,
      hostWorkspaceId: initiatorWorkspaceId,
    });
  });

  it('10. valid credential, active link, grantee is the INITIATOR side -> request.federationGrant.hostWorkspaceId resolves to the COUNTERPART (the non-grantee end) -- proves hostWorkspaceId is derived, not hardcoded to either column', async () => {
    const { linkId, initiatorWorkspaceId, counterpartWorkspaceId } = await freshLinkFixture(
      'happy-path-initiator-grantee',
      'active',
    );
    const createdByUserId = await createUser('happy-path-initiator-admin');
    const { credentialId, rawToken } = await seedCredential({
      linkId,
      granteeWorkspaceId: initiatorWorkspaceId,
      createdByUserId,
    });

    const guard = buildGuard();
    const request = fakeRequest(`Bearer ${rawToken}`);
    const context = fakeExecutionContext(request);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.federationGrant).toEqual({
      linkId,
      credentialId,
      granteeWorkspaceId: initiatorWorkspaceId,
      hostWorkspaceId: counterpartWorkspaceId,
    });
  });

  it('11. LIVE status check: a token that worked while the link was "active" gets an IMMEDIATE 401-equivalent (UnauthorizedError) on the very next call after the link is revoked -- no caching of the earlier successful check', async () => {
    const { linkId, counterpartWorkspaceId } = await freshLinkFixture('live-revoke', 'active');
    const createdByUserId = await createUser('live-revoke-admin');
    const { rawToken } = await seedCredential({
      linkId,
      granteeWorkspaceId: counterpartWorkspaceId,
      createdByUserId,
    });

    const guard = buildGuard();

    const beforeRevoke = await guard.canActivate(
      fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`)),
    );
    expect(beforeRevoke).toBe(true);

    await updateLinkStatus(linkId, 'revoked');

    await expect(
      guard.canActivate(fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`))),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
