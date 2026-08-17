import { describe, expect, it } from 'vitest';

import {
  memoryRecordAddedPayloadSchema,
  memoryRecordDeletedPayloadSchema,
  memoryRecordEditedPayloadSchema,
} from './memory-record-events.js';

import type {
  MemoryRecordAddedPayload,
  MemoryRecordDeletedPayload,
  MemoryRecordEditedPayload,
} from './memory-record-events.js';

/**
 * F2-T5 PR1 (RED step) — the three `MemoryRecord` event payload schemas,
 * per ADR-0022 Karar (c)/(e) (`docs/adr/ADR-0022-memory-passport.md`).
 *
 * Designed API (pinned as a contract for `implementer`; must be matched
 * exactly), a direct structural parallel to `packages/shared/src/events/domain-event.ts`'s
 * `domainEventSchema`/`.strict()` convention and
 * `packages/core-objects/src/fields/ai/ai-value.ts`'s
 * schema-plus-inferred-type-export convention (export the zod schema
 * directly, callers call `.safeParse()`/`.parse()` themselves — no
 * `parseXPayload()` wrapper is introduced, since none of the schemas this
 * package's sibling schemas export use that convention):
 *
 *   export const memoryRecordAddedPayloadSchema: z.ZodType<{ content: string }>;
 *   export const memoryRecordEditedPayloadSchema: z.ZodType<{ content: string }>;
 *   export const memoryRecordDeletedPayloadSchema: z.ZodType<Record<string, never>>;
 *   export type MemoryRecordAddedPayload = z.infer<typeof memoryRecordAddedPayloadSchema>;
 *   export type MemoryRecordEditedPayload = z.infer<typeof memoryRecordEditedPayloadSchema>;
 *   export type MemoryRecordDeletedPayload = z.infer<typeof memoryRecordDeletedPayloadSchema>;
 *
 * All three are `.strict()` (ADR-0022 Karar c: "Hepsi `DomainEvent` zarfına
 * ... zod `.strict()` ... uyar") — unknown/extra keys must be rejected
 * (mass-assignment protection, the same concern `domain-event.ts`'s
 * `actorSchema`/`domainEventSchema` doc comments call out).
 *
 * `content` must be a non-empty string — an empty-string memory record is
 * meaningless (no repo-wide max-length convention exists for a free-text
 * `content`-like field, so none is invented here; see `field-type-registry.ts`'s
 * `MAX_OPTION_LENGTH`/`MAX_EXPRESSION_LENGTH` constants, which are specific
 * to bounded structured fields, not general free text).
 *
 * `MemoryRecordDeleted`'s payload is empty (`{}`) per ADR-0022 Karar (c):
 * "tombstone'un kendisi `event.type`'ın varlığıyla ifade edilir, ek bir
 * alan gerekmez."
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/memory/src/memory-record-events.ts` (and the surrounding
 * package skeleton — `package.json`, `tsconfig.json`, `tsconfig.build.json`,
 * `vitest.config.ts` — copied 1:1 from `packages/core-objects`).
 */

describe('memoryRecordAddedPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    const payload: MemoryRecordAddedPayload = { content: 'User prefers async communication.' };

    expect(memoryRecordAddedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = memoryRecordAddedPayloadSchema.safeParse({
      content: 'x',
      kaynakOlayId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing "content"', () => {
    expect(memoryRecordAddedPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty-string content', () => {
    expect(memoryRecordAddedPayloadSchema.safeParse({ content: '' }).success).toBe(false);
  });

  const NON_STRING_CONTENTS: unknown[] = [123, null, undefined, {}, [], true];

  it.each(NON_STRING_CONTENTS)('rejects a non-string content = %p', (badContent) => {
    expect(memoryRecordAddedPayloadSchema.safeParse({ content: badContent }).success).toBe(false);
  });

  it('rejects an unrelated object shape', () => {
    expect(memoryRecordAddedPayloadSchema.safeParse({ anything: 'else' }).success).toBe(false);
  });
});

describe('memoryRecordEditedPayloadSchema', () => {
  it('accepts a well-formed payload (full-content replacement, ADR-0022 Karar e)', () => {
    const payload: MemoryRecordEditedPayload = { content: 'Updated preference.' };

    expect(memoryRecordEditedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = memoryRecordEditedPayloadSchema.safeParse({
      content: 'x',
      previousContent: 'y',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing "content"', () => {
    expect(memoryRecordEditedPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty-string content', () => {
    expect(memoryRecordEditedPayloadSchema.safeParse({ content: '' }).success).toBe(false);
  });

  const NON_STRING_CONTENTS: unknown[] = [123, null, undefined, {}, [], true];

  it.each(NON_STRING_CONTENTS)('rejects a non-string content = %p', (badContent) => {
    expect(memoryRecordEditedPayloadSchema.safeParse({ content: badContent }).success).toBe(false);
  });

  it('does NOT accept a field-based patch shape ({field, oldValue, newValue}) — Karar (e) rejects patch schemas', () => {
    const result = memoryRecordEditedPayloadSchema.safeParse({
      field: 'content',
      oldValue: 'a',
      newValue: 'b',
    });

    expect(result.success).toBe(false);
  });
});

describe('memoryRecordDeletedPayloadSchema', () => {
  it('accepts an empty payload', () => {
    const payload: MemoryRecordDeletedPayload = {};

    expect(memoryRecordDeletedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a payload with any extra key (.strict()) — tombstone carries no fields', () => {
    const result = memoryRecordDeletedPayloadSchema.safeParse({ reason: 'user requested' });

    expect(result.success).toBe(false);
  });

  it('rejects a non-object input', () => {
    expect(memoryRecordDeletedPayloadSchema.safeParse('not-an-object').success).toBe(false);
    expect(memoryRecordDeletedPayloadSchema.safeParse(null).success).toBe(false);
    expect(memoryRecordDeletedPayloadSchema.safeParse(undefined).success).toBe(false);
  });
});
