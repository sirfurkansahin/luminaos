import { and, eq } from 'drizzle-orm';

import { newObjectId } from '@luminaos/core-objects';
import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { desktopSignalConsents } from '../db/schema/desktop-signal-consents.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `UserAvailabilityProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

function requireStringPayloadField(event: DomainEvent, field: string): string {
  const value = event.payload[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * `desktop_signal_consents` read-model projection (F2-T3 PR1, ADR-0020 Karar
 * a): upserts on `(workspaceId, userId, signalType)`. `Granted` resets
 * `revokedAt` to `null` on re-grant (a revoke followed by a re-grant must not
 * leave a stale `revokedAt` behind); `Revoked` sets `revokedAt` on the
 * matching row.
 */
export class DesktopSignalConsentProjection implements Projection {
  readonly name = 'desktop-signal-consent';
  readonly handles: readonly string[] = [
    'DesktopSignalConsentGranted',
    'DesktopSignalConsentRevoked',
  ];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    const workspaceId = event.workspaceId;
    const userId = event.actor.id;
    const signalType = requireStringPayloadField(event, 'signalType');

    switch (event.type) {
      case 'DesktopSignalConsentGranted': {
        await dbTx
          .insert(desktopSignalConsents)
          .values({
            id: newObjectId(),
            workspaceId,
            userId,
            signalType,
            grantedAt: event.occurredAt,
            revokedAt: null,
          })
          .onConflictDoUpdate({
            target: [
              desktopSignalConsents.workspaceId,
              desktopSignalConsents.userId,
              desktopSignalConsents.signalType,
            ],
            set: { grantedAt: event.occurredAt, revokedAt: null },
          });
        return;
      }
      case 'DesktopSignalConsentRevoked': {
        await dbTx
          .update(desktopSignalConsents)
          .set({ revokedAt: event.occurredAt })
          .where(
            and(
              eq(desktopSignalConsents.workspaceId, workspaceId),
              eq(desktopSignalConsents.userId, userId),
              eq(desktopSignalConsents.signalType, signalType),
            ),
          );
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(desktopSignalConsents);
  }
}
