import { integer, pgTable, uuid } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * State for the example `workspace-event-counter` projection (F0-T6 PR-B):
 * a per-workspace running count of every event ever recorded. This is
 * derived/rebuildable state, not the immutable log itself — unlike
 * `events`'s deliberate `ON DELETE NO ACTION` deviation, this FK cascades
 * like the rest of the schema's default convention, since losing a
 * workspace's projection row when the workspace itself is deleted is
 * harmless (it can always be rebuilt from the log for any workspace that
 * still exists).
 */
export const projectionWorkspaceEventCounts = pgTable('projection_workspace_event_counts', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  eventCount: integer('event_count').notNull().default(0),
});
