import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { SessionService, SessionUser } from '../auth/session.service.js';
import type { Database } from '../db/client.js';
import type { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * F2-T12 PR1 (RED step), ADR-0028 §i/§m — `McpTokenAuthGuard`
 * (`./mcp-token-auth.guard.ts`, does NOT exist yet). ADR-0028 §m pins the
 * EXACT constructor shape this file instantiates against:
 *
 *   constructor(
 *     @Inject(DATABASE_CONNECTION) db: Database,
 *     sessionService: SessionService,
 *     membershipService: WorkspaceMembershipService,
 *   )
 *
 * ============================================================================
 * HARNESS CHOICE: `McpTokenAuthGuard` does its own raw `db.select().from
 * (mcpClientGrants)...` lookup (ADR-0028 §m's literal code), rather than
 * delegating to `McpClientGrantsService` -- so this file uses a REAL
 * Testcontainers Postgres (seeding `mcp_client_grants` rows directly via raw
 * SQL, mirroring `./mcp-client-grants.service.test.ts`'s and
 * `./mcp-inbound-rate-limit.service.test.ts`'s identical "schema doesn't
 * exist yet, raw SQL" convention) for the ONE genuinely stateful dependency,
 * combined with hand-mocked `SessionService`/`WorkspaceMembershipService`
 * objects (`vi.fn()`-based, `as unknown as ...` cast) for the other two --
 * mirroring `../search/connected-search.service.test.ts`'s
 * `createCredentialsServiceMock`/`createRateLimitServiceMock` pattern for
 * constructor-injected collaborators that are themselves already covered by
 * their OWN dedicated test files elsewhere. `ExecutionContext` is a
 * hand-built fake exposing only `switchToHttp().getRequest()` (the only
 * method `canActivate` calls), the minimum surface needed -- no NestJS test
 * module boot required for a plain `CanActivate` class with three
 * constructor-injected dependencies.
 *
 * The token hashing algorithm asserted against here (`sha256` hex digest,
 * `crypto.createHash('sha256').update(token).digest('hex')`) is ADR-0028 §a's
 * OWN pinned algorithm, reproduced here only to SEED rows directly -- not a
 * guess.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./mcp-token-auth.guard.ts` does not exist, and
 * neither does `../db/schema/mcp-client-grants.ts` (nor its migration).
 * `beforeAll`'s dynamic `import('./mcp-token-auth.guard.js')` rejects with a
 * "Cannot find module" resolution error, failing every test in this file at
 * setup -- this is the correct red, not a test-logic bug. (Once the guard
 * module exists but the migration doesn't, the red state shifts to each raw
 * SQL seed query rejecting with `relation "mcp_client_grants" does not
 * exist`, equally a legitimate "implementation incomplete" red.)
 * ============================================================================
 */

interface McpRequestShape {
  user?: { id: string; email: string };
  membership?: { workspaceId: string; role: string };
  mcpGrant?: { id: string };
}

type FakeRequest = Partial<Request> & McpRequestShape;

interface McpTokenAuthGuardConstructor {
  new (
    db: Database,
    sessionService: SessionService,
    membershipService: WorkspaceMembershipService,
  ): CanActivate;
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
  return { headers: authorizationHeader ? { authorization: authorizationHeader } : {} };
}

describe('McpTokenAuthGuard (real Postgres via Testcontainers for the grant lookup, ADR-0028 §i/§m)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let McpTokenAuthGuardCtor: McpTokenAuthGuardConstructor;

  let findUserById: ReturnType<typeof vi.fn<SessionService['findUserById']>>;
  let assertMembership: ReturnType<typeof vi.fn<WorkspaceMembershipService['assertMembership']>>;
  let sessionServiceMock: SessionService;
  let membershipServiceMock: WorkspaceMembershipService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://mcp-token-auth-guard-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./mcp-token-auth.guard.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained to
    // this one line.
    const importedModule: unknown = await import('./mcp-token-auth.guard.js');
    McpTokenAuthGuardCtor = (importedModule as { McpTokenAuthGuard: McpTokenAuthGuardConstructor })
      .McpTokenAuthGuard;
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  beforeEach(() => {
    findUserById = vi.fn<SessionService['findUserById']>();
    assertMembership = vi.fn<WorkspaceMembershipService['assertMembership']>();
    sessionServiceMock = { findUserById } as unknown as SessionService;
    membershipServiceMock = { assertMembership } as unknown as WorkspaceMembershipService;
  });

  function buildGuard(): CanActivate {
    return new McpTokenAuthGuardCtor(db, sessionServiceMock, membershipServiceMock);
  }

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `mcp-token-auth-guard-test-${label}-${unique}`, slug: unique })
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
        email: `mcp-token-auth-guard-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  async function seedGrant(options: {
    workspaceId: string;
    userId: string;
    revoked?: boolean;
    expiresAt?: Date | null;
  }): Promise<{ grantId: string; rawToken: string }> {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const revokedAt = options.revoked ? new Date() : null;
    const expiresAt = options.expiresAt ?? null;

    const result = await db.$client.query<{ id: string }>(
      `insert into mcp_client_grants
         (workspace_id, user_id, name, token_hash, token_prefix, expires_at, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        options.workspaceId,
        options.userId,
        'guard fixture grant',
        tokenHash,
        rawToken.slice(0, 12),
        expiresAt,
        revokedAt,
      ],
    );

    const grantId = result.rows[0]?.id;
    if (!grantId) {
      throw new Error('Failed to seed fixture mcp_client_grants row');
    }

    return { grantId, rawToken };
  }

  async function freshWorkspaceAndUser(label: string): Promise<{
    workspaceId: string;
    userId: string;
  }> {
    const workspaceId = await createWorkspace(label);
    const userId = await createUser(label);
    return { workspaceId, userId };
  }

  it('1. missing Authorization header -> UnauthorizedError', async () => {
    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(undefined));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(findUserById).not.toHaveBeenCalled();
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
    const context = fakeExecutionContext(fakeRequest('Bearer never-issued-token-xyz'));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(findUserById).not.toHaveBeenCalled();
  });

  it('5. revoked token -> UnauthorizedError (same error type as "unknown" -- indistinguishable to the caller, ADR-0028 §i)', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('revoked');
    const { rawToken } = await seedGrant({ workspaceId, userId, revoked: true });

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(findUserById).not.toHaveBeenCalled();
  });

  it('6. expired token -> UnauthorizedError (same error type as "unknown"/"revoked" -- indistinguishable, ADR-0028 §i)', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('expired');
    const pastExpiresAt = new Date(Date.now() - 60_000);
    const { rawToken } = await seedGrant({ workspaceId, userId, expiresAt: pastExpiresAt });

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(findUserById).not.toHaveBeenCalled();
  });

  it('7. valid token, but SessionService.findUserById resolves null (deleted user) -> UnauthorizedError', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('deleted-user');
    const { rawToken } = await seedGrant({ workspaceId, userId });
    findUserById.mockResolvedValue(null);

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(assertMembership).not.toHaveBeenCalled();
  });

  it('8. valid token, valid user, but the user is NO LONGER a member of the grant\'s workspaceId -> ForbiddenError (403) -- the "live membership check" proving a token cannot outlive membership without revocation', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('removed-from-workspace');
    const { rawToken } = await seedGrant({ workspaceId, userId });

    const sessionUser: SessionUser = {
      id: userId,
      email: 'removed@example.com',
      createdAt: new Date(),
    };
    findUserById.mockResolvedValue(sessionUser);
    assertMembership.mockRejectedValue(new ForbiddenError());

    const guard = buildGuard();
    const context = fakeExecutionContext(fakeRequest(`Bearer ${rawToken}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenError);
    expect(assertMembership).toHaveBeenCalledWith(userId, workspaceId);
  });

  it('9. valid token, valid user, valid CURRENT membership -> returns true, and request.user/request.membership/request.mcpGrant are populated exactly per ADR-0028 §m', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('happy-path');
    const { grantId, rawToken } = await seedGrant({ workspaceId, userId });

    const sessionUser: SessionUser = {
      id: userId,
      email: 'happy-path@example.com',
      createdAt: new Date(),
    };
    findUserById.mockResolvedValue(sessionUser);
    assertMembership.mockResolvedValue({ workspaceId, role: 'member' });

    const guard = buildGuard();
    const request = fakeRequest(`Bearer ${rawToken}`);
    const context = fakeExecutionContext(request);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toEqual({ id: userId, email: 'happy-path@example.com' });
    expect(request.membership).toEqual({ workspaceId, role: 'member' });
    expect(request.mcpGrant).toEqual({ id: grantId });
  });
});
