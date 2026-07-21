import { createParamDecorator } from '@nestjs/common';

import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Convenience param decorator for controllers protected by
 * `SessionAuthGuard`: `@CurrentUser() user: { id: string; email: string }`
 * instead of reaching into `@Req()` manually.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): { id: string; email: string } | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    return request.user;
  },
);
