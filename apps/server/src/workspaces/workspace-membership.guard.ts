import { Injectable } from '@nestjs/common';

import { WorkspaceMembershipService } from './workspace-membership.service.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Must run *after* `SessionAuthGuard` in a controller's `@UseGuards(...)`
 * array — it relies on `req.user` already being populated.
 *
 * Thin HTTP adapter over `WorkspaceMembershipService`: it pulls
 * `req.params.workspaceId` + `req.user.id` out of the Express request,
 * delegates the actual check to the service, and mirrors the result onto
 * `request.membership`. A missing `req.user` surfaces as an empty-string
 * `userId`, which the service maps to `UnauthorizedError` — preserving the
 * previous fail-closed behavior.
 */
@Injectable()
export class WorkspaceMembershipGuard implements CanActivate {
  constructor(private readonly membershipService: WorkspaceMembershipService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const workspaceIdParam = request.params['workspaceId'];
    const workspaceId = typeof workspaceIdParam === 'string' ? workspaceIdParam : '';
    const userId = request.user?.id ?? '';

    const { role } = await this.membershipService.assertMembership(userId, workspaceId);

    request.membership = { workspaceId, role };

    return true;
  }
}
