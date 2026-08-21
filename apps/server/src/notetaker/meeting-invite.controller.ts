import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Role } from '@luminaos/core-objects';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { inviteMeetingSchema } from './dto/invite-meeting.schema.js';
import { MeetingsService } from './meetings.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { InviteMeetingInput } from './dto/invite-meeting.schema.js';
import type { MeetingMetadata, MeetingDetailsRow } from './meetings.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

interface InviteMeetingObject {
  id: string;
  objectType: string;
  title: string;
}

interface InviteMeetingDetailsBody {
  id: string;
  objectId: string;
  meetingUrl: string;
  provider: MeetingDetailsRow['provider'];
  status: MeetingDetailsRow['status'];
  providerMeetingRef: string;
  providerRecordingUrl: string | null;
  // Optional, not `string | null` — mirrors `MeetingMetadata`'s GET-path
  // shape (ADR-0030 §h): gated by `hasAtLeastRole(callerRole, 'member')`,
  // omitted entirely for `guest`, never sent as a visible `null` key. Kept
  // structural (not "always null at insert time so it doesn't matter") per
  // security-reviewer's PR3 finding, so a future idempotent-reinvite path
  // that returns an EXISTING (possibly transcript-bearing) row can't
  // silently bypass the gate by reusing this response shape.
  transcriptText?: string | null;
  createdAt: Date;
}

/**
 * `POST /workspaces/:workspaceId/meetings` (ad hoc bot invite) + `GET
 * /workspaces/:workspaceId/meetings/:meetingId` (ADR-0030 §e/§h/§i). Same
 * guard stack + `requireActor`/`requireRole` pattern as `ObjectsController`/
 * `FieldsController`.
 */
@Controller('workspaces/:workspaceId/meetings')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class MeetingInviteController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async invite(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(inviteMeetingSchema)) body: InviteMeetingInput,
    @Req() req: Request,
  ): Promise<{ object: InviteMeetingObject; meetingDetails: InviteMeetingDetailsBody }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const { object, meetingDetails } = await this.meetingsService.inviteBot(
      workspaceId,
      actor,
      callerRole,
      { meetingUrl: body.meetingUrl },
    );

    // Mirrors `getMeetingDetails`'s ADR-0030 §h gate exactly (security-reviewer
    // finding, PR3): `transcriptText` is only ever included when the caller is
    // at least `member`, and only via key-presence (never a visible `null`),
    // even though at insert time this row's transcript is always null today —
    // kept structural so a future idempotent-reinvite path returning an
    // EXISTING (possibly transcript-bearing) row can't bypass the gate.
    const canViewTranscript = hasAtLeastRole(callerRole, 'member');

    return {
      object: { id: object.id, objectType: object.type, title: object.title },
      meetingDetails: {
        id: meetingDetails.id,
        objectId: meetingDetails.objectId,
        meetingUrl: meetingDetails.meetingUrl,
        provider: meetingDetails.provider,
        status: meetingDetails.status,
        providerMeetingRef: meetingDetails.providerMeetingRef,
        providerRecordingUrl: meetingDetails.providerRecordingUrl,
        ...(canViewTranscript ? { transcriptText: meetingDetails.transcriptText } : {}),
        createdAt: meetingDetails.createdAt,
      },
    };
  }

  @Get(':meetingId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('meetingId') meetingId: string,
    @Req() req: Request,
  ): Promise<{ meeting: MeetingMetadata }> {
    const callerRole = this.requireRole(req);

    return this.meetingsService.getMeetingDetails(workspaceId, meetingId, callerRole);
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `ObjectsController`'s handling of the same guarantee.
   */
  private requireActor(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    return { type: 'user', id: req.user.id };
  }

  /**
   * `MembershipRole` (server) and `Role` (`@luminaos/core-objects`) are
   * structurally identical 4-value string unions — mirrors
   * `ObjectsController.requireRole`'s exact reasoning. Fails closed (403) if
   * `WorkspaceMembershipGuard` somehow didn't run.
   */
  private requireRole(req: Request): Role {
    const role = req.membership?.role as MembershipRole | undefined;

    if (!role) {
      throw new ForbiddenError();
    }

    return role;
  }
}
