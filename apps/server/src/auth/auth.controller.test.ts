import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@luminaos/shared';

import { AuthController } from './auth.controller.js';

import type { AuthLoginRateLimitService } from './auth-login-rate-limit.service.js';
import type { AuthService } from './auth.service.js';
import type { Request, Response } from 'express';

describe('AuthController beta hardening', () => {
  const loginMock = vi.fn();
  const registerMock = vi.fn();
  const changePasswordMock = vi.fn();
  const assertLoginAllowedMock = vi.fn();
  const clearSuccessfulEmailMock = vi.fn();
  const authService = {
    changePassword: changePasswordMock,
    login: loginMock,
    register: registerMock,
    logout: vi.fn(),
    refresh: vi.fn(),
  } as unknown as AuthService;
  const rateLimitService = {
    assertLoginAllowed: assertLoginAllowedMock,
    clearSuccessfulEmail: clearSuccessfulEmailMock,
  } as unknown as AuthLoginRateLimitService;
  const responseCookieMock = vi.fn();
  const response = { cookie: responseCookieMock, clearCookie: vi.fn() } as unknown as Response;
  const request = {
    ip: '203.0.113.9',
    socket: { remoteAddress: '127.0.0.1' },
    cookies: {},
  } as unknown as Request;
  let controller: AuthController;
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'test';
    controller = new AuthController(authService, rateLimitService);
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = previousNodeEnv;
    }
  });

  it('checks the IP/email buckets before password verification and clears email on success', async () => {
    loginMock.mockResolvedValue({
      user: { id: 'user-1', email: 'beta@example.com' },
      sessionId: 'session-1',
    });

    await controller.login(
      { email: 'beta@example.com', password: 'secret-password' },
      request,
      response,
    );

    expect(assertLoginAllowedMock).toHaveBeenCalledWith('203.0.113.9', 'beta@example.com');
    expect(loginMock).toHaveBeenCalledAfter(assertLoginAllowedMock);
    expect(clearSuccessfulEmailMock).toHaveBeenCalledWith('beta@example.com');
  });

  it('does not clear the failed-attempt bucket when credentials are rejected', async () => {
    loginMock.mockRejectedValue(new ForbiddenError());

    await expect(
      controller.login(
        { email: 'beta@example.com', password: 'wrong-password' },
        request,
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(clearSuccessfulEmailMock).not.toHaveBeenCalled();
  });

  it('rejects public registration in production before touching the database', async () => {
    process.env['NODE_ENV'] = 'production';

    await expect(
      controller.register(
        { email: 'new@example.com', password: 'secret-password' },
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('rate-limits password changes and rotates the session cookie on success', async () => {
    changePasswordMock.mockResolvedValue({
      user: { id: 'user-1', email: 'beta@example.com' },
      sessionId: 'session-2',
    });

    await controller.changePassword(
      { currentPassword: 'current-password', newPassword: 'new-secure-password' },
      { id: 'user-1', email: 'beta@example.com' },
      request,
      response,
    );

    expect(assertLoginAllowedMock).toHaveBeenCalledWith('203.0.113.9', 'beta@example.com');
    expect(changePasswordMock).toHaveBeenCalledWith(
      'user-1',
      'current-password',
      'new-secure-password',
    );
    expect(clearSuccessfulEmailMock).toHaveBeenCalledWith('beta@example.com');
    expect(responseCookieMock).toHaveBeenCalledWith(
      'sid',
      'session-2',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
  });
});
