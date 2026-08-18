import {
  bigint,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * F2-T9 PR2 (ADR-0025 §l): one row per (workspaceId, connectorType) pair,
 * carrying `RateLimitBucketState`'s (`@luminaos/integrations`, ADR-0025 §h)
 * four fields verbatim. Composite PRIMARY KEY on the pair itself (no
 * separate `id`, unlike `connector_credentials` — a rate-limit bucket is
 * scoped to a connector-in-a-workspace, not per-user, so the natural key IS
 * the full identity of the row) -- this also gives the
 * `on conflict (workspace_id, connector_type)` upsert target
 * `connector-rate-limit.integration.test.ts`'s raw-SQL seeding relies on.
 * Exact column names/types match that test file's raw-SQL seeding/assertion
 * queries byte-exact (test-writer's own documented judgment call, ADR-0025
 * §l's delegation).
 *
 * DELIBERATELY NO foreign-key reference on `workspaceId` to `workspaces`
 * (unlike `connector_credentials`) -- `connector-rate-limit.integration.test.ts`'s
 * `freshWorkspaceId()` helper only ever generates a syntactically-valid
 * random uuid, never inserts a real `workspaces` row, so a strict FK here
 * would make every seeded-bucket test fail with a foreign-key violation
 * regardless of service-layer correctness. Matching the pinned test file
 * exactly (this codebase's own "TEST FILES are the authoritative spec"
 * instruction for this table's schema details) takes precedence here over
 * this codebase's usual FK-everywhere convention.
 */
export const connectorRateLimitBuckets = pgTable(
  'connector_rate_limit_buckets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    connectorType: varchar('connector_type', { length: 50 }).notNull(),
    capacity: integer('capacity').notNull(),
    tokensAvailable: doublePrecision('tokens_available').notNull(),
    refillPerMs: doublePrecision('refill_per_ms').notNull(),
    lastRefillAtMs: bigint('last_refill_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.connectorType] })],
);
