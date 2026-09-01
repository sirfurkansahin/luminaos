import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';

import { ForbiddenError } from '@luminaos/shared';

import { meetingRetentionPreferenceSchema } from './dto/meeting-retention-preference.schema.js';
import { MeetingRetentionPreferenceService } from './meeting-retention-preference.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { MeetingRetentionPreferenceInput } from './dto/meeting-retention-preference.schema.js';
import type { MeetingRetentionMode } from './meeting-retention-preference.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

interface MeetingRetentionPreferenceBody {
  mode: MeetingRetentionMode;
}

/**
 * `GET`/`PUT /workspaces/:workspaceId/meeting-retention-preference`
 * (ADR-0031 §a/§b): ANY workspace member (including `guest`) may read -- the
 * retention MODE itself is a workspace-governance setting, not sensitive
 * content (unlike `transcriptText`, which stays gated at `member`+ in
 * `MeetingsService.getMeetingDetails`), and a well-defined default is always
 * returned, never a 404 for "unset". Only `admin`+ may WRITE -- deciding the
 * policy is the governance action, not observing it. Mirrors
 * `MeetingInviteController`'s exact guard-stack/`requireRole` pattern
 * (`SessionAuthGuard` first so `req.user` is populated before
 * `WorkspaceMembershipGuard` resolves `req.membership`).
 */
@Controller('workspaces/:workspaceId/meeting-retention-preference')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class MeetingRetentionPreferenceController {
  constructor(private readonly preferenceService: MeetingRetentionPreferenceService) {}

  @Get()
  async get(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<MeetingRetentionPreferenceBody> {
    this.requireRole(req);

    const mode = await this.preferenceService.resolveMode(workspaceId);
    return { mode };
  }

  @Put()
  async put(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(meetingRetentionPreferenceSchema))
    body: MeetingRetentionPreferenceInput,
    @Req() req: Request,
  ): Promise<MeetingRetentionPreferenceBody> {
    const callerRole = this.requireRole(req);

    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const mode = await this.preferenceService.setMode(workspaceId, body.mode);
    return { mode };
  }

  /**
   * `WorkspaceMembershipGuard` always sets `req.membership` before any
   * handler here runs -- fail closed (403) rather than assert it away,
   * mirroring `MeetingInviteController.requireRole`'s exact reasoning.
   */
  private requireRole(req: Request): MembershipRole {
    const role = req.membership?.role as MembershipRole | undefined;

    if (!role) {
      throw new ForbiddenError();
    }

    return role;
  }
}
