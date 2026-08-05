import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { documentContentSnapshottedPayloadSchema } from './dto/document-snapshot.schema.js';
import { documentSnapshots } from '../db/schema/document-snapshots.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `ObjectsViewProjection`'s own `DbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries, so it
 * casts the opaque handle back — mirroring `ObjectsViewProjection`'s own
 * `asDbTransaction` pattern.
 */
function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

/**
 * Persists a `doc` object's full-state snapshots into the dedicated
 * `document_snapshots` table (ADR-0011 §(f)). An INDEPENDENT log consumer:
 * it handles ONLY `DocumentContentSnapshotted` (never `DocumentEdited`, a
 * content-free audit event) and keys each row by
 * `(object_id = payload.docId, version = event.version)` — the DomainEvent
 * ENVELOPE version (stream position), NOT the payload's own `version` field.
 *
 * `apply` parses the untrusted event payload with the shared zod schema
 * (defensive, mirroring `ObjectsViewProjection`'s own throw-on-malformed
 * discipline) and inserts the base64-DECODED snapshot bytes with
 * `.onConflictDoNothing()` so replaying the log is idempotent — re-applying
 * the same `(object_id, version)` never throws a duplicate-key error nor
 * creates a second row.
 */
export class DocumentSnapshotsProjection implements Projection {
  readonly name = 'document-snapshots';
  readonly handles: readonly string[] = ['DocumentContentSnapshotted'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    // Defensive: a malformed payload must fail loudly rather than silently
    // persist a corrupt/oversized snapshot (matches how ObjectsViewProjection
    // throws on bad payloads). `documentContentSnapshottedPayloadSchema`
    // enforces the base64 format and the MAX_SNAPSHOT_BYTES decoded-size cap.
    const payload = documentContentSnapshottedPayloadSchema.parse(event.payload);

    await dbTx
      .insert(documentSnapshots)
      .values({
        objectId: payload.docId,
        version: event.version,
        snapshot: Buffer.from(payload.snapshot, 'base64'),
        workspaceId: event.workspaceId,
        createdAt: event.occurredAt,
      })
      .onConflictDoNothing();
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(documentSnapshots);
  }
}
