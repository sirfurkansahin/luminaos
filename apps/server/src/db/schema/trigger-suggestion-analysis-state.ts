import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * `trigger_suggestion_analysis_state` — a single row per workspace tracking
 * the last time `TriggerSuggestionsService.runAnalysis` ran for it, enforcing
 * ADR-0034 Karar (b)'s 15-minute cooldown (on-demand only, no scheduled
 * background poller).
 */
export const triggerSuggestionAnalysisState = pgTable('trigger_suggestion_analysis_state', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull(),
});
