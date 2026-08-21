import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { checkRateLimit } from '@luminaos/integrations';
import type { RateLimitBucketState } from '@luminaos/integrations';
import { QuotaExceededError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { mcpRateLimitBuckets } from '../db/schema/mcp-rate-limit-buckets.js';

import type { Database } from '../db/client.js';

/** Same defaults as `ConnectorRateLimitService` (ADR-0028 §h): no new
 * constant is invented -- 60 calls of burst capacity, refilling at 1/sec
 * (60 per minute). */
const DEFAULT_BUCKET_CAPACITY = 60;
const DEFAULT_REFILL_PER_MS = 60 / 60_000;

/**
 * F2-T12 PR1 (ADR-0028 §h/§m): the INBOUND mirror of
 * `ConnectorRateLimitService` -- same `pg_advisory_lock`-protected
 * check-then-persist skeleton around the pure `checkRateLimit`
 * (`@luminaos/integrations`, ADR-0025 §h), keyed by `(workspaceId,
 * mcpClientGrantId)` instead of `(workspaceId, connectorType)`, writing to
 * `mcp_rate_limit_buckets` instead of `connector_rate_limit_buckets`.
 */
@Injectable()
export class InboundMcpRateLimitService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Throws `QuotaExceededError` if the (workspaceId, mcpClientGrantId)
   * bucket denies this call. The `nextState` `checkRateLimit` computes is
   * persisted UNCONDITIONALLY -- even when denied, the refill catch-up must
   * still be saved (ADR-0025 §h, reused here per ADR-0028 §h).
   */
  async assertNotRateLimited(
    workspaceId: string,
    mcpClientGrantId: string,
    cost: number,
  ): Promise<void> {
    const lockKey = `${workspaceId}:${mcpClientGrantId}`;
    const client = await this.db.$client.connect();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockKey]);

      try {
        const [existing] = await this.db
          .select({
            capacity: mcpRateLimitBuckets.capacity,
            tokensAvailable: mcpRateLimitBuckets.tokensAvailable,
            refillPerMs: mcpRateLimitBuckets.refillPerMs,
            lastRefillAtMs: mcpRateLimitBuckets.lastRefillAtMs,
          })
          .from(mcpRateLimitBuckets)
          .where(
            and(
              eq(mcpRateLimitBuckets.workspaceId, workspaceId),
              eq(mcpRateLimitBuckets.mcpClientGrantId, mcpClientGrantId),
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
          .insert(mcpRateLimitBuckets)
          .values({
            workspaceId,
            mcpClientGrantId,
            capacity: result.nextState.capacity,
            tokensAvailable: result.nextState.tokensAvailable,
            refillPerMs: result.nextState.refillPerMs,
            lastRefillAtMs: result.nextState.lastRefillAtMs,
          })
          .onConflictDoUpdate({
            target: [mcpRateLimitBuckets.workspaceId, mcpRateLimitBuckets.mcpClientGrantId],
            set: {
              capacity: result.nextState.capacity,
              tokensAvailable: result.nextState.tokensAvailable,
              refillPerMs: result.nextState.refillPerMs,
              lastRefillAtMs: result.nextState.lastRefillAtMs,
            },
          });

        if (!result.allowed) {
          throw new QuotaExceededError(
            `Rate limit exceeded for MCP client grant "${mcpClientGrantId}" in this workspace.`,
            { workspaceId, mcpClientGrantId, retryAfterMs: result.retryAfterMs },
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
