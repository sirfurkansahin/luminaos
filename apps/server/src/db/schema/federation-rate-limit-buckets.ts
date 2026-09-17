import { bigint, doublePrecision, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

import { federationLinkCredentials } from './federation-link-credentials.js';
import { workspaces } from './workspaces.js';

/**
 * F3-T14 PR2 (ADR-0048 §g/RBAC özeti, ADR-0028 §h emsali): one row per
 * (hostWorkspaceId, federationLinkCredentialId) pair, carrying
 * `RateLimitBucketState`'s (`@luminaos/integrations`, ADR-0025 §h) four
 * fields verbatim -- the federation mirror of `mcp_rate_limit_buckets`
 * (ADR-0028 §h), keyed by the HOST side's workspace + the credential being
 * used (not the grantee's workspace) since it is the host's data being read.
 */
export const federationRateLimitBuckets = pgTable(
  'federation_rate_limit_buckets',
  {
    hostWorkspaceId: uuid('host_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    federationLinkCredentialId: uuid('federation_link_credential_id')
      .notNull()
      .references(() => federationLinkCredentials.id, { onDelete: 'cascade' }),
    capacity: integer('capacity').notNull(),
    tokensAvailable: doublePrecision('tokens_available').notNull(),
    refillPerMs: doublePrecision('refill_per_ms').notNull(),
    lastRefillAtMs: bigint('last_refill_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.hostWorkspaceId, table.federationLinkCredentialId] })],
);
