import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { checkRateLimit } from '@luminaos/integrations';
import type { RateLimitBucketState } from '@luminaos/integrations';
import { QuotaExceededError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { federationRateLimitBuckets } from '../db/schema/federation-rate-limit-buckets.js';

import type { Database } from '../db/client.js';

/** Same defaults as `InboundMcpRateLimitService`/`ConnectorRateLimitService`
 * (ADR-0028 §h): no new constant is invented -- 60 calls of burst capacity,
 * refilling at 1/sec (60 per minute). */
const DEFAULT_BUCKET_CAPACITY = 60;
const DEFAULT_REFILL_PER_MS = 60 / 60_000;

/**
 * F3-T14 PR2 (ADR-0048 §g, ADR-0028 §h emsali): the federation mirror of
 * `InboundMcpRateLimitService` -- same `pg_advisory_lock`-protected
 * check-then-persist skeleton around the pure `checkRateLimit`
 * (`@luminaos/integrations`, ADR-0025 §h), keyed by `(hostWorkspaceId,
 * federationLinkCredentialId)` instead of `(workspaceId, mcpClientGrantId)`,
 * writing to `federation_rate_limit_buckets` instead of
 * `mcp_rate_limit_buckets`.
 */
@Injectable()
export class FederationRateLimitService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Throws `QuotaExceededError` if the (hostWorkspaceId, credentialId)
   * bucket denies this call. The `nextState` `checkRateLimit` computes is
   * persisted UNCONDITIONALLY -- even when denied, the refill catch-up must
   * still be saved (ADR-0025 §h, reused here per ADR-0028 §h).
   */
  async assertNotRateLimited(
    hostWorkspaceId: string,
    federationLinkCredentialId: string,
    cost: number,
  ): Promise<void> {
    const lockKey = `${hostWorkspaceId}:${federationLinkCredentialId}`;
    const client = await this.db.$client.connect();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockKey]);

      try {
        const [existing] = await this.db
          .select({
            capacity: federationRateLimitBuckets.capacity,
            tokensAvailable: federationRateLimitBuckets.tokensAvailable,
            refillPerMs: federationRateLimitBuckets.refillPerMs,
            lastRefillAtMs: federationRateLimitBuckets.lastRefillAtMs,
          })
          .from(federationRateLimitBuckets)
          .where(
            and(
              eq(federationRateLimitBuckets.hostWorkspaceId, hostWorkspaceId),
              eq(federationRateLimitBuckets.federationLinkCredentialId, federationLinkCredentialId),
            ),
          );

        const now = Date.now();
        const bucket: RateLimitBucketState = existing ?? {
          capacity: DEFAULT_BUCKET_CAPACITY,
          tokensAvailable: DEFAULT_BUCKET_CAPACITY,
          refillPerMs: DEFAULT_REFILL_PER_MS,
          lastRefillAtMs: now,
        };

        const result = checkRateLimit(bucket, cost, now);

        await this.db
          .insert(federationRateLimitBuckets)
          .values({
            hostWorkspaceId,
            federationLinkCredentialId,
            capacity: result.nextState.capacity,
            tokensAvailable: result.nextState.tokensAvailable,
            refillPerMs: result.nextState.refillPerMs,
            lastRefillAtMs: result.nextState.lastRefillAtMs,
          })
          .onConflictDoUpdate({
            target: [
              federationRateLimitBuckets.hostWorkspaceId,
              federationRateLimitBuckets.federationLinkCredentialId,
            ],
            set: {
              capacity: result.nextState.capacity,
              tokensAvailable: result.nextState.tokensAvailable,
              refillPerMs: result.nextState.refillPerMs,
              lastRefillAtMs: result.nextState.lastRefillAtMs,
            },
          });

        if (!result.allowed) {
          throw new QuotaExceededError(
            `Rate limit exceeded for federation credential "${federationLinkCredentialId}" against host workspace "${hostWorkspaceId}".`,
            { hostWorkspaceId, federationLinkCredentialId, retryAfterMs: result.retryAfterMs },
          );
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockKey]);
      }
    } finally {
      client.release();
    }
  }
}
