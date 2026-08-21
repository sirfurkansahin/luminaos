import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F2-T12 PR1 (ADR-0028 §a/§b): a Personal Access Token grant a user issues to
 * an external MCP client (e.g. Claude Desktop). Only `tokenHash` (`sha256`
 * hex digest of the raw token, ADR-0028 §a) is ever persisted -- the raw
 * token itself is returned exactly once, at `grant()` time, and never stored
 * anywhere. `tokenPrefix` (first 12 chars of the raw token, plaintext) exists
 * purely for the management panel's "which token is this" display, never for
 * lookup/auth (ADR-0028 §a). Revoke follows the `MemoryAccessPolicy` pattern
 * (ADR-0024): the row is never deleted, `revokedAt` is set instead, for audit
 * visibility (ADR-0028 §b).
 */
export const mcpClientGrants = pgTable(
  'mcp_client_grants',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenPrefix: varchar('token_prefix', { length: 12 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('mcp_client_grants_token_hash_key').on(table.tokenHash)],
);
