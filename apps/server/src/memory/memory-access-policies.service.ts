import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { MemoryAccessPolicy } from '@luminaos/memory';
import { AppError, deriveDeterministicUuid } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { MemoryAccessPolicyProjection } from './memory-access-policy.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { memoryAccessPolicies } from '../db/schema/memory-access-policies.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const MEMORY_ACCESS_POLICY_STREAM_TYPE = 'memory-access-policy';

/**
 * Fixed, arbitrary namespace UUID for deriving per-(workspace, user,
 * agentIdentifier) memory-access-policy streamIds. MUST NEVER CHANGE once
 * real data exists -- changing it silently opens a new stream per triple,
 * losing continuity with any prior grant/revoke history (F2-T8, ADR-0024
 * Karar j). MUST match the literal pinned in
 * `memory-access-policies.integration.test.ts`.
 */
export const MEMORY_ACCESS_POLICY_UUID_NAMESPACE = 'c3a9e412-6c8b-4b91-9dfa-91a2b3c4d5e7';

type MemoryAccessPolicyRow = typeof memoryAccessPolicies.$inferSelect;

function toMemoryAccessPolicy(row: MemoryAccessPolicyRow): MemoryAccessPolicy {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    agentIdentifier: row.agentIdentifier,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Signals a database invariant violation (an insert/upsert that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors `DesktopSignalConsentsService`'s
 * `UnexpectedQueryResultError` pattern for "should never happen" cases.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

/**
 * F2-T8 (ADR-0024 Karar f/j): `MemoryAccessPolicyService`, an event-sourced,
 * self-service, per-(workspace, user, agentIdentifier) grant/revoke
 * aggregate. Its `streamId` is a DETERMINISTIC function of `(workspaceId,
 * userId, agentIdentifier)` (RFC 4122 UUIDv5, via `deriveDeterministicUuid`)
 * — a SEPARATE stream per triple, mirroring
 * `DesktopSignalConsentsService.streamIdFor`'s read-prior-stream / append /
 * synchronous catchUp / read-back shape.
 */
@Injectable()
export class MemoryAccessPolicyService {
  private readonly projection = new MemoryAccessPolicyProjection();

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  async grant(
    workspaceId: string,
    userId: string,
    agentIdentifier: string,
  ): Promise<MemoryAccessPolicy> {
    return this.record(workspaceId, userId, agentIdentifier, 'MemoryAccessGranted');
  }

  async revoke(
    workspaceId: string,
    userId: string,
    agentIdentifier: string,
  ): Promise<MemoryAccessPolicy> {
    return this.record(workspaceId, userId, agentIdentifier, 'MemoryAccessRevoked');
  }

  /**
   * ALL rows for (workspaceId, userId), UNFILTERED by `revokedAt` (ADR-0024
   * §k — deliberately different from `MemoryRecordsService.list`'s
   * `deletedAt IS NULL` filter): a user's own grant/revoke history is
   * audit-valuable information, not something to hide.
   */
  async list(workspaceId: string, userId: string): Promise<MemoryAccessPolicy[]> {
    const rows = await this.db
      .select()
      .from(memoryAccessPolicies)
      .where(
        and(
          eq(memoryAccessPolicies.workspaceId, workspaceId),
          eq(memoryAccessPolicies.userId, userId),
        ),
      );

    return rows.map(toMemoryAccessPolicy);
  }

  private async record(
    workspaceId: string,
    userId: string,
    agentIdentifier: string,
    type: 'MemoryAccessGranted' | 'MemoryAccessRevoked',
  ): Promise<MemoryAccessPolicy> {
    const streamId = this.streamIdFor(workspaceId, userId, agentIdentifier);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: MEMORY_ACCESS_POLICY_STREAM_TYPE,
      workspaceId,
      type,
      payload: { agentIdentifier },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const current = await this.get(workspaceId, userId, agentIdentifier);

    if (!current) {
      throw new UnexpectedQueryResultError(
        'Failed to read back memory access policy immediately after writing it.',
      );
    }

    return current;
  }

  private async get(
    workspaceId: string,
    userId: string,
    agentIdentifier: string,
  ): Promise<MemoryAccessPolicy | null> {
    const [row] = await this.db
      .select()
      .from(memoryAccessPolicies)
      .where(
        and(
          eq(memoryAccessPolicies.workspaceId, workspaceId),
          eq(memoryAccessPolicies.userId, userId),
          eq(memoryAccessPolicies.agentIdentifier, agentIdentifier),
        ),
      )
      .limit(1);

    return row ? toMemoryAccessPolicy(row) : null;
  }

  private streamIdFor(workspaceId: string, userId: string, agentIdentifier: string): string {
    return deriveDeterministicUuid(
      MEMORY_ACCESS_POLICY_UUID_NAMESPACE,
      `${workspaceId}:${userId}:${agentIdentifier}`,
    );
  }
}
