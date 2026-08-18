import { describe, expect, it } from 'vitest';

import {
  memoryAccessGrantedPayloadSchema,
  memoryAccessRevokedPayloadSchema,
} from './memory-access-policy-events.js';

import type {
  MemoryAccessGrantedPayload,
  MemoryAccessRevokedPayload,
} from './memory-access-policy-events.js';

/**
 * F2-T8 (RED step) — the two `MemoryAccessPolicy` event payload schemas,
 * per ADR-0024 Karar (g) (`docs/adr/ADR-0024-bellek-kullanim-politikasi.md`).
 *
 * Designed API (pinned as a contract for `implementer`; must be matched
 * exactly), a direct structural parallel to
 * `memory-record-events.test.ts`'s own test style and
 * `packages/shared/src/events/domain-event.ts`'s `.strict()` convention:
 *
 *   export const memoryAccessGrantedPayloadSchema: z.ZodType<{ agentIdentifier: string }>;
 *   export const memoryAccessRevokedPayloadSchema: z.ZodType<{ agentIdentifier: string }>;
 *   export type MemoryAccessGrantedPayload = z.infer<typeof memoryAccessGrantedPayloadSchema>;
 *   export type MemoryAccessRevokedPayload = z.infer<typeof memoryAccessRevokedPayloadSchema>;
 *
 * Both are `.strict()` (ADR-0024 §g: "`memory-record-events.ts`'in AYNI
 * `.strict()` zod konvansiyonu") — unknown/extra keys must be rejected
 * (mass-assignment protection, same concern as `memory-record-events.ts`'s
 * own payload schemas).
 *
 * `agentIdentifier` must be a non-empty string (`z.string().min(1)`, ADR-0024
 * Karar (a): unconstrained, no enum, but never empty) — `workspaceId`/
 * `occurredAt`/`userId` all come from the surrounding `DomainEvent` envelope,
 * not the payload (ADR-0024 §g).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/memory/src/memory-access-policy-events.ts`.
 */

describe('memoryAccessGrantedPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    const payload: MemoryAccessGrantedPayload = { agentIdentifier: 'answer-question' };

    expect(memoryAccessGrantedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = memoryAccessGrantedPayloadSchema.safeParse({
      agentIdentifier: 'answer-question',
      userId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing "agentIdentifier"', () => {
    expect(memoryAccessGrantedPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty-string agentIdentifier', () => {
    expect(memoryAccessGrantedPayloadSchema.safeParse({ agentIdentifier: '' }).success).toBe(false);
  });

  const NON_STRING_AGENT_IDENTIFIERS: unknown[] = [123, null, undefined, {}, [], true];

  it.each(NON_STRING_AGENT_IDENTIFIERS)(
    'rejects a non-string agentIdentifier = %p',
    (badAgentIdentifier) => {
      expect(
        memoryAccessGrantedPayloadSchema.safeParse({ agentIdentifier: badAgentIdentifier }).success,
      ).toBe(false);
    },
  );

  it('rejects an unrelated object shape', () => {
    expect(memoryAccessGrantedPayloadSchema.safeParse({ anything: 'else' }).success).toBe(false);
  });
});

describe('memoryAccessRevokedPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    const payload: MemoryAccessRevokedPayload = { agentIdentifier: 'answer-question' };

    expect(memoryAccessRevokedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = memoryAccessRevokedPayloadSchema.safeParse({
      agentIdentifier: 'answer-question',
      reason: 'user requested',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing "agentIdentifier"', () => {
    expect(memoryAccessRevokedPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty-string agentIdentifier', () => {
    expect(memoryAccessRevokedPayloadSchema.safeParse({ agentIdentifier: '' }).success).toBe(false);
  });

  const NON_STRING_AGENT_IDENTIFIERS: unknown[] = [123, null, undefined, {}, [], true];

  it.each(NON_STRING_AGENT_IDENTIFIERS)(
    'rejects a non-string agentIdentifier = %p',
    (badAgentIdentifier) => {
      expect(
        memoryAccessRevokedPayloadSchema.safeParse({ agentIdentifier: badAgentIdentifier }).success,
      ).toBe(false);
    },
  );

  it('rejects an unrelated object shape', () => {
    expect(memoryAccessRevokedPayloadSchema.safeParse({ anything: 'else' }).success).toBe(false);
  });
});
