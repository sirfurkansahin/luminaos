import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F3-T14 PR1 (ADR-0048 §a/§b): a bilateral eşleşme between two `workspace`
 * rows -- NOT a new `Organization` entity (İnsan kararı 1). State machine
 * (`pending -> active -> revoked`, terminal) is enforced in the pure,
 * DB-less `federation-link-state.ts` module, never here.
 */
export const federationLinkStatusEnum = pgEnum('federation_link_status', [
  'pending',
  'active',
  'revoked',
]);

export const federationLinks = pgTable(
  'federation_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    initiatorWorkspaceId: uuid('initiator_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    counterpartWorkspaceId: uuid('counterpart_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Direction-independent uniqueness: `[min(a,b), max(a,b)].join(':')`,
    // computed at the service layer (application-level, NOT a DB generated
    // column -- this Drizzle version has no stored-generated-column
    // support), see `computePairKey` in `federation-link-state.ts`.
    pairKey: varchar('pair_key', { length: 73 }).notNull(),
    status: federationLinkStatusEnum('status').notNull().default('pending'),
    initiatedByUserId: uuid('initiated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Karar (h)'nin çift-taraflı denetimi -- HER TARAFIN KENDİ stream'i;
    // `linkId`'yi iki tarafta `streamId` olarak paylaşmak `events` tablosunun
    // `events_stream_id_version_key`'inin (workspace-kör UNIQUE) çakışmasını
    // tetikleyebilirdi -- bkz. ADR-0048 Bağlam madde 5.
    initiatorAuditStreamId: uuid('initiator_audit_stream_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    counterpartAuditStreamId: uuid('counterpart_audit_stream_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // Aynı iki workspace arasında AYNI ANDA birden fazla pending/active link
    // olamaz -- revoked linkler bu kısıttan MUAF (yeniden link kurulabilir).
    uniqueIndex('federation_links_pair_key_active_key')
      .on(table.pairKey)
      .where(sql`${table.status} <> 'revoked'`),
  ],
);
