import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuotaExceededError } from '@luminaos/shared';

import { AuthLoginRateLimitService } from './auth-login-rate-limit.service.js';

import type { Redis } from 'ioredis';

describe('AuthLoginRateLimitService', () => {
  const evalMock = vi.fn();
  const delMock = vi.fn();
  const redis = { eval: evalMock, del: delMock } as unknown as Redis;
  let service: AuthLoginRateLimitService;

  beforeEach(() => {
    vi.clearAllMocks();
    evalMock.mockResolvedValue(1);
    delMock.mockResolvedValue(1);
    service = new AuthLoginRateLimitService(redis);
  });

  it('increments hashed email and IP buckets through the atomic Redis script', async () => {
    await service.assertLoginAllowed('203.0.113.9', 'Beta@Example.com');

    expect(evalMock).toHaveBeenCalledTimes(2);
    const calls = evalMock.mock.calls as unknown[][];
    const emailKey = calls[0]?.[2];
    const ipKey = calls[1]?.[2];
    expect(emailKey).toMatch(/^auth:login:email:[a-f0-9]{64}$/);
    expect(ipKey).toMatch(/^auth:login:ip:[a-f0-9]{64}$/);
    expect(String(emailKey)).not.toContain('beta@example.com');
    expect(String(ipKey)).not.toContain('203.0.113.9');
    expect(String(calls[0]?.[0])).toContain("redis.call('INCR', KEYS[1])");
    expect(String(calls[0]?.[0])).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
  });

  it('rejects before checking the IP bucket when the email limit is exceeded', async () => {
    evalMock.mockResolvedValueOnce(11);

    await expect(service.assertLoginAllowed('203.0.113.9', 'beta@example.com')).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(evalMock).toHaveBeenCalledOnce();
  });

  it('rejects when the IP-wide limit is exceeded even with an allowed email bucket', async () => {
    evalMock.mockResolvedValueOnce(1).mockResolvedValueOnce(101);

    await expect(service.assertLoginAllowed('203.0.113.9', 'other@example.com')).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it('clears only the normalized email bucket after a successful login', async () => {
    await service.clearSuccessfulEmail(' Beta@Example.com ');

    expect(delMock).toHaveBeenCalledOnce();
    const key = String(delMock.mock.calls[0]?.[0]);
    expect(key).toMatch(/^auth:login:email:[a-f0-9]{64}$/);
    expect(key).not.toContain('beta@example.com');
  });
});
