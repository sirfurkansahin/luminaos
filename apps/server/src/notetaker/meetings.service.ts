import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { Role } from '@luminaos/core-objects';
import type { MeetingBotClient } from '@luminaos/integrations';
import { NotFoundError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { detectMeetingProvider } from './detect-meeting-provider.js';
import { MEETING_BOT_CLIENT } from './meeting-bot-client.token.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { meetingDetails } from '../db/schema/meeting-details.js';
import { ObjectsService } from '../objects/objects.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { ObjectWithFieldValues } from '../objects/objects.service.js';

export type MeetingDetailsRow = typeof meetingDetails.$inferSelect;

export interface MeetingMetadata {
  id: string;
  title: string;
  meetingUrl: string;
  provider: MeetingDetailsRow['provider'];
  status: MeetingDetailsRow['status'];
  createdAt: string;
  transcriptText?: string | null;
}

/**
 * ADR-0030's orchestration layer: detects the provider from the URL (§i),
 * creates the `meeting` LuminaObject via the EXISTING `ObjectsService.create`
 * (no new object-CRUD path, §b), invites the bot via the injected
 * `MeetingBotClient` (§e), and inserts exactly one `meeting_details` row
 * (§c/§d). `getMeetingDetails` applies the role-based `transcriptText`
 * visibility rule (§h).
 */
@Injectable()
export class MeetingsService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly objectsService: ObjectsService,
    @Inject(MEETING_BOT_CLIENT) private readonly meetingBotClient: MeetingBotClient,
  ) {}

  /**
   * Ordering is load-bearing (ADR-0030 §i pinned by the integration test's
   * 4a/4b/4c cases): `detectMeetingProvider` runs FIRST — its
   * `ValidationError` must propagate before `ObjectsService.create`,
   * `MeetingBotClient.inviteBot`, or the `meeting_details` insert ever run,
   * so an unrecognized URL leaves behind no `meeting` object and no
   * `meeting_details` row.
   */
  async inviteBot(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    input: { meetingUrl: string },
  ): Promise<{ object: ObjectWithFieldValues; meetingDetails: MeetingDetailsRow }> {
    const provider = detectMeetingProvider(input.meetingUrl);

    // Judgment call (not pinned by the ADR/tests): the `meeting` object's
    // title is the raw `meetingUrl` itself -- `meeting`'s registry entry
    // requires a non-empty title (ADR-0030 §b) and no richer title source
    // (e.g. a calendar event's own title) is available on this ad hoc,
    // URL-only invite path.
    const object = await this.objectsService.create(
      workspaceId,
      actor,
      { objectType: 'meeting', title: input.meetingUrl },
      callerRole,
    );

    const { providerMeetingRef } = await this.meetingBotClient.inviteBot({
      meetingUrl: input.meetingUrl,
      meetingObjectId: object.id,
    });

    const [row] = await this.db
      .insert(meetingDetails)
      .values({
        objectId: object.id,
        workspaceId,
        meetingUrl: input.meetingUrl,
        provider,
        providerMeetingRef,
      })
      .returning();

    if (!row) {
      // Unreachable: `.returning()` on a successful single-row insert always
      // yields exactly one row. Defensive only.
      throw new NotFoundError('Failed to persist meeting details');
    }

    return { object, meetingDetails: row };
  }

  /**
   * `NotFoundError` (404) both for a nonexistent `meetingId` AND one
   * belonging to a different workspace than `workspaceId` -- delegated
   * entirely to `ObjectsService.get`'s OWN, already-established
   * "doesn't exist in this scope" convention (same lookup shape as
   * `objects.integration.test.ts`'s cross-workspace GET precedent), rather
   * than inventing a second, parallel existence check here.
   */
  async getMeetingDetails(
    workspaceId: string,
    meetingId: string,
    callerRole: Role,
  ): Promise<{ meeting: MeetingMetadata }> {
    const object = await this.objectsService.get(workspaceId, meetingId, callerRole);

    const [row] = await this.db
      .select()
      .from(meetingDetails)
      .where(eq(meetingDetails.objectId, meetingId))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Meeting not found');
    }

    const canViewTranscript = hasAtLeastRole(callerRole, 'member');

    return {
      meeting: {
        id: object.id,
        title: object.title,
        meetingUrl: row.meetingUrl,
        provider: row.provider,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        ...(canViewTranscript ? { transcriptText: row.transcriptText } : {}),
      },
    };
  }

  /**
   * `POST /webhooks/notetaker`'s own persistence step (ADR-0030 §f/§g),
   * invoked ONLY after `NotetakerWebhookAuthGuard` has already verified the
   * HMAC signature. Looks up the `meeting_details` row by `providerMeetingRef`
   * (the unique index, §d) -- a nonexistent ref throws a GENERIC `NotFoundError`
   * that does NOT echo `providerMeetingRef` back in its message (§g: whether a
   * given ref exists/doesn't must never be leaked to whoever is calling this
   * unauthenticated-by-identity endpoint).
   *
   * `status` is always updated; `transcriptText`/`providerRecordingUrl` are
   * updated ONLY when the corresponding key is PRESENT as an own property on
   * `update` (`in`, not `!== undefined` -- a webhook payload that omits a key
   * entirely must leave the existing DB value untouched, distinct from a
   * payload that explicitly sends `null` for it).
   */
  async applyWebhookUpdate(
    providerMeetingRef: string,
    update: {
      status: MeetingDetailsRow['status'];
      transcriptText?: string | null;
      providerRecordingUrl?: string | null;
    },
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(meetingDetails)
      .where(eq(meetingDetails.providerMeetingRef, providerMeetingRef))
      .limit(1);

    if (!row) {
      // Kasıtlı olarak jenerik -- providerMeetingRef'in var/yok olduğu
      // saldırgana sızdırılmaz (ADR-0030 §g).
      throw new NotFoundError('Meeting not found for the given webhook reference');
    }

    const values: {
      status: MeetingDetailsRow['status'];
      transcriptText?: string | null;
      providerRecordingUrl?: string | null;
    } = { status: update.status };

    if ('transcriptText' in update) {
      values.transcriptText = update.transcriptText;
    }

    if ('providerRecordingUrl' in update) {
      values.providerRecordingUrl = update.providerRecordingUrl;
    }

    await this.db.update(meetingDetails).set(values).where(eq(meetingDetails.id, row.id));
  }
}
