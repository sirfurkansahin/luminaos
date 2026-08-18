import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { checkRateLimit } from '@luminaos/integrations';
import type { RateLimitBucketState } from '@luminaos/integrations';
import { QuotaExceededError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { connectorRateLimitBuckets } from '../db/schema/connector-rate-limit-buckets.js';

import type { Database } from '../db/client.js';

/** Sane, generous defaults for a never-before-seen (workspaceId,
 * connectorType) pair's auto-created bucket -- 60 calls of burst capacity,
 * refilling at 1/sec (60 per minute). Exact values are this service's own
 * judgment call (ADR-0025 §l delegates this; the integration test only pins
 * that the first call on a never-seen pair does not throw for a small
 * cost). */
const DEFAULT_BUCKET_CAPACITY = 60;
const DEFAULT_REFILL_PER_MS = 60 / 60_000;

/**
 * F2-T9 PR2 (ADR-0025 §l): the same lock-protected check-then-record
 * skeleton as `AIUsageService.withWorkspaceAILock`, generalized to a
 * per-(workspaceId, connectorType) `pg_advisory_lock`, wrapping the pure
 * `checkRateLimit` token-bucket transition (`@luminaos/integrations`,
 * ADR-0025 §h).
 */
@Injectable()
export class ConnectorRateLimitService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Throws `QuotaExceededError` if the (workspaceId, connectorType) bucket
   * denies this call. The `nextState` `checkRateLimit` computes is persisted
   * UNCONDITIONALLY -- even when denied, the refill catch-up must still be
   * saved (ADR-0025 §h).
   */
  async assertNotRateLimited(
    workspaceId: string,
    connectorType: string,
    cost: number,
  ): Promise<void> {
    const lockKey = `${workspaceId}:${connectorType}`;
    const client = await this.db.$client.connect();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockKey]);

      try {
        const [existing] = await this.db
          .select({
            capacity: connectorRateLimitBuckets.capacity,
            tokensAvailable: connectorRateLimitBuckets.tokensAvailable,
            refillPerMs: connectorRateLimitBuckets.refillPerMs,
            lastRefillAtMs: connectorRateLimitBuckets.lastRefillAtMs,
          })
          .from(connectorRateLimitBuckets)
          .where(
            and(
              eq(connectorRateLimitBuckets.workspaceId, workspaceId),
              eq(connectorRateLimitBuckets.connectorType, connectorType),
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
          .insert(connectorRateLimitBuckets)
          .values({
            workspaceId,
            connectorType,
            capacity: result.nextState.capacity,
            tokensAvailable: result.nextState.tokensAvailable,
            refillPerMs: result.nextState.refillPerMs,
            lastRefillAtMs: result.nextState.lastRefillAtMs,
          })
          .onConflictDoUpdate({
            target: [
              connectorRateLimitBuckets.workspaceId,
              connectorRateLimitBuckets.connectorType,
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
            `Rate limit exceeded for connector "${connectorType}" in this workspace.`,
            { workspaceId, connectorType, retryAfterMs: result.retryAfterMs },
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
