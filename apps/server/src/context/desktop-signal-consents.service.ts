import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AppError, deriveDeterministicUuid } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { DesktopSignalConsentProjection } from './desktop-signal-consent.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { desktopSignalConsents } from '../db/schema/desktop-signal-consents.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const DESKTOP_SIGNAL_CONSENT_STREAM_TYPE = 'desktop-signal-consent';

/**
 * Fixed, arbitrary namespace UUID for deriving per-(workspace, user,
 * signalType) desktop-signal-consent streamIds. MUST NEVER CHANGE once real
 * data exists -- changing it silently opens a new stream per triple, losing
 * continuity with any prior consent history (F2-T3 PR1, ADR-0020 Karar a).
 */
export const DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE = 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f601';

export type DesktopSignalType = 'calendar-status' | 'active-window';

export interface DesktopSignalConsentSnapshot {
  signalType: string;
  grantedAt: string;
  revokedAt: string | null;
}

/**
 * Signals a database invariant violation (an insert/upsert that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors `UserAvailabilityService`'s
 * `UnexpectedQueryResultError` pattern for "should never happen" cases.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

/**
 * F2-T3 PR1 (ADR-0020 Karar a): `DesktopSignalConsents`, an event-sourced,
 * self-service, per-(workspace, user, signalType) consent aggregate. Its
 * `streamId` is a DETERMINISTIC function of `(workspaceId, userId,
 * signalType)` (RFC 4122 UUIDv5, via `deriveDeterministicUuid`) — a SEPARATE
 * stream per triple (granular per signal type), mirroring
 * `UserAvailabilityService.streamIdFor`'s read-prior-stream / append /
 * synchronous catchUp / read-back shape.
 */
@Injectable()
export class DesktopSignalConsentsService {
  private readonly projection = new DesktopSignalConsentProjection();

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  async grant(
    workspaceId: string,
    userId: string,
    signalType: DesktopSignalType,
  ): Promise<DesktopSignalConsentSnapshot> {
    return this.record(workspaceId, userId, signalType, 'DesktopSignalConsentGranted');
  }

  async revoke(
    workspaceId: string,
    userId: string,
    signalType: string,
  ): Promise<DesktopSignalConsentSnapshot> {
    return this.record(workspaceId, userId, signalType, 'DesktopSignalConsentRevoked');
  }

  async get(
    workspaceId: string,
    userId: string,
    signalType: string,
  ): Promise<DesktopSignalConsentSnapshot | null> {
    const [row] = await this.db
      .select({
        signalType: desktopSignalConsents.signalType,
        grantedAt: desktopSignalConsents.grantedAt,
        revokedAt: desktopSignalConsents.revokedAt,
      })
      .from(desktopSignalConsents)
      .where(
        and(
          eq(desktopSignalConsents.workspaceId, workspaceId),
          eq(desktopSignalConsents.userId, userId),
          eq(desktopSignalConsents.signalType, signalType),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      signalType: row.signalType,
      grantedAt: row.grantedAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    };
  }

  private async record(
    workspaceId: string,
    userId: string,
    signalType: string,
    type: 'DesktopSignalConsentGranted' | 'DesktopSignalConsentRevoked',
  ): Promise<DesktopSignalConsentSnapshot> {
    const streamId = this.streamIdFor(workspaceId, userId, signalType);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: DESKTOP_SIGNAL_CONSENT_STREAM_TYPE,
      workspaceId,
      type,
      payload: { signalType },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const current = await this.get(workspaceId, userId, signalType);

    if (!current) {
      throw new UnexpectedQueryResultError(
        'Failed to read back desktop signal consent immediately after writing it.',
      );
    }

    return current;
  }

  private streamIdFor(workspaceId: string, userId: string, signalType: string): string {
    return deriveDeterministicUuid(
      DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE,
      `${workspaceId}:${userId}:${signalType}`,
    );
  }
}
