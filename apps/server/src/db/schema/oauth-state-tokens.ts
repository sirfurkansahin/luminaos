import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F2-T10 PR1 (ADR-0026 §i): DB-backed, single-use OAuth `state`/CSRF tokens
 * for the MCP connector authorize->callback flow. `state` itself is the
 * primary key -- an opaque `base64url(randomBytes(32))` value, never a
 * signed carrier (no workspaceId/userId/connectorType encoded into it);
 * correlation happens ONLY via this row. TTL (10 minutes) is enforced by
 * `OAuthStateService.consume`'s `expiresAt` check, not by any DB constraint
 * -- no proactive cleanup of expired rows (accepted operational debt, ADR-0026
 * §i).
 */
export const oauthStateTokens = pgTable('oauth_state_tokens', {
  state: varchar('state', { length: 64 }).primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  connectorType: varchar('connector_type', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
