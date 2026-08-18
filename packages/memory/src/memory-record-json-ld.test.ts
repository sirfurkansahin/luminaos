import { describe, expect, it } from 'vitest';

import { MEMORY_RECORD_JSON_LD_CONTEXT, toMemoryRecordJsonLd } from './memory-record-json-ld.js';

import type { MemoryRecordJsonLd } from './memory-record-json-ld.js';
import type { MemoryRecord } from './memory-record.js';

/**
 * F2-T7 PR1 (RED step) — `toMemoryRecordJsonLd` and its pinned
 * `MEMORY_RECORD_JSON_LD_CONTEXT`, per ADR-0023 Karar (c)
 * (`docs/adr/ADR-0023-ice-disa-aktarim-json-ld.md`).
 *
 * Designed API (pinned as a contract for `implementer`; must be matched
 * exactly — see ADR-0023 §c for the full code snippet this test file
 * transcribes verbatim):
 *
 *   export const MEMORY_RECORD_JSON_LD_CONTEXT: {
 *     schema: 'https://schema.org/';
 *     luminaos: 'https://luminaos.dev/vocab#';
 *     content: 'schema:text';
 *     createdAt: 'schema:dateCreated';
 *     updatedAt: 'schema:dateModified';
 *     kaynakOlayId: 'luminaos:kaynakOlayId';
 *   };
 *   export interface MemoryRecordJsonLd { '@context', '@type', '@id',
 *     content, createdAt, updatedAt, kaynakOlayId }
 *   export function toMemoryRecordJsonLd(record: MemoryRecord): MemoryRecordJsonLd;
 *
 * `workspaceId`/`userId`/`deletedAt` are deliberately excluded from the
 * output (ADR-0023 §c, last bullet) — pinned below as real
 * `not.toHaveProperty` assertions, not merely an omission from the
 * expected-shape object.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/memory/src/memory-record-json-ld.ts` — this file does not
 * exist yet, so this test file fails at MODULE RESOLUTION time (before any
 * assertion runs).
 */

function makeFixtureRecord(): MemoryRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    content: 'User prefers async communication.',
    kaynakOlayId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    deletedAt: null,
  };
}

describe('MEMORY_RECORD_JSON_LD_CONTEXT', () => {
  it('is the exact pinned schema.org + luminaos vocab context object (ADR-0023 §c)', () => {
    expect(MEMORY_RECORD_JSON_LD_CONTEXT).toEqual({
      schema: 'https://schema.org/',
      luminaos: 'https://luminaos.dev/vocab#',
      content: 'schema:text',
      createdAt: 'schema:dateCreated',
      updatedAt: 'schema:dateModified',
      kaynakOlayId: 'luminaos:kaynakOlayId',
    });
  });
});

describe('toMemoryRecordJsonLd', () => {
  it('sets "@context" to the exact MEMORY_RECORD_JSON_LD_CONTEXT object', () => {
    const record = makeFixtureRecord();

    const result: MemoryRecordJsonLd = toMemoryRecordJsonLd(record);

    expect(result['@context']).toEqual(MEMORY_RECORD_JSON_LD_CONTEXT);
  });

  it('sets "@type" to the literal "schema:Note" (not "schema:CreativeWork")', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result['@type']).toBe('schema:Note');
  });

  it('sets "@id" to `urn:luminaos:memory-record:<record.id>` (a URN, not an HTTP URL)', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result['@id']).toBe(`urn:luminaos:memory-record:${record.id}`);
  });

  it('maps content verbatim', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result.content).toBe(record.content);
  });

  it('maps createdAt to record.createdAt.toISOString()', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result.createdAt).toBe(record.createdAt.toISOString());
  });

  it('maps updatedAt to record.updatedAt.toISOString()', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result.updatedAt).toBe(record.updatedAt.toISOString());
  });

  it('maps kaynakOlayId verbatim', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result.kaynakOlayId).toBe(record.kaynakOlayId);
  });

  it('does NOT include workspaceId, userId, or deletedAt (ADR-0023 §c — internal identifiers excluded)', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result).not.toHaveProperty('workspaceId');
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('deletedAt');
  });

  it('produces the exact full pinned shape for a well-formed record (belt-and-suspenders end-to-end check)', () => {
    const record = makeFixtureRecord();

    const result = toMemoryRecordJsonLd(record);

    expect(result).toEqual({
      '@context': MEMORY_RECORD_JSON_LD_CONTEXT,
      '@type': 'schema:Note',
      '@id': `urn:luminaos:memory-record:${record.id}`,
      content: record.content,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      kaynakOlayId: record.kaynakOlayId,
    });
  });
});
