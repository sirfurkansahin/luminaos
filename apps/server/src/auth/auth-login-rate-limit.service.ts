import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { QuotaExceededError } from '@luminaos/shared';

import { REDIS_CONNECTION } from '../redis/redis-connection.token.js';

import type { Redis } from 'ioredis';

const WINDOW_MS = 15 * 60 * 1000;
const EMAIL_ATTEMPT_LIMIT = 10;
const IP_ATTEMPT_LIMIT = 100;

// Increment + first-expiry assignment must be one Redis operation. Otherwise
// concurrent first attempts can leave a key without a TTL and permanently
// lock a user out.
const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function emailKey(email: string): string {
  return `auth:login:email:${digest(email.trim().toLowerCase())}`;
}

function ipKey(ip: string): string {
  return `auth:login:ip:${digest(ip)}`;
}

function parseCount(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  // An unexpected Redis response must fail closed rather than silently remove
  // brute-force protection.
  throw new QuotaExceededError('Too many login attempts. Please try again later.');
}

@Injectable()
export class AuthLoginRateLimitService {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async assertLoginAllowed(ip: string, email: string): Promise<void> {
    await this.incrementAndAssert(emailKey(email), EMAIL_ATTEMPT_LIMIT);
    await this.incrementAndAssert(ipKey(ip), IP_ATTEMPT_LIMIT);
  }

  async clearSuccessfulEmail(email: string): Promise<void> {
    await this.redis.del(emailKey(email));
  }

  private async incrementAndAssert(key: string, limit: number): Promise<void> {
    const result = await this.redis.eval(
      INCREMENT_WITH_EXPIRY_SCRIPT,
      1,
      key,
      String(WINDOW_MS),
    );

    if (parseCount(result) > limit) {
      throw new QuotaExceededError('Too many login attempts. Please try again later.');
    }
  }
}
