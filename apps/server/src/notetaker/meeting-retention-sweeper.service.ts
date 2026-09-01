import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { MeetingRetentionPreferenceService } from './meeting-retention-preference.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { meetingDetails } from '../db/schema/meeting-details.js';

import type { MeetingRetentionMode } from './meeting-retention-preference.service.js';
import type { Database } from '../db/client.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** How often `sweepOnce()` is invoked via the background interval. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** TTL for `transcript-only`'s (and the code-level default's) `transcriptText`. */
const TRANSCRIPT_ONLY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface MeetingDetailsRow {
  id: string;
  workspaceId: string;
  createdAt: Date;
  transcriptText: string | null;
  providerRecordingUrl: string | null;
}

interface SweepPatch {
  transcriptText?: null;
  providerRecordingUrl?: null;
}

/**
 * Periodically clears `meeting_details.transcriptText`/`providerRecordingUrl`
 * per the workspace's retention preference (ADR-0031 §d), mirroring
 * `CalendarSyncPollerService`'s exact shape (`OnModuleInit`/`OnModuleDestroy`
 * with `setInterval`/`clearInterval`, a public `sweepOnce()` directly
 * callable by tests, per-row `try/catch` so one row's failure never aborts
 * the sweep).
 */
@Injectable()
export class MeetingRetentionSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeetingRetentionSweeperService.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private readonly preferenceService: MeetingRetentionPreferenceService;

  /**
   * `preferenceService` is optional so this class stays directly
   * constructible with just a `Database` (mirrors
   * `meeting-retention-sweeper.integration.test.ts`'s
   * `new MeetingRetentionSweeperService(db)`, no Nest DI involved) while
   * still resolving via ordinary Nest DI in production (where
   * `MeetingRetentionPreferenceService` is a registered provider).
   */
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    preferenceService?: MeetingRetentionPreferenceService,
  ) {
    this.preferenceService = preferenceService ?? new MeetingRetentionPreferenceService(db);
  }

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.sweepOnce();
    }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
    }
  }

  async sweepOnce(): Promise<void> {
    const rows: MeetingDetailsRow[] = await this.db
      .select({
        id: meetingDetails.id,
        workspaceId: meetingDetails.workspaceId,
        createdAt: meetingDetails.createdAt,
        transcriptText: meetingDetails.transcriptText,
        providerRecordingUrl: meetingDetails.providerRecordingUrl,
      })
      .from(meetingDetails);

    for (const row of rows) {
      try {
        const mode = await this.preferenceService.resolveMode(row.workspaceId);
        const ageMs = Date.now() - row.createdAt.getTime();
        const patch = this.computePatch(mode, ageMs, row);

        if (patch) {
          await this.db.update(meetingDetails).set(patch).where(eq(meetingDetails.id, row.id));
        }
      } catch (error) {
        // One row's failure (e.g. a preference-lookup error, transient DB
        // issue) must never abort the rest of the sweep -- mirrors
        // `CalendarSyncPollerService.pollOnce()`'s per-account try/catch
        // discipline. Unlike calendar-sync staleness, a swallowed failure
        // here leaves sensitive transcript/recording data un-swept
        // indefinitely with no other signal -- logged (opaque row id only,
        // never transcript/recording content, CLAUDE.md's "kullanıcı verisini
        // ... log'a yazma" rule) so this doesn't silently persist forever
        // (security-reviewer finding, PR2).
        this.logger.error(
          `Retention sweep failed for meeting_details row ${row.id}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * Mode-by-mode field-clearing semantics (ADR-0031 §d, human-approved):
   *
   *   transcript-only     | transcriptText kept until createdAt+30d, then null | providerRecordingUrl null every sweep
   *   recording-reference | transcriptText null every sweep                   | providerRecordingUrl kept indefinitely (no TTL)
   *   summary-only        | transcriptText null every sweep                   | providerRecordingUrl null every sweep
   *
   * Already-null fields are left alone (no-op) -- `patch` only ever includes
   * a key when the corresponding field is both non-null and due for
   * clearing under the resolved mode.
   */
  private computePatch(
    mode: MeetingRetentionMode,
    ageMs: number,
    row: MeetingDetailsRow,
  ): SweepPatch | undefined {
    const patch: SweepPatch = {};

    const clearTranscript =
      mode === 'recording-reference' || mode === 'summary-only' || ageMs >= TRANSCRIPT_ONLY_TTL_MS;
    if (clearTranscript && row.transcriptText !== null) {
      patch.transcriptText = null;
    }

    const clearRecordingUrl = mode === 'transcript-only' || mode === 'summary-only';
    if (clearRecordingUrl && row.providerRecordingUrl !== null) {
      patch.providerRecordingUrl = null;
    }

    return Object.keys(patch).length > 0 ? patch : undefined;
  }
}
