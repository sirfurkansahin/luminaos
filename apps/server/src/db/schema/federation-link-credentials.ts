import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { federationLinks } from './federation-links.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F3-T14 PR1 (ADR-0048 §d, İNSAN ONAYLI): a federation-scoped PAT, minted
 * for the GRANTEE workspace of a `FederationLink` -- mirrors
 * `mcp_client_grants`'s (ADR-0028 §a/§b) tokenHash/tokenPrefix/revokedAt
 * shape exactly, keyed by `federationLinkId`+`granteeWorkspaceId` instead of
 * `workspaceId`+`userId`. The HOST side (the data owner) is deliberately NOT
 * a separate column -- it is always derivable from the link
 * (`initiatorWorkspaceId`/`counterpartWorkspaceId`, whichever one is NOT
 * `granteeWorkspaceId`).
 *
 * `expiresAt` stays nullable at the SCHEMA level (ADR-0028 §l's deliberately
 * unused future-extension point), but NO v0 code path ever writes `NULL` --
 * `grant()` always computes a concrete date from the closed 30/90/365-day
 * union, default 90 (İnsan kararı 4). A "süresiz federasyon" option would
 * require a SEPARATE, future human decision + ADR.
 */
export const federationLinkCredentials = pgTable(
  'federation_link_credentials',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    federationLinkId: uuid('federation_link_id')
      .notNull()
      .references(() => federationLinks.id, { onDelete: 'cascade' }),
    granteeWorkspaceId: uuid('grantee_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenPrefix: varchar('token_prefix', { length: 12 }).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('federation_link_credentials_token_hash_key').on(table.tokenHash)],
);
