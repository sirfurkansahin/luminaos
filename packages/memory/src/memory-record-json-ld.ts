import type { MemoryRecord } from './memory-record.js';

/**
 * `MemoryRecordJsonLd` — the JSON-LD wire shape of a Memory Passport entry,
 * per ADR-0023 Karar (c) (`docs/adr/ADR-0023-ice-disa-aktarim-json-ld.md`).
 *
 * Pinned field-by-field decisions (see the ADR for full rationale):
 * - `@type: 'schema:Note'` (not `schema:CreativeWork`) — a memory record is
 *   a short, free-text self-note; `schema.org/Note` is the narrower, more
 *   accurate match.
 * - `@id: urn:luminaos:memory-record:<id>` — a URN, not an HTTP URL, since
 *   these records do not live at a publicly resolvable web address.
 * - `content`/`createdAt`/`updatedAt` map directly onto existing
 *   `schema.org` terms; `kaynakOlayId` has no `schema.org` equivalent so it
 *   is defined under LuminaOS's own `https://luminaos.dev/vocab#` prefix.
 * - `workspaceId`/`userId`/`deletedAt` are deliberately excluded — internal
 *   identifiers / a filter condition that doesn't belong in the portable
 *   representation.
 */
export const MEMORY_RECORD_JSON_LD_CONTEXT = {
  schema: 'https://schema.org/',
  luminaos: 'https://luminaos.dev/vocab#',
  content: 'schema:text',
  createdAt: 'schema:dateCreated',
  updatedAt: 'schema:dateModified',
  kaynakOlayId: 'luminaos:kaynakOlayId',
} as const;

export interface MemoryRecordJsonLd {
  '@context': typeof MEMORY_RECORD_JSON_LD_CONTEXT;
  '@type': 'schema:Note';
  '@id': string;
  content: string;
  createdAt: string;
  updatedAt: string;
  kaynakOlayId: string;
}

export function toMemoryRecordJsonLd(record: MemoryRecord): MemoryRecordJsonLd {
  return {
    '@context': MEMORY_RECORD_JSON_LD_CONTEXT,
    '@type': 'schema:Note',
    '@id': `urn:luminaos:memory-record:${record.id}`,
    content: record.content,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    kaynakOlayId: record.kaynakOlayId,
  };
}
