import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F2-T9 PR2 (RED step), ADR-0025 §k — `ConnectorCredentialsService`
 * (`./connector-credentials.service.ts`, does NOT exist yet as of this
 * commit), backed by a NEW `connector_credentials` table
 * (`../db/schema/connector-credentials.ts`, ADR-0025 §i, ALSO does not exist
 * yet -- no migration for it either).
 *
 * ============================================================================
 * HARNESS CHOICE (deviates from `../calendar/calendar-token-refresh.integration.test.ts`'s
 * full-Nest-app-boot + supertest shape, deliberately): `ConnectorCredentialsService`
 * has exactly one constructor dependency (`Database`, injected via
 * `@Inject(DATABASE_CONNECTION)` in the real `@Injectable()` -- see ADR-0025
 * §k, and `env.encryptionKey` read directly at call time, same as
 * `CalendarTokenEncryptionService`) and NO controller sits in front of it
 * (ADR-0025 §n: no public REST endpoint in this task). This is EXACTLY the
 * shape `../ai/ai-usage.service.integration.test.ts` already established as
 * this codebase's own precedent for a DB-backed, DI-free-instantiation,
 * no-Nest-boot, no-Redis-container integration test (`new AIUsageServiceCtor(db, ...)`
 * against a real Testcontainers Postgres) -- a strictly closer precedent than
 * the calendar HTTP-harness file for a service with zero HTTP surface, so
 * this file follows IT instead, per the task brief's own explicit permission
 * to pick "whichever is more reliable in this codebase's existing... convention"
 * when a closer precedent exists. `REDIS_URL` is still set (to an inert
 * placeholder, exactly like `ai-usage.service.integration.test.ts` does) only
 * because `../config/env.js` fatally exits at import time if it's unset --
 * nothing in this file ever actually connects to it.
 *
 * `ENCRYPTION_KEY` env var name/format: copied verbatim from
 * `../calendar/calendar-accounts.integration.test.ts` / `calendar-token-refresh.integration.test.ts`
 * -- `process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64')`,
 * a valid 32-byte AES-256 key, base64-encoded, set in `beforeAll` BEFORE the
 * dynamic `./connector-credentials.service.js` import (ADR-0025 §k: this
 * service reuses `env.encryptionKey`, no new env var).
 *
 * Since `../db/schema/connector-credentials.ts` does not exist yet, this file
 * cannot statically import a typed Drizzle schema object for it (would fail
 * `pnpm typecheck` today) -- raw `db.$client.query(...)` SQL is used for every
 * direct-row assertion instead, mirroring
 * `../calendar/calendar-accounts.integration.test.ts`'s test 5
 * ("raw-row encryption proof") and `../ai/ai-usage.service.integration.test.ts`'s
 * `seedUsageRow`/`getLatestRowForWorkspace` raw-SQL convention, for the exact
 * same "schema doesn't exist yet" reason.
 *
 * `workspaceId`/`userId` fixtures are real rows inserted directly via the
 * ALREADY-EXISTING typed `workspaces`/`users` Drizzle schemas (both exist
 * today) -- no HTTP registration/session flow needed, since
 * `ConnectorCredentialsService` has no controller/guards in front of it
 * (ADR-0025 §n) and `connector_credentials`'s FKs only need the referenced
 * rows to exist, not a real auth session.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./connector-credentials.service.ts`
 * nor `../db/schema/connector-credentials.ts` (nor its migration) exist yet.
 * `beforeAll`'s dynamic `import('./connector-credentials.service.js')`
 * rejects with a "Cannot find module" resolution error, failing every test in
 * this file at setup -- this is the correct red: the service this PR adds
 * simply does not exist yet, not a test-logic bug. (Once the service module
 * exists but the migration doesn't, the red state shifts to each raw SQL
 * query rejecting with `relation "connector_credentials" does not exist`,
 * which is equally a legitimate "implementation incomplete" red, not a
 * test-logic bug.)
 * ============================================================================
 */

/**
 * The public contract ADR-0025 §k pins for `ConnectorCredentialsService`,
 * declared LOCALLY (rather than a top-level `import type` from the
 * not-yet-existing module) so this file's dynamic import below degrades to a
 * single, isolated, EXPECTED `import-x/no-unresolved` finding at that one
 * import site, instead of cascading `@typescript-eslint/no-unsafe-*` errors
 * through every call site below -- mirrors
 * `../ai/ai-usage.service.integration.test.ts`'s `AIUsageServiceContract`
 * pattern exactly.
 */
interface ConnectorCredentialsServiceContract {
  store(
    workspaceId: string,
    userId: string,
    connectorType: string,
    credentials: Record<string, unknown>,
  ): Promise<{ id: string; connectorType: string }>;
  retrieve(
    workspaceId: string,
    userId: string,
    connectorType: string,
  ): Promise<Record<string, unknown> | undefined>;
  remove(workspaceId: string, userId: string, connectorType: string): Promise<void>;
}

type ConnectorCredentialsServiceConstructor = new (
  db: Database,
) => ConnectorCredentialsServiceContract;

interface RawCredentialsRow {
  id: string;
  encrypted_credentials: string;
}

describe('ConnectorCredentialsService (real Postgres via Testcontainers, ADR-0025 §k)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let service: ConnectorCredentialsServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://connector-credentials-test-placeholder:6379';
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./connector-credentials.service.ts` -- see this file's header for why
    // the resulting `import-x/no-unresolved` finding is expected and
    // contained to this one line.
    const importedModule: unknown = await import('./connector-credentials.service.js');
    const ConnectorCredentialsServiceCtor = (
      importedModule as { ConnectorCredentialsService: ConnectorCredentialsServiceConstructor }
    ).ConnectorCredentialsService;
    service = new ConnectorCredentialsServiceCtor(db);
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
    const workspaceId = await createWorkspace(`connector-credentials-test-${label}-${unique}`);
    const userId = await createUser(`connector-credentials-test-${label}-${unique}@example.com`);
    return { workspaceId, userId };
  }

  async function rawRow(
    workspaceId: string,
    userId: string,
    connectorType: string,
  ): Promise<RawCredentialsRow | undefined> {
    const result = await db.$client.query<RawCredentialsRow>(
      `select id, encrypted_credentials from connector_credentials
         where workspace_id = $1 and user_id = $2 and connector_type = $3`,
      [workspaceId, userId, connectorType],
    );
    return result.rows[0];
  }

  async function rowCount(
    workspaceId: string,
    userId: string,
    connectorType: string,
  ): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      `select count(*)::text as count from connector_credentials
         where workspace_id = $1 and user_id = $2 and connector_type = $3`,
      [workspaceId, userId, connectorType],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  it('1. store() then retrieve() round-trips the exact credentials object', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('roundtrip');

    const stored = await service.store(workspaceId, userId, 'google-drive', {
      apiKey: 'secret-123',
    });

    expect(stored.connectorType).toBe('google-drive');
    expect(stored.id).toBeDefined();

    const retrieved = await service.retrieve(workspaceId, userId, 'google-drive');
    expect(retrieved).toEqual({ apiKey: 'secret-123' });
  });

  it('2. storing the SAME (workspaceId, userId, connectorType) triple TWICE with different credentials upserts -- retrieve reflects the SECOND value, and no duplicate row is created', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('upsert');

    await service.store(workspaceId, userId, 'slack', { token: 'first-token' });
    await service.store(workspaceId, userId, 'slack', { token: 'second-token' });

    const retrieved = await service.retrieve(workspaceId, userId, 'slack');
    expect(retrieved).toEqual({ token: 'second-token' });

    const count = await rowCount(workspaceId, userId, 'slack');
    expect(count).toBe(1);
  });

  it('3. retrieve() for a never-stored (workspaceId, userId, connectorType) triple returns undefined (does not throw)', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('never-stored');

    const retrieved = await service.retrieve(workspaceId, userId, 'github');
    expect(retrieved).toBeUndefined();
  });

  it('4. remove() then retrieve() returns undefined', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('remove');

    await service.store(workspaceId, userId, 'notion', { apiKey: 'to-be-removed' });
    await service.remove(workspaceId, userId, 'notion');

    const retrieved = await service.retrieve(workspaceId, userId, 'notion');
    expect(retrieved).toBeUndefined();

    const count = await rowCount(workspaceId, userId, 'notion');
    expect(count).toBe(0);
  });

  it('5. remove() for a never-stored triple does not throw (idempotent no-op)', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('remove-noop');

    await expect(service.remove(workspaceId, userId, 'gmail')).resolves.toBeUndefined();
  });

  it("6. cross-user isolation: user A's stored credentials are never retrievable by user B in the SAME workspace+connectorType", async () => {
    const unique = crypto.randomUUID();
    const workspaceId = await createWorkspace(`connector-credentials-cross-user-${unique}`);
    const userA = await createUser(`connector-credentials-cross-user-a-${unique}@example.com`);
    const userB = await createUser(`connector-credentials-cross-user-b-${unique}@example.com`);

    await service.store(workspaceId, userA, 'calendar', { apiKey: 'user-a-secret' });

    const retrievedByB = await service.retrieve(workspaceId, userB, 'calendar');
    expect(retrievedByB).toBeUndefined();

    const retrievedByA = await service.retrieve(workspaceId, userA, 'calendar');
    expect(retrievedByA).toEqual({ apiKey: 'user-a-secret' });
  });

  it("7. cross-workspace isolation: the SAME user's credentials in workspace A are never retrievable when queried under workspace B, same connectorType", async () => {
    const unique = crypto.randomUUID();
    const workspaceA = await createWorkspace(`connector-credentials-cross-ws-a-${unique}`);
    const workspaceB = await createWorkspace(`connector-credentials-cross-ws-b-${unique}`);
    const userId = await createUser(`connector-credentials-cross-ws-${unique}@example.com`);

    await service.store(workspaceA, userId, 'gmail', { apiKey: 'workspace-a-secret' });

    const retrievedInB = await service.retrieve(workspaceB, userId, 'gmail');
    expect(retrievedInB).toBeUndefined();

    const retrievedInA = await service.retrieve(workspaceA, userId, 'gmail');
    expect(retrievedInA).toEqual({ apiKey: 'workspace-a-secret' });
  });

  it('8. the raw DB row is genuinely encrypted -- encrypted_credentials never contains the plaintext secret substring, and is non-empty', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('encryption-proof');
    const plaintextSecret = 'super-secret-plaintext-marker-xyz';

    await service.store(workspaceId, userId, 'google-drive', { apiKey: plaintextSecret });

    const row = await rawRow(workspaceId, userId, 'google-drive');
    expect(row).toBeDefined();
    expect(row?.encrypted_credentials.length).toBeGreaterThan(0);
    expect(row?.encrypted_credentials).not.toContain(plaintextSecret);
    // Also never equal to the raw JSON-serialized plaintext blob (stronger
    // than the substring check alone, in case of accidental partial
    // encoding).
    expect(row?.encrypted_credentials).not.toBe(JSON.stringify({ apiKey: plaintextSecret }));
  });

  it('9. retrieve() never returns the encrypted/ciphertext form -- only the decrypted plain object', async () => {
    const { workspaceId, userId } = await freshWorkspaceAndUser('never-ciphertext');

    await service.store(workspaceId, userId, 'slack', { token: 'plain-token-value' });
    const retrieved = await service.retrieve(workspaceId, userId, 'slack');

    expect(retrieved).toEqual({ token: 'plain-token-value' });
    // packed ciphertext (`@luminaos/shared`'s `encryptSecret`) is exactly
    // three base64 segments joined by `:` (`iv:authTag:ciphertext`) -- assert
    // the retrieved value's serialized form doesn't match THAT specific
    // shape, rather than "no colon at all" (impossible for any JSON object,
    // since `{"key":"value"}` itself always contains a colon).
    expect(JSON.stringify(retrieved)).not.toMatch(
      /^"[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+"$/,
    );
  });
});
