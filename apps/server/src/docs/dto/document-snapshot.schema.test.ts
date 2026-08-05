import { describe, expect, it } from 'vitest';

/**
 * F1-T11 PR2 (RED step) — ADR-0011 §(e) "DoS sınırları — snapshot boyut tavanı"
 * and §"Olay tipleri".
 *
 * Pins the zod payload schemas + size cap the implementer will create in
 * `../../docs/dto/document-snapshot.schema.js`. NONE of these exist yet, so
 * every `it` below fails at IMPORT time (module not found) — the correct red
 * state, not an assertion mismatch.
 *
 * Designed exports (implementer matches these precisely):
 *
 *   export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024; // 5 MB, ADR-0011 §(e)
 *
 *   export const documentContentSnapshottedPayloadSchema = z.object({
 *     docId: z.string().min(1),
 *     snapshot: <base64 string; DECODED byte length <= MAX_SNAPSHOT_BYTES>,
 *     version: z.number().int().positive(),
 *   }).strict();
 *
 *   export const documentEditedPayloadSchema = z.object({
 *     docId: z.string().min(1),
 *     actorId: z.string().min(1),
 *     at: <ISO datetime string>,
 *   }).strict();
 *
 * The cap is on the DECODED byte length (the raw Yjs update size, ADR-0011
 * §(e): "kodlanmış Yjs update, base64 öncesi ham boyut"), NOT the base64
 * string's character length — hence the `Buffer.from(snapshot, 'base64')`
 * boundary construction below.
 */
import {
  MAX_SNAPSHOT_BYTES,
  documentContentSnapshottedPayloadSchema,
  documentEditedPayloadSchema,
} from '../../docs/dto/document-snapshot.schema.js';

const SMALL_SNAPSHOT_BASE64 = Buffer.from('yjs-update-payload', 'utf8').toString('base64');

function validSnapshotPayload(): {
  docId: string;
  snapshot: string;
  version: number;
} {
  return {
    docId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    snapshot: SMALL_SNAPSHOT_BASE64,
    version: 1,
  };
}

function validEditedPayload(): { docId: string; actorId: string; at: string } {
  return {
    docId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    actorId: '01ARZ3NDEKTSV4RRFFQ69G5AAA',
    at: '2026-08-05T12:34:56.000Z',
  };
}

describe('MAX_SNAPSHOT_BYTES', () => {
  it('is exactly 5 MB (5 * 1024 * 1024), per ADR-0011 §(e)', () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('documentContentSnapshottedPayloadSchema', () => {
  it('accepts a valid payload (small base64 snapshot, positive integer version)', () => {
    expect(documentContentSnapshottedPayloadSchema.safeParse(validSnapshotPayload()).success).toBe(
      true,
    );
  });

  it('rejects a snapshot whose DECODED byte length exceeds MAX_SNAPSHOT_BYTES', () => {
    const oversized = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1).toString('base64');
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      snapshot: oversized,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a snapshot whose DECODED byte length is exactly MAX_SNAPSHOT_BYTES (inclusive boundary)', () => {
    const atLimit = Buffer.alloc(MAX_SNAPSHOT_BYTES).toString('base64');
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      snapshot: atLimit,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-base64 snapshot string', () => {
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      snapshot: 'not valid base64!!!',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero version', () => {
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      version: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative version', () => {
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      version: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer version', () => {
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      version: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty docId', () => {
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      docId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra keys (.strict())', () => {
    const result = documentContentSnapshottedPayloadSchema.safeParse({
      ...validSnapshotPayload(),
      extra: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('documentEditedPayloadSchema', () => {
  it('accepts a valid payload', () => {
    expect(documentEditedPayloadSchema.safeParse(validEditedPayload()).success).toBe(true);
  });

  it('rejects an empty docId', () => {
    const result = documentEditedPayloadSchema.safeParse({ ...validEditedPayload(), docId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty actorId', () => {
    const result = documentEditedPayloadSchema.safeParse({ ...validEditedPayload(), actorId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO `at` value', () => {
    const result = documentEditedPayloadSchema.safeParse({
      ...validEditedPayload(),
      at: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra keys (.strict())', () => {
    const result = documentEditedPayloadSchema.safeParse({ ...validEditedPayload(), extra: true });
    expect(result.success).toBe(false);
  });
});
