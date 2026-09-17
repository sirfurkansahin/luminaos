import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { federationLinks } from './federation-links.js';
import { users } from './users.js';
import { workspaces } from './workspaces.js';

/**
 * F3-T14 PR1 (ADR-0048 §e, İNSAN ONAYLI): tek-tek, kasıtlı opt-in allowlist
 * -- toplu "tüm workspace'i paylaş" YOK. `removedAt` is a tombstone
 * (`mcp_client_grants`/`MemoryAccessPolicy` emsali) -- hard-delete YOK, so a
 * removed-then-re-added `objectId` produces a NEW active row rather than
 * reviving the old one.
 *
 * DELIBERATE DEVIATION FROM ADR-0048 §e's OWN CODE DRAFT (flagged by
 * test-writer, confirmed here): the ADR draft types `objectId` as a Postgres
 * `uuid` column, but real Lumina Object ids (`@luminaos/core-objects`'s
 * `newObjectId()`) are 26-character Crockford-base32 ULIDs, NOT UUIDs --
 * identical to `objects_view.id`'s own `varchar(26)` column type (see
 * `./objects-view.ts`). A ULID string cannot be inserted into a `uuid`
 * column, so this column is `varchar(26)` here, matching the column it is
 * validated against (`assertObjectExists`-style existence checks, Bağlam
 * madde 4), not the ADR's literal draft.
 */
export const federationScopeObjects = pgTable(
  'federation_scope_objects',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    federationLinkId: uuid('federation_link_id')
      .notNull()
      .references(() => federationLinks.id, { onDelete: 'cascade' }),
    // `objects_view` is a plain Drizzle-mapped table (not a real Postgres
    // VIEW), but no FK is declared here regardless -- existence + workspace
    // scope is verified at write-time by the service layer
    // (`assertObjectExists`), mirroring `RelationsService`'s own precedent
    // for object-id references that aren't declared as DB-level FKs.
    objectId: varchar('object_id', { length: 26 }).notNull(),
    // Nesnenin GERÇEKTEN yaşadığı workspace -- linkin iki ucundan biri olmak
    // ZORUNDA, servis katmanında doğrulanır.
    ownerWorkspaceId: uuid('owner_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    addedByUserId: uuid('added_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('federation_scope_objects_active_key')
      .on(table.federationLinkId, table.objectId)
      .where(sql`${table.removedAt} IS NULL`),
  ],
);
