import { bigint, doublePrecision, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

import { mcpClientGrants } from './mcp-client-grants.js';
import { workspaces } from './workspaces.js';

/**
 * F2-T12 PR1 (ADR-0028 §h): one row per (workspaceId, mcpClientGrantId) pair,
 * carrying `RateLimitBucketState`'s (`@luminaos/integrations`, ADR-0025 §h)
 * four fields verbatim -- the INBOUND mirror of `connector_rate_limit_buckets`
 * (outbound, ADR-0025 §l), keyed differently. Unlike the outbound table, this
 * one carries REAL foreign keys on both columns (ADR-0028 §h) -- no test
 * fixture here relies on a synthetic, never-inserted workspaceId/grantId, so
 * the FK is free data-integrity, not a risk.
 */
export const mcpRateLimitBuckets = pgTable(
  'mcp_rate_limit_buckets',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mcpClientGrantId: uuid('mcp_client_grant_id')
      .notNull()
      .references(() => mcpClientGrants.id, { onDelete: 'cascade' }),
    capacity: integer('capacity').notNull(),
    tokensAvailable: doublePrecision('tokens_available').notNull(),
    refillPerMs: doublePrecision('refill_per_ms').notNull(),
    lastRefillAtMs: bigint('last_refill_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.mcpClientGrantId] })],
);
