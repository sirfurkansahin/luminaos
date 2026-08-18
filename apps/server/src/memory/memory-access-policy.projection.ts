import { and, eq } from 'drizzle-orm';

import { newObjectId } from '@luminaos/core-objects';
import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { memoryAccessPolicies } from '../db/schema/memory-access-policies.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `DesktopSignalConsentProjection`'s own `asDbTransaction`). */
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
 * `memory_access_policies` read-model projection (F2-T8, ADR-0024 §j) —
 * the BIREBIR structural equivalent of `DesktopSignalConsentProjection`:
 * upserts on `(workspaceId, userId, agentIdentifier)`. `MemoryAccessGranted`
 * resets `revokedAt` to `null` on re-grant (a revoke followed by a re-grant
 * must not leave a stale `revokedAt` behind); `MemoryAccessRevoked` sets
 * `revokedAt` on the matching row — NO physical `DELETE`.
 */
export class MemoryAccessPolicyProjection implements Projection {
  readonly name = 'memory-access-policy';
  readonly handles: readonly string[] = ['MemoryAccessGranted', 'MemoryAccessRevoked'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    const workspaceId = event.workspaceId;
    const userId = event.actor.id;
    const agentIdentifier = requireStringPayloadField(event, 'agentIdentifier');

    switch (event.type) {
      case 'MemoryAccessGranted': {
        await dbTx
          .insert(memoryAccessPolicies)
          .values({
            id: newObjectId(),
            workspaceId,
            userId,
            agentIdentifier,
            grantedAt: event.occurredAt,
            revokedAt: null,
          })
          .onConflictDoUpdate({
            target: [
              memoryAccessPolicies.workspaceId,
              memoryAccessPolicies.userId,
              memoryAccessPolicies.agentIdentifier,
            ],
            set: { grantedAt: event.occurredAt, revokedAt: null },
          });
        return;
      }
      case 'MemoryAccessRevoked': {
        await dbTx
          .update(memoryAccessPolicies)
          .set({ revokedAt: event.occurredAt })
          .where(
            and(
              eq(memoryAccessPolicies.workspaceId, workspaceId),
              eq(memoryAccessPolicies.userId, userId),
              eq(memoryAccessPolicies.agentIdentifier, agentIdentifier),
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

    await dbTx.delete(memoryAccessPolicies);
  }
}
