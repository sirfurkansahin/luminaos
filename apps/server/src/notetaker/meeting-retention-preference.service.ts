import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { meetingRetentionPreferences } from '../db/schema/meeting-retention-preferences.js';

import type { Database } from '../db/client.js';

/**
 * The 3-value retention mode union (mirrors the `meeting_retention_mode`
 * pg enum, ADR-0031 §a) -- kept here as the single source of truth so both
 * the controller's zod schema and the sweeper's `resolvePreference` share
 * the exact same literal type.
 */
export type MeetingRetentionMode = 'recording-reference' | 'transcript-only' | 'summary-only';

/**
 * Code-level default when no `meeting_retention_preferences` row exists for
 * a workspace (ADR-0031 §b, human-approved): `transcript-only`, not
 * `summary-only` -- this codebase has no summarization capability today, so
 * defaulting to a mode whose semantics depend on a summary that is never
 * produced would in practice never retain anything.
 */
export const DEFAULT_MEETING_RETENTION_MODE: MeetingRetentionMode = 'transcript-only';

/**
 * Reads/writes the workspace-scoped meeting retention preference
 * (ADR-0031 §a/§b). Shared by both the HTTP controller (read/write API) and
 * `MeetingRetentionSweeperService` (read-only, via `resolveMode`) so the
 * "no row -> code-level default" fallback logic lives in exactly one place.
 */
@Injectable()
export class MeetingRetentionPreferenceService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Returns the workspace's stored preference, or the code-level default if
   * no row exists yet -- "unset" is never surfaced as an error/404, since it
   * has a well-defined default (ADR-0031 §b).
   */
  async resolveMode(workspaceId: string): Promise<MeetingRetentionMode> {
    const [row] = await this.db
      .select({ mode: meetingRetentionPreferences.mode })
      .from(meetingRetentionPreferences)
      .where(eq(meetingRetentionPreferences.workspaceId, workspaceId));

    return row?.mode ?? DEFAULT_MEETING_RETENTION_MODE;
  }

  /**
   * Upserts the workspace's preference: creates the row if absent, updates
   * `mode`+`updatedAt` if present. Uses the unique `workspaceId` index
   * (ADR-0031 §a) via `.onConflictDoUpdate()`, mirroring
   * `CalendarSyncPollerService.pollOnce()`'s own upsert pattern.
   */
  async setMode(workspaceId: string, mode: MeetingRetentionMode): Promise<MeetingRetentionMode> {
    const now = new Date();
    const [row] = await this.db
      .insert(meetingRetentionPreferences)
      .values({ workspaceId, mode, updatedAt: now })
      .onConflictDoUpdate({
        target: meetingRetentionPreferences.workspaceId,
        set: { mode, updatedAt: now },
      })
      .returning({ mode: meetingRetentionPreferences.mode });

    if (!row) {
      // Unreachable: `.onConflictDoUpdate().returning()` on a successful
      // insert-or-update always yields exactly one row. Defensive only.
      throw new InvalidObjectStateError(
        `Failed to upsert meeting retention preference for workspace "${workspaceId}": upsert returned no row.`,
      );
    }

    return row.mode;
  }
}
