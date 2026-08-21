import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QuotaExceededError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F2-T12 PR1 (RED step), ADR-0028 §h/§m — the inbound MCP rate-limit
 * service, wrapping the pure `checkRateLimit` (`@luminaos/integrations`,
 * ADR-0025 §h) exactly like `ConnectorRateLimitService` does for the outbound
 * side, but keyed by `(workspaceId, mcpClientGrantId)` and writing to a NEW
 * `mcp_rate_limit_buckets` table.
 *
 * ============================================================================
 * NAMING RESOLUTION (test-writer's own judgment call, flagged explicitly):
 * this test file's own PATH (`mcp-inbound-rate-limit.service.test.ts`) matches
 * the task brief's file-naming instruction. However ADR-0028 §m's LITERAL,
 * human-approved `mcp.controller.ts` code imports this dependency as
 * `InboundMcpRateLimitService` from `./inbound-mcp-rate-limit.service.js` (a
 * DIFFERENT filename/class name than the task brief's own
 * "mcp-inbound-rate-limit.service.ts" naming). Per CLAUDE.md's instruction to
 * follow the ADR's pinned code shape "exactly, not paraphrased" for anything
 * §m covers, this file's dynamic import below targets
 * `./inbound-mcp-rate-limit.service.js` / `InboundMcpRateLimitService` (the
 * ADR-pinned names that `mcp.controller.ts` will actually wire up) rather
 * than a name matching this test file's own path -- `implementer` must create
 * the service at THAT path/name for both this file and the real controller
 * wiring to resolve. Flagged for human/implementer confirmation; if the
 * naming is meant to go the other way, only this one import line (and this
 * file's own filename) needs to change.
 *
 * ============================================================================
 * HARNESS CHOICE / SCHEMA DESIGN: same reasoning as
 * `../integrations/connector-rate-limit.integration.test.ts`'s header, with
 * ONE deliberate difference (ADR-0028 §h, explicitly contrasted with ADR-0025
 * §l's outbound asymmetry): `mcp_rate_limit_buckets` carries REAL foreign keys
 * on BOTH `workspace_id` (-> `workspaces.id`) and `mcp_client_grant_id` (->
 * `mcp_client_grants.id`) -- so unlike the outbound test's synthetic
 * `freshWorkspaceId()` (a bare random uuid, never a real row), every fixture
 * here inserts a REAL `workspaces` row and a REAL `mcp_client_grants` row
 * (via raw SQL, since `../db/schema/mcp-client-grants.ts` does not exist yet
 * either) before seeding a bucket against them. Composite PRIMARY KEY on
 * `(workspace_id, mcp_client_grant_id)` (ADR-0028 §h's pinned schema),
 * carrying `RateLimitBucketState`'s four fields verbatim, same column
 * names/types as `connector_rate_limit_buckets` (`capacity` integer,
 * `tokens_available`/`refill_per_ms` double precision, `last_refill_at_ms`
 * bigint).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither the inbound rate-limit service module
 * nor `../db/schema/mcp-rate-limit-buckets.ts` (nor `../db/schema/
 * mcp-client-grants.ts`, nor either migration) exist yet. `beforeAll`'s
 * dynamic import of the not-yet-existing service module rejects with a
 * "Cannot find module" resolution error, failing every test in this file at
 * setup -- this is the correct red, not a test-logic bug. (Once the service
 * module exists but the migrations don't, the red state shifts to each raw
 * SQL seed/query rejecting with `relation "..." does not exist`, equally a
 * legitimate "implementation incomplete" red.)
 * ============================================================================
 */

interface InboundMcpRateLimitServiceContract {
  assertNotRateLimited(workspaceId: string, mcpClientGrantId: string, cost: number): Promise<void>;
}

type InboundMcpRateLimitServiceConstructor = new (
  db: Database,
) => InboundMcpRateLimitServiceContract;

interface SeedBucketState {
  capacity: number;
  tokensAvailable: number;
  refillPerMs: number;
  lastRefillAtMs: number;
}

interface RawBucketRow {
  tokens_available: number;
  last_refill_at_ms: string;
}

describe('InboundMcpRateLimitService (real Postgres via Testcontainers, ADR-0028 §h)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let service: InboundMcpRateLimitServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://mcp-inbound-rate-limit-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates this module --
    // see this file's header (both the EXPECTED RED STATE section and the
    // NAMING RESOLUTION section) for why the resulting `import-x/no-unresolved`
    // finding is expected and contained to this one line.
    const importedModule: unknown = await import('./inbound-mcp-rate-limit.service.js');
    const InboundMcpRateLimitServiceCtor = (
      importedModule as { InboundMcpRateLimitService: InboundMcpRateLimitServiceConstructor }
    ).InboundMcpRateLimitService;
    service = new InboundMcpRateLimitServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `mcp-rate-limit-test-${label}-${unique}`, slug: unique })
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
        email: `mcp-rate-limit-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  /** Real `mcp_client_grants` row (raw SQL -- the schema doesn't exist yet as
   * a typed Drizzle object, see this file's header), so the REAL FK on
   * `mcp_rate_limit_buckets.mcp_client_grant_id` (ADR-0028 §h) is satisfiable. */
  async function createMcpClientGrant(workspaceId: string, userId: string): Promise<string> {
    const tokenHash = crypto.randomBytes(32).toString('hex');
    const result = await db.$client.query<{ id: string }>(
      `insert into mcp_client_grants (workspace_id, user_id, name, token_hash, token_prefix)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [workspaceId, userId, 'rate-limit fixture grant', tokenHash, tokenHash.slice(0, 12)],
    );

    const grantId = result.rows[0]?.id;
    if (!grantId) {
      throw new Error('Failed to seed fixture mcp_client_grants row');
    }

    return grantId;
  }

  async function freshWorkspaceAndGrant(label: string): Promise<{
    workspaceId: string;
    grantId: string;
  }> {
    const workspaceId = await createWorkspace(label);
    const userId = await createUser(label);
    const grantId = await createMcpClientGrant(workspaceId, userId);
    return { workspaceId, grantId };
  }

  async function seedBucket(
    workspaceId: string,
    mcpClientGrantId: string,
    state: SeedBucketState,
  ): Promise<void> {
    await db.$client.query(
      `insert into mcp_rate_limit_buckets
         (workspace_id, mcp_client_grant_id, capacity, tokens_available, refill_per_ms, last_refill_at_ms)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (workspace_id, mcp_client_grant_id) do update set
         capacity = excluded.capacity,
         tokens_available = excluded.tokens_available,
         refill_per_ms = excluded.refill_per_ms,
         last_refill_at_ms = excluded.last_refill_at_ms`,
      [
        workspaceId,
        mcpClientGrantId,
        state.capacity,
        state.tokensAvailable,
        state.refillPerMs,
        state.lastRefillAtMs,
      ],
    );
  }

  async function rawBucketRow(
    workspaceId: string,
    mcpClientGrantId: string,
  ): Promise<RawBucketRow | undefined> {
    const result = await db.$client.query<RawBucketRow>(
      `select tokens_available, last_refill_at_ms::text as last_refill_at_ms
         from mcp_rate_limit_buckets
        where workspace_id = $1 and mcp_client_grant_id = $2`,
      [workspaceId, mcpClientGrantId],
    );
    return result.rows[0];
  }

  it('1. a never-seen (workspaceId, mcpClientGrantId) pair: the first call auto-creates a bucket and does not throw for a small cost', async () => {
    const { workspaceId, grantId } = await freshWorkspaceAndGrant('never-seen');

    await expect(service.assertNotRateLimited(workspaceId, grantId, 1)).resolves.toBeUndefined();
  });

  it('2. a call within capacity succeeds (no throw)', async () => {
    const { workspaceId, grantId } = await freshWorkspaceAndGrant('within-capacity');
    await seedBucket(workspaceId, grantId, {
      capacity: 10,
      tokensAvailable: 10,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });

    await expect(service.assertNotRateLimited(workspaceId, grantId, 5)).resolves.toBeUndefined();
  });

  it('3. repeated calls that exhaust the bucket eventually throw QuotaExceededError', async () => {
    const { workspaceId, grantId } = await freshWorkspaceAndGrant('exhaustion');
    await seedBucket(workspaceId, grantId, {
      capacity: 5,
      tokensAvailable: 5,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });

    // First call of cost 3 fits (5 available) and leaves 2.
    await expect(service.assertNotRateLimited(workspaceId, grantId, 3)).resolves.toBeUndefined();

    // Second call of cost 3 does NOT fit (only 2 left, refillPerMs=0 means no
    // catch-up) -- must be denied.
    await expect(service.assertNotRateLimited(workspaceId, grantId, 3)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it('4. the bucket key is per (workspaceId, mcpClientGrantId): a DIFFERENT grant in the SAME workspace has a fully independent limit', async () => {
    const workspaceId = await createWorkspace('independent-grants-ws');
    const userId = await createUser('independent-grants-user');
    const grantOne = await createMcpClientGrant(workspaceId, userId);
    const grantTwo = await createMcpClientGrant(workspaceId, userId);

    await seedBucket(workspaceId, grantOne, {
      capacity: 1,
      tokensAvailable: 1,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });
    await seedBucket(workspaceId, grantTwo, {
      capacity: 1,
      tokensAvailable: 1,
      refillPerMs: 0,
      lastRefillAtMs: Date.now(),
    });

    // Exhaust grantOne entirely.
    await expect(service.assertNotRateLimited(workspaceId, grantOne, 1)).resolves.toBeUndefined();
    await expect(service.assertNotRateLimited(workspaceId, grantOne, 1)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );

    // grantTwo, a DIFFERENT mcpClientGrantId in the SAME workspace, must be
    // completely unaffected -- if the two shared a single bucket/lock key,
    // this call would incorrectly also be denied.
    await expect(service.assertNotRateLimited(workspaceId, grantTwo, 1)).resolves.toBeUndefined();
  });

  it('5. refill-over-time: a DENIED call still persists the refill catch-up (nextState is persisted unconditionally, per ADR-0025 §h, reused here per ADR-0028 §h)', async () => {
    const { workspaceId, grantId } = await freshWorkspaceAndGrant('refill-over-time');
    const fiveSecondsAgo = Date.now() - 5_000;

    // capacity 10, starts at 0, refills 0.001 tokens/ms (1 token/sec) -- by
    // "now" (~5s later), refilledAmount should be ~5, still short of the
    // cost of 8 requested below, so the call must be DENIED, but the refill
    // catch-up to ~5 (and the advanced lastRefillAtMs) must still be saved.
    await seedBucket(workspaceId, grantId, {
      capacity: 10,
      tokensAvailable: 0,
      refillPerMs: 0.001,
      lastRefillAtMs: fiveSecondsAgo,
    });

    await expect(service.assertNotRateLimited(workspaceId, grantId, 8)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );

    const row = await rawBucketRow(workspaceId, grantId);
    expect(row).toBeDefined();
    // Refilled to roughly 5 tokens (generous tolerance for real wall-clock
    // time elapsed during the test itself).
    expect(row?.tokens_available ?? 0).toBeGreaterThan(4);
    expect(row?.tokens_available ?? 0).toBeLessThan(6);
    // lastRefillAtMs must have been advanced to "now" (well after the
    // originally-seeded value from 5 seconds ago), proving persistence
    // happened even though the call was denied.
    expect(Number(row?.last_refill_at_ms ?? '0')).toBeGreaterThan(fiveSecondsAgo + 4_000);
  });
});
