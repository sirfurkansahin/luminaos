import { z } from 'zod';

/**
 * Snapshot payload size cap, applied to the DECODED (raw Yjs update) byte
 * length — NOT the base64 string's character length (ADR-0011 §(e): "kodlanmış
 * Yjs update, base64 öncesi ham boyut"). This is the same defense-in-depth
 * discipline as `checklist`'s `CHECKLIST_ITEM_LIMIT`
 * (`packages/core-objects/src/checklist-commands.ts`, F1-T10 PR6b precedent):
 * a fixed, testable upper bound rejected at the boundary so an oversized value
 * can never become an immutable event. The 5 MB figure is ADR-0011 §(e)'s
 * draft threshold, to be finalized under the implementation PR's
 * security-reviewer audit.
 */
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/**
 * Standard base64 alphabet with optional `=` padding, length a multiple of 4.
 * `Buffer.from(x, 'base64')` is LENIENT (silently drops invalid characters),
 * so an explicit structural check is required to reject a non-base64 string
 * like `'not valid base64!!!'` before the byte-length refine below runs.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * Validates a `DocumentContentSnapshotted` event payload (ADR-0011
 * §"Olay tipleri"). `snapshot` is a base64-encoded full Yjs update whose
 * DECODED byte length must not exceed `MAX_SNAPSHOT_BYTES`.
 */
export const documentContentSnapshottedPayloadSchema = z
  .object({
    docId: z.string().min(1),
    snapshot: z
      .string()
      .refine(isBase64, { message: 'snapshot must be a valid base64 string' })
      .refine((value) => Buffer.byteLength(value, 'base64') <= MAX_SNAPSHOT_BYTES, {
        message: `snapshot decoded size must not exceed ${String(MAX_SNAPSHOT_BYTES)} bytes`,
      }),
    version: z.number().int().positive(),
  })
  .strict();

/**
 * Validates a `DocumentEdited` event payload (ADR-0011 §"Olay tipleri"): a
 * lightweight audit event carrying no content, one per editing session.
 */
export const documentEditedPayloadSchema = z
  .object({
    docId: z.string().min(1),
    actorId: z.string().min(1),
    at: z.iso.datetime(),
  })
  .strict();

export type DocumentContentSnapshottedPayload = z.infer<
  typeof documentContentSnapshottedPayloadSchema
>;
export type DocumentEditedPayload = z.infer<typeof documentEditedPayloadSchema>;
