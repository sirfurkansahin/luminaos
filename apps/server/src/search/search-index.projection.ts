import { eq, sql } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { searchIndex } from '../db/schema/search-index.js';
import { documentContentSnapshottedPayloadSchema } from '../docs/dto/document-snapshot.schema.js';
import { extractPlainTextFromYjsUpdate } from '../docs/yjs-plain-text.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `ObjectsViewProjection`'s own `DbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries, so it
 * casts the opaque handle back -- mirroring `ObjectsViewProjection`'s own
 * `asDbTransaction` pattern.
 */
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
 * `search_index` full-text-search projection (ADR-0013 §(d)): folds
 * `ObjectCreated`/`ObjectRenamed` into `search_index`'s `tsv` column via
 * Postgres's own `to_tsvector('simple', ...)` (F1-T13 PR3a), and folds
 * `DocumentContentSnapshotted`'s Yjs-decoded doc text into `doc_text`/`tsv`
 * as well (F1-T13 PR3b).
 */
export class SearchIndexProjection implements Projection {
  readonly name = 'search-index';
  readonly handles: readonly string[] = [
    'ObjectCreated',
    'ObjectRenamed',
    'DocumentContentSnapshotted',
  ];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'ObjectCreated': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const title = event.payload['title'];

        // Mirrors `ObjectsViewProjection`'s own `InvalidObjectStateError`
        // discipline for the identical event/field: a missing/non-string
        // `title` must throw, never insert a row with a bad/placeholder
        // title.
        if (typeof title !== 'string') {
          throw new InvalidObjectStateError(
            '"ObjectCreated" event is missing a valid "title" payload field',
          );
        }

        await dbTx.insert(searchIndex).values({
          objectId,
          workspaceId: event.workspaceId,
          title,
          docText: null,
          tsv: sql`to_tsvector('simple', ${title})`,
          embedding: null,
          updatedAt: event.occurredAt,
        });
        return;
      }
      case 'ObjectRenamed': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const title = event.payload['title'];

        if (typeof title !== 'string') {
          throw new InvalidObjectStateError(
            '"ObjectRenamed" event is missing a valid "title" payload field',
          );
        }

        // `doc_text` stays whatever it already was (NULL in this PR's
        // scope) -- referencing the target table's OWN current `doc_text`
        // column value directly inside the same UPDATE's SET clause,
        // Postgres allows this without a subquery.
        await dbTx
          .update(searchIndex)
          .set({
            title,
            tsv: sql`to_tsvector('simple', ${title} || ' ' || coalesce(${searchIndex.docText}, ''))`,
            updatedAt: event.occurredAt,
          })
          .where(eq(searchIndex.objectId, objectId));
        return;
      }
      case 'DocumentContentSnapshotted': {
        const payload = documentContentSnapshottedPayloadSchema.parse(event.payload);
        const docText = extractPlainTextFromYjsUpdate(Buffer.from(payload.snapshot, 'base64'));

        const updated = await dbTx
          .update(searchIndex)
          .set({
            docText,
            tsv: sql`to_tsvector('simple', coalesce(${searchIndex.title}, '') || ' ' || ${docText})`,
            updatedAt: event.occurredAt,
          })
          .where(eq(searchIndex.objectId, payload.docId))
          .returning({ objectId: searchIndex.objectId });

        // An orphan snapshot (no prior `ObjectCreated` row for this
        // `docId`) should never happen in practice -- `ObjectCreated`
        // always precedes any doc snapshot on the same object stream --
        // but must fail loudly rather than silently no-op, mirroring PR3a's
        // `InvalidObjectStateError` discipline.
        if (updated.length === 0) {
          throw new InvalidObjectStateError(
            `"DocumentContentSnapshotted" event references unknown search_index row "${payload.docId}"`,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(searchIndex);
  }
}
