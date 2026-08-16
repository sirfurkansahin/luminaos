import { Controller, Get, UseGuards } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { CurrentUser } from './current-user.decorator.js';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionService } from './session.service.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * Deliberately its own controller (not part of `AuthController`, which is
 * mounted under `/auth`) so the route is exactly `GET /me`.
 */
@Controller('me')
@UseGuards(SessionAuthGuard)
export class MeController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly workspaceMembershipService: WorkspaceMembershipService,
  ) {}

  @Get()
  async getMe(@CurrentUser() currentUser: { id: string; email: string } | undefined): Promise<{
    user: { id: string; email: string; createdAt: Date };
    workspaces: { id: string; name: string }[];
  }> {
    // `SessionAuthGuard` always sets `req.user` before this handler runs, so
    // `currentUser` is only `undefined` in the type system, never at
    // runtime — but we still fail closed (401) rather than assert it away.
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    const user = await this.sessionService.findUserById(currentUser.id);

    if (!user) {
      throw new UnauthorizedError();
    }

    // F2-T3b (docs/specs/F2-E1/F2-T3b-desktop-login-session.md, Open
    // Question 1 Option B): `apps/desktop` needs every workspace the caller
    // is a member of to auto-select a single membership or show a picker
    // for multiple, without a separate `GET /workspaces` endpoint.
    const workspaces = await this.workspaceMembershipService.listWorkspacesForUser(user.id);

    return {
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
      workspaces,
    };
  }
}
