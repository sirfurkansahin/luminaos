import { Injectable } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { SessionService } from './session.service.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

const SESSION_COOKIE_NAME = 'sid';

/**
 * Resolves the `sid` httpOnly cookie into `req.user`/`req.sessionId`.
 *
 * No cookie, an unknown session id, or an expired/revoked session are all
 * treated identically — `UnauthorizedError` (401) — so a caller can never
 * distinguish "no session" from "invalid session" via the response, which
 * would otherwise leak information about session id validity.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessionService: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const sessionId: unknown = cookies?.[SESSION_COOKIE_NAME];

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new UnauthorizedError();
    }

    const activeSession = await this.sessionService.getActiveSession(sessionId);

    if (!activeSession) {
      throw new UnauthorizedError();
    }

    const user = await this.sessionService.findUserById(activeSession.userId);

    if (!user) {
      throw new UnauthorizedError();
    }

    request.user = { id: user.id, email: user.email };
    request.sessionId = sessionId;

    return true;
  }
}
