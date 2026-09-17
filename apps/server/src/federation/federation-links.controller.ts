import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';

import { initiateFederationLinkSchema } from './dto/initiate-federation-link.schema.js';
import { FederationAuditService } from './federation-audit.service.js';
import { FederationLinksService } from './federation-links.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { InitiateFederationLinkInput } from './dto/initiate-federation-link.schema.js';
import type { FederationLink } from './federation-links.service.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * F3-T14 PR2 (ADR-0048 §c, RBAC özeti): human-facing REST surface for
 * `FederationLink` lifecycle management -- initiate/accept/revoke are
 * `admin+` (enforced by `FederationLinksService` itself); list/audit-log are
 * `member+` (ADR-0016 §a: read paths are never role-gated beyond plain
 * membership), mirroring `NotificationPreferencesController`'s exact
 * guard-stack/RBAC-delegation-to-service shape.
 */
@Controller('workspaces/:workspaceId/federation-links')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class FederationLinksController {
  constructor(
    private readonly linksService: FederationLinksService,
    private readonly auditService: FederationAuditService,
  ) {}

  @Post()
  async initiate(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(initiateFederationLinkSchema)) body: InitiateFederationLinkInput,
    @Req() req: Request,
  ): Promise<{ link: FederationLink }> {
    const { userId, role } = this.requireActor(req);

    const link = await this.linksService.initiate(
      workspaceId,
      body.counterpartWorkspaceId,
      userId,
      role,
    );

    return { link };
  }

  @Post(':linkId/accept')
  async accept(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Req() req: Request,
  ): Promise<{ link: FederationLink }> {
    const { userId, role } = this.requireActor(req);

    // ADR-0048 §c: only the COUNTERPART side's admin+ may accept -- the
    // service's own check only excludes the exact initiating user, not an
    // unrelated admin acting from the wrong workspace's URL.
    const existing = await this.linksService.get(linkId);
    if (existing.counterpartWorkspaceId !== workspaceId) {
      throw new ForbiddenError();
    }

    const link = await this.linksService.accept(linkId, userId, role);

    return { link };
  }

  @Post(':linkId/revoke')
  async revoke(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Req() req: Request,
  ): Promise<{ link: FederationLink }> {
    const { userId, role } = this.requireActor(req);

    // ADR-0048 §c: either side's admin+ may revoke, but the caller's own
    // workspace must genuinely be one of this link's two ends.
    const existing = await this.linksService.get(linkId);
    if (
      existing.initiatorWorkspaceId !== workspaceId &&
      existing.counterpartWorkspaceId !== workspaceId
    ) {
      throw new ForbiddenError();
    }

    const link = await this.linksService.revoke(linkId, userId, role);

    return { link };
  }

  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<{ links: FederationLink[] }> {
    const links = await this.linksService.listForWorkspace(workspaceId);

    return { links };
  }

  @Get(':linkId/audit-log')
  async auditLog(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<{ events: StoredEvent[] }> {
    const events = await this.auditService.readOwnAuditLog(linkId, workspaceId);

    return { events };
  }

  /**
   * `SessionAuthGuard`/`WorkspaceMembershipGuard` always populate
   * `req.user`/`req.membership` before any handler here runs -- fail closed
   * rather than assert them away, mirroring
   * `NotificationPreferencesController`'s identical guarantee-check pattern.
   */
  private requireActor(req: Request): { userId: string; role: MembershipRole } {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const role = req.membership?.role as MembershipRole | undefined;
    if (!role) {
      throw new ForbiddenError();
    }

    return { userId: req.user.id, role };
  }
}
