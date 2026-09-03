import { and, eq } from 'drizzle-orm';

import { newObjectId } from '@luminaos/core-objects';
import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { agentPermissionManifests } from '../db/schema/agent-permission-manifests.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `MemoryAccessPolicyProjection`'s own `asDbTransaction`). */
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

function requireNullableDatePayloadField(
  payload: Record<string, unknown>,
  field: string,
): Date | null {
  const value = payload[field];

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new InvalidObjectStateError(`"${field}" payload field must be an ISO string or null`);
  }

  return new Date(value);
}

/**
 * `agent_permission_manifests` read-model projection (F3-T1, ADR-0035 Karar
 * b/c) — structurally the BIREBIR equivalent of `MemoryAccessPolicyProjection`,
 * extended to 3 dimensions: upserts on `(workspaceId, agentIdentifier)`.
 * `AgentPermissionGranted` resets `revokedAt` to `null` on re-grant (a revoke
 * followed by a re-grant must not leave a stale `revokedAt` behind), AND
 * overwrites `dataScope`/`actionTypes`/`startsAt`/`expiresAt`/`grantedAt`
 * (ADR-0035 Karar c: re-grant is an upsert, not an additional row).
 * `AgentPermissionRevoked` sets `revokedAt` on the matching row — NO physical
 * `DELETE` (same tombstone principle as `memory_access_policies`).
 */
export class AgentPermissionManifestProjection implements Projection {
  readonly name = 'agent-permission-manifest';
  readonly handles: readonly string[] = ['AgentPermissionGranted', 'AgentPermissionRevoked'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    const workspaceId = event.workspaceId;
    const agentIdentifier = requireStringPayloadField(event, 'agentIdentifier');

    switch (event.type) {
      case 'AgentPermissionGranted': {
        const payload = event.payload;
        const timeWindow = payload['timeWindow'];
        const timeWindowRecord =
          timeWindow !== null && typeof timeWindow === 'object'
            ? (timeWindow as Record<string, unknown>)
            : {};

        await dbTx
          .insert(agentPermissionManifests)
          .values({
            id: newObjectId(),
            workspaceId,
            agentIdentifier,
            dataScope: payload['dataScope'],
            actionTypes: payload['actionTypes'],
            startsAt: requireNullableDatePayloadField(timeWindowRecord, 'startsAt'),
            expiresAt: requireNullableDatePayloadField(timeWindowRecord, 'expiresAt'),
            grantedAt: event.occurredAt,
            revokedAt: null,
          })
          .onConflictDoUpdate({
            target: [
              agentPermissionManifests.workspaceId,
              agentPermissionManifests.agentIdentifier,
            ],
            set: {
              dataScope: payload['dataScope'],
              actionTypes: payload['actionTypes'],
              startsAt: requireNullableDatePayloadField(timeWindowRecord, 'startsAt'),
              expiresAt: requireNullableDatePayloadField(timeWindowRecord, 'expiresAt'),
              grantedAt: event.occurredAt,
              revokedAt: null,
            },
          });
        return;
      }
      case 'AgentPermissionRevoked': {
        await dbTx
          .update(agentPermissionManifests)
          .set({ revokedAt: event.occurredAt })
          .where(
            and(
              eq(agentPermissionManifests.workspaceId, workspaceId),
              eq(agentPermissionManifests.agentIdentifier, agentIdentifier),
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

    await dbTx.delete(agentPermissionManifests);
  }
}
