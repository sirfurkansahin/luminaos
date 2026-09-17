import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';

import { addFederationScopeObjectSchema } from './dto/add-federation-scope-object.schema.js';
import { createFederationCredentialSchema } from './dto/create-federation-credential.schema.js';
import { FederationLinkCredentialsService } from './federation-link-credentials.service.js';
import { FederationLinksService } from './federation-links.service.js';
import { FederationScopeService } from './federation-scope.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { AddFederationScopeObjectInput } from './dto/add-federation-scope-object.schema.js';
import type { CreateFederationCredentialInput } from './dto/create-federation-credential.schema.js';
import type { FederationLinkCredential } from './federation-link-credentials.service.js';
import type { FederationLink } from './federation-links.service.js';
import type { FederationScopeObject } from './federation-scope.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * F3-T14 PR2 (ADR-0048 §e/§d, RBAC özeti): human-facing REST surface for a
 * `FederationLink`'s shared object scope and its credentials. `:workspaceId`
 * is always the HOST side making the call (the side whose own object/data is
 * being scoped or shared) -- `grantee`/`ownerWorkspaceId` are always derived
 * as "the OTHER side of this link", never accepted as raw client input.
 */
@Controller('workspaces/:workspaceId/federation-links/:linkId')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class FederationScopeController {
  constructor(
    private readonly linksService: FederationLinksService,
    private readonly scopeService: FederationScopeService,
    private readonly credentialsService: FederationLinkCredentialsService,
  ) {}

  @Post('scope')
  async addScopeObject(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body(new ZodValidationPipe(addFederationScopeObjectSchema))
    body: AddFederationScopeObjectInput,
    @Req() req: Request,
  ): Promise<{ scopeObject: FederationScopeObject }> {
    const { userId, role } = this.requireActor(req);

    const scopeObject = await this.scopeService.addObject(
      linkId,
      body.objectId,
      workspaceId,
      userId,
      role,
    );

    return { scopeObject };
  }

  @Delete('scope/:objectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeScopeObject(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Param('objectId') objectId: string,
    @Req() req: Request,
  ): Promise<void> {
    const { role } = this.requireActor(req);
    // `workspaceId` doubles as the required `ownerWorkspaceId` here --
    // ADR-0048 §e: removal needs the SAME authority as addition, the
    // object's OWNING side, not merely any admin party to the link.
    await this.scopeService.removeObject(linkId, objectId, workspaceId, role);
  }

  @Get('scope')
  async listScopeObjects(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<{ scopeObjects: FederationScopeObject[] }> {
    const scopeObjects = await this.scopeService.listActive(linkId, workspaceId);

    return { scopeObjects };
  }

  @Post('credentials')
  async createCredential(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body(new ZodValidationPipe(createFederationCredentialSchema))
    body: CreateFederationCredentialInput,
    @Req() req: Request,
  ): Promise<{ credential: FederationLinkCredential; rawToken: string }> {
    const { userId, role } = this.requireActor(req);
    const granteeWorkspaceId = await this.resolveOtherSide(linkId, workspaceId);

    const { credential, rawToken } = await this.credentialsService.grant(
      linkId,
      granteeWorkspaceId,
      body.name,
      body.expiresAtDays,
      userId,
      role,
    );

    return { credential, rawToken };
  }

  @Post('credentials/:credentialId/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeCredential(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
    @Req() req: Request,
  ): Promise<void> {
    const { role } = this.requireActor(req);

    // `FederationLinkCredentialsService.revoke` takes no role parameter --
    // unlike `grant`, RBAC for this action is enforced here, at the REST
    // boundary (ADR-0048 §d/RBAC özeti: admin+ at the host side).
    if (!hasAtLeastRole(role, 'admin')) {
      throw new ForbiddenError();
    }

    const granteeWorkspaceId = await this.resolveOtherSide(linkId, workspaceId);
    await this.credentialsService.revoke(linkId, granteeWorkspaceId, credentialId);
  }

  /** Resolves "the other side" of `linkId` relative to the caller's own
   * `:workspaceId` -- throws `ForbiddenError` if `workspaceId` isn't
   * actually one of this link's two ends at all. */
  private async resolveOtherSide(linkId: string, workspaceId: string): Promise<string> {
    const link: FederationLink = await this.linksService.get(linkId);

    if (link.initiatorWorkspaceId === workspaceId) {
      return link.counterpartWorkspaceId;
    }
    if (link.counterpartWorkspaceId === workspaceId) {
      return link.initiatorWorkspaceId;
    }

    throw new ForbiddenError();
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
