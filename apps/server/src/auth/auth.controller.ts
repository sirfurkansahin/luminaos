import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UsePipes } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { AuthService } from './auth.service.js';
import { loginSchema } from './dto/login.schema.js';
import { registerSchema } from './dto/register.schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import type { AuthResultUser } from './auth.service.js';
import type { LoginInput } from './dto/login.schema.js';
import type { RegisterInput } from './dto/register.schema.js';
import type { Request, Response } from 'express';

const SESSION_COOKIE_NAME = 'sid';
const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    secure: process.env['NODE_ENV'] === 'production',
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(registerSchema))
  async register(
    @Body() body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResultUser }> {
    const { user, sessionId } = await this.authService.register(body.email, body.password);
    setSessionCookie(res, sessionId);
    return { user };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(
    @Body() body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResultUser }> {
    const { user, sessionId } = await this.authService.login(body.email, body.password);
    setSessionCookie(res, sessionId);
    return { user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const sessionId = req.cookies as Record<string, unknown> | undefined;
    const sid = sessionId?.[SESSION_COOKIE_NAME];

    if (typeof sid === 'string' && sid.length > 0) {
      await this.authService.logout(sid);
    }

    res.clearCookie(SESSION_COOKIE_NAME);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResultUser }> {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const sid = cookies?.[SESSION_COOKIE_NAME];

    if (typeof sid !== 'string' || sid.length === 0) {
      throw new UnauthorizedError();
    }

    const { user, sessionId } = await this.authService.refresh(sid);
    setSessionCookie(res, sessionId);
    return { user };
  }
}
