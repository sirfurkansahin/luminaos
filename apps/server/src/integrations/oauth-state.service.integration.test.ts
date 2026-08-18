import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F2-T10 PR1 (RED step), ADR-0026 §i — `OAuthStateService`
 * (`./oauth-state.service.ts`, does NOT exist yet), backed by a NEW
 * `oauth_state_tokens` table (`../db/schema/oauth-state-tokens.ts`, ALSO does
 * not exist yet -- no migration for it either).
 *
 * ============================================================================
 * HARNESS CHOICE (mirrors `./connector-credentials.integration.test.ts`'s
 * header reasoning EXACTLY): `OAuthStateService` has exactly one constructor
 * dependency (`Database`) and no controller sits in front of it in THIS file
 * (the controller that consumes it, `mcp-oauth.controller.ts`, is pinned
 * separately by `./mcp-oauth.controller.integration.test.ts`) -- so this
 * file follows `../ai/ai-usage.service.integration.test.ts`'s direct-
 * instantiation, no-Nest-boot, Testcontainers-Postgres-only precedent,
 * rather than a full app-boot + supertest shape. `REDIS_URL` is set to an
 * inert placeholder only because `../config/env.js` exits fatally at import
 * time if unset -- nothing here connects to it.
 *
 * `oauth_state_tokens` SCHEMA (ADR-0026 §i, pinned verbatim):
 *   - state varchar(64) PRIMARY KEY -- base64url(randomBytes(32)), ~43 chars
 *   - workspace_id uuid NOT NULL FK -> workspaces.id (cascade)
 *   - user_id uuid NOT NULL FK -> users.id (cascade)
 *   - connector_type varchar(50) NOT NULL
 *   - created_at timestamptz NOT NULL DEFAULT now()
 *   - expires_at timestamptz NOT NULL
 * TTL: 10 minutes from `issue()` (ADR-0026 §i). No proactive cleanup of
 * expired rows (accepted operational debt, ADR-0026 §i) -- irrelevant to
 * this file's assertions, which only ever manipulate `expires_at` directly
 * via raw SQL to simulate an already-expired row deterministically, never
 * by waiting out a real 10-minute TTL.
 *
 * Since `../db/schema/oauth-state-tokens.ts` does not exist yet, this file
 * cannot statically import a typed Drizzle schema object for it -- raw
 * `db.$client.query(...)` SQL is used for every direct-row assertion/seed,
 * mirroring `./connector-credentials.integration.test.ts`'s identical
 * "schema doesn't exist yet" raw-SQL convention.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./oauth-state.service.ts` nor
 * `../db/schema/oauth-state-tokens.ts` (nor its migration) exist yet.
 * `beforeAll`'s dynamic `import('./oauth-state.service.js')` rejects with a
 * "Cannot find module" resolution error, failing every test in this file at
 * setup -- this is the correct red, not a test-logic bug. (Once the service
 * module exists but the migration doesn't, the red state shifts to each raw
 * SQL query rejecting with `relation "oauth_state_tokens" does not exist`,
 * equally a legitimate "implementation incomplete" red.)
 * ============================================================================
 */

/**
 * The public contract ADR-0026 §i pins for `OAuthStateService`, declared
 * LOCALLY (rather than a top-level `import type` from the not-yet-existing
 * module) so this file's dynamic import below degrades to a single,
 * isolated, EXPECTED `import-x/no-unresolved` finding at that one import
 * site -- mirrors `./connector-credentials.integration.test.ts`'s
 * `ConnectorCredentialsServiceContract` pattern exactly.
 */
interface OAuthStateServiceContract {
  issue(workspaceId: string, userId: string, connectorType: string): Promise<string>;
  consume(state: string): Promise<{ workspaceId: string; userId: string; connectorType: string }>;
}

type OAuthStateServiceConstructor = new (db: Database) => OAuthStateServiceContract;

interface RawOAuthStateRow {
  state: string;
  workspace_id: string;
  user_id: string;
  connector_type: string;
  created_at: Date;
  expires_at: Date;
}

const BASE64URL_STATE_PATTERN = /^[A-Za-z0-9_-]+$/;

describe('OAuthStateService (real Postgres via Testcontainers, ADR-0026 §i)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let service: OAuthStateServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://oauth-state-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./oauth-state.service.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained
    // to this one line.
    const importedModule: unknown = await import('./oauth-state.service.js');
    const OAuthStateServiceCtor = (
      importedModule as { OAuthStateService: OAuthStateServiceConstructor }
    ).OAuthStateService;
    service = new OAuthStateServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(name: string): Promise<string> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name, slug: crypto.randomUUID() })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  async function createUser(email: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: 'not-a-real-hash-fixture-only' })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${email}"`);
    }

    return user.id;
  }

  async function freshWorkspaceAndUser(label: string): Promise<{
    workspaceId: string;
    userId: string;
  }> {
    const unique = crypto.randomUUID();
    const workspaceId = await createWorkspace(`oauth-state-test-${label}-${unique}`);
    const userId = await createUser(`oauth-state-test-${label}-${unique}@example.com`);
    return { workspaceId, userId };
  }

  async function rawRow(state: string): Promise<RawOAuthStateRow | undefined> {
    const result = await db.$client.query<RawOAuthStateRow>(
      `select state, workspace_id, user_id, connector_type, created_at, expires_at
         from oauth_state_tokens where state = $1`,
      [state],
    );
    return result.rows[0];
  }

  async function expireState(state: string): Promise<void> {
    await db.$client.query(
      `update oauth_state_tokens set expires_at = now() - interval '1 minute' where state = $1`,
      [state],
    );
  }

  it('1. issue() returns an opaque, base64url-charset token of the expected length (32 random bytes, base64url-encoded, no padding)', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('opaque-shape');

    const state = await service.issue(workspaceId, userId, 'notion');

    expect(typeof state).toBe('string');
    expect(state.length).toBe(43);
    expect(BASE64URL_STATE_PATTERN.test(state)).toBe(true);
  });

  it('2. issue() persists a row with expiresAt ~10 minutes (600_000ms) after createdAt', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('ttl');

    const state = await service.issue(workspaceId, userId, 'notion');

    const row = await rawRow(state);
    expect(row).toBeDefined();
    const deltaMs = (row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0);
    expect(deltaMs).toBeGreaterThan(9 * 60 * 1000);
    expect(deltaMs).toBeLessThan(11 * 60 * 1000);
  });

  it('3. consume() on a valid, unexpired state returns the exact (workspaceId, userId, connectorType) triple it was issued with', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('roundtrip');

    const state = await service.issue(workspaceId, userId, 'notion');
    const result = await service.consume(state);

    expect(result).toEqual({ workspaceId, userId, connectorType: 'notion' });
  });

  it('4. consume() is single-use: the row is deleted on a successful consume(), and a SECOND consume() with the same state throws ForbiddenError', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('single-use');

    const state = await service.issue(workspaceId, userId, 'notion');
    await service.consume(state);

    expect(await rawRow(state)).toBeUndefined();
    await expect(service.consume(state)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('5. consume() on a state that was never issued throws ForbiddenError', async () => {
    const neverIssuedState = crypto.randomBytes(32).toString('base64url');

    await expect(service.consume(neverIssuedState)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('6. consume() on an expired (but otherwise valid) state throws ForbiddenError, and does NOT delete the row (nothing to clean up proactively, ADR-0026 §i)', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('expired');

    const state = await service.issue(workspaceId, userId, 'notion');
    await expireState(state);

    await expect(service.consume(state)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('7. consume() never reveals WHICH failure case occurred -- the error message for a never-issued state and for a genuinely-expired state are indistinguishable (deliberate CSRF-token-verification discipline, ADR-0026 §i)', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('no-leak');

    const expiredState = await service.issue(workspaceId, userId, 'notion');
    await expireState(expiredState);

    const neverIssuedState = crypto.randomBytes(32).toString('base64url');

    let expiredMessage: string | undefined;
    let neverIssuedMessage: string | undefined;

    try {
      await service.consume(expiredState);
    } catch (error) {
      expiredMessage = error instanceof Error ? error.message : undefined;
    }

    try {
      await service.consume(neverIssuedState);
    } catch (error) {
      neverIssuedMessage = error instanceof Error ? error.message : undefined;
    }

    expect(expiredMessage).toBeDefined();
    expect(neverIssuedMessage).toBeDefined();
    expect(expiredMessage).toBe(neverIssuedMessage);
    expect(expiredMessage?.toLowerCase()).not.toContain('expired');
    expect(expiredMessage?.toLowerCase()).not.toContain('not found');
  });

  it('8. cross-workspace/cross-user isolation: two different issue() calls never collide, and each consume() returns exactly its own triple', async () => {
    const first = await freshWorkspaceAndUser('cross-a');
    const second = await freshWorkspaceAndUser('cross-b');

    const stateA = await service.issue(first.workspaceId, first.userId, 'notion');
    const stateB = await service.issue(second.workspaceId, second.userId, 'slack');

    expect(stateA).not.toBe(stateB);

    const resultB = await service.consume(stateB);
    expect(resultB).toEqual({
      workspaceId: second.workspaceId,
      userId: second.userId,
      connectorType: 'slack',
    });

    const resultA = await service.consume(stateA);
    expect(resultA).toEqual({
      workspaceId: first.workspaceId,
      userId: first.userId,
      connectorType: 'notion',
    });
  });

  it('9. the same (workspaceId, userId) issuing states for two DIFFERENT connectorTypes gets two independent, non-colliding states', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('multi-connector');

    const notionState = await service.issue(workspaceId, userId, 'notion');
    const slackState = await service.issue(workspaceId, userId, 'slack');

    expect(notionState).not.toBe(slackState);

    const notionResult = await service.consume(notionState);
    expect(notionResult.connectorType).toBe('notion');

    const slackResult = await service.consume(slackState);
    expect(slackResult.connectorType).toBe('slack');
  });
});
