import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ForbiddenError, deriveDeterministicUuid } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { DesktopSignalConsentsService } from './desktop-signal-consents.service.js';
import { EventStoreService } from '../event-store/event-store.service.js';

const DESKTOP_SIGNAL_STREAM_TYPE = 'desktop-signal';

/**
 * Fixed, arbitrary namespace UUID for deriving per-(workspace, user,
 * signalType) desktop-signal streamIds. Deliberately SEPARATE from
 * `DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE` (`desktop-signal-consents.service.ts`)
 * — captured signal values and consent grants/revocations are independent
 * event streams (F2-T3 PR2, ADR-0020 Karar b/c). MUST NEVER CHANGE once real
 * data exists -- changing it silently opens a new stream per triple, losing
 * continuity with any prior signal-capture history.
 */
export const DESKTOP_SIGNAL_UUID_NAMESPACE = 'a7c9e2f4-1b3d-4e5f-9a8b-6c7d8e9f0a1b';

/**
 * F2-T3 PR2 (ADR-0020 Karar b/c/d): `DesktopSignalsService`, an
 * event-sourced, self-service, per-(workspace, user, signalType) ingestion
 * write path for desktop signal captures. Every capture is gated by an
 * active consent (`DesktopSignalConsentsService.get`) — no consent, or a
 * revoked one, rejects with `ForbiddenError` and writes no event. Its
 * `streamId` is a DETERMINISTIC function of `(workspaceId, userId,
 * signalType)`, mirroring `DesktopSignalConsentsService.streamIdFor`'s
 * pattern but under a separate namespace.
 *
 * Deliberately does NOT call `ProjectionRunner.catchUp` synchronously (ADR-
 * 0020 Karar b.3) — the already-shipped `ContextGraphSyncWorker`'s interval
 * catch-up loop is responsible for folding `DesktopSignalCaptured` events
 * into `ContextGraphProjection`.
 */
@Injectable()
export class DesktopSignalsService {
  constructor(
    private readonly desktopSignalConsentsService: DesktopSignalConsentsService,
    private readonly eventStore: EventStoreService,
  ) {}

  async capture(
    workspaceId: string,
    userId: string,
    signalType: string,
    value: string,
  ): Promise<void> {
    const consent = await this.desktopSignalConsentsService.get(workspaceId, userId, signalType);

    if (!consent || consent.revokedAt !== null) {
      throw new ForbiddenError(
        `No active desktop signal consent for "${signalType}" — grant consent before capturing this signal type.`,
      );
    }

    const streamId = this.streamIdFor(workspaceId, userId, signalType);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: DESKTOP_SIGNAL_STREAM_TYPE,
      workspaceId,
      type: 'DesktopSignalCaptured',
      payload: { signalType, value },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
  }

  private streamIdFor(workspaceId: string, userId: string, signalType: string): string {
    return deriveDeterministicUuid(
      DESKTOP_SIGNAL_UUID_NAMESPACE,
      `${workspaceId}:${userId}:${signalType}`,
    );
  }
}
