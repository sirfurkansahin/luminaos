import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { aiUsageRecords } from '../db/schema/ai-usage.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `ObjectsViewProjection`/`FieldDefinitionsViewProjection`'s own `asDbTransaction`). */
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

function requireIntegerPayloadField(event: DomainEvent, field: string): number {
  const value = event.payload[field];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * Like `requireStringPayloadField`, but tolerates ABSENCE (returns
 * `undefined`) — only a PRESENT-but-wrong-typed value throws. Used for
 * optional payload fields (`model`) introduced after the event type already
 * had production traffic, so old events lacking the field must not fail.
 */
function optionalStringPayloadField(event: DomainEvent, field: string): string | undefined {
  const value = event.payload[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidObjectStateError(
      `"${event.type}" event has an invalid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * Like `requireIntegerPayloadField`, but tolerates ABSENCE (returns
 * `undefined`) — only a PRESENT-but-invalid value throws. Used for the
 * optional `costUsd` payload field: a finite number is required when present,
 * but the field may be entirely missing on older events.
 */
function optionalFiniteNumberPayloadField(event: DomainEvent, field: string): number | undefined {
  const value = event.payload[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidObjectStateError(
      `"${event.type}" event has an invalid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * `ai_usage_records` read-model projection (F1-T5 PR-C): one row per
 * `AIUsageRecorded` event. Every OTHER read model in this codebase
 * (`ObjectsViewProjection`, `FieldDefinitionsViewProjection`,
 * `RelationsViewProjection`) goes through this same checkpoint-based
 * `Projection`/`ProjectionRunner.catchUp()` pattern for rebuild-safety —
 * this table follows suit for consistency, even though it is a pure
 * append-only audit/quota-accounting log with no business-uniqueness
 * constraint to reconcile (each event maps to exactly one insert, by the
 * event's own id, with no update/delete path ever).
 */
export class AIUsageProjection implements Projection {
  readonly name = 'ai-usage';
  readonly handles: readonly string[] = ['AIUsageRecorded'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    if (event.type !== 'AIUsageRecorded') {
      return;
    }

    const dbTx = asDbTransaction(tx);

    const workspaceId = requireStringPayloadField(event, 'workspaceId');
    const fieldDefinitionId = optionalStringPayloadField(event, 'fieldDefinitionId');
    const objectId = optionalStringPayloadField(event, 'objectId');
    const inputTokens = requireIntegerPayloadField(event, 'inputTokens');
    const outputTokens = requireIntegerPayloadField(event, 'outputTokens');
    const model = optionalStringPayloadField(event, 'model');
    const costUsd = optionalFiniteNumberPayloadField(event, 'costUsd');

    // `onConflictDoNothing` on the primary key (the event's own id) — an
    // idempotent replay of the same `AIUsageRecorded` event (event-store
    // replay, or `catchUp` re-processing a batch) must never double-count
    // a workspace's token usage.
    await dbTx
      .insert(aiUsageRecords)
      .values({
        id: event.id,
        workspaceId,
        fieldDefinitionId: fieldDefinitionId ?? null,
        objectId: objectId ?? null,
        inputTokens,
        outputTokens,
        model: model ?? null,
        costUsd: costUsd === undefined ? null : costUsd.toString(),
        createdAt: event.occurredAt,
      })
      .onConflictDoNothing({ target: aiUsageRecords.id });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(aiUsageRecords);
  }
}
