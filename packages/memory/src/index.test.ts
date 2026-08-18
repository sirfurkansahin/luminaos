import { describe, expect, it } from 'vitest';

import {
  isAgentAllowedToAccessMemory,
  memoryAccessGrantedPayloadSchema,
  memoryAccessRevokedPayloadSchema,
  memoryRecordAddedPayloadSchema,
  memoryRecordDeletedPayloadSchema,
  memoryRecordEditedPayloadSchema,
} from './index.js';

import type { MemoryAccessPolicy } from './index.js';

/**
 * F2-T5 PR1 (RED step) — public export-surface smoke test for
 * `packages/memory`, mirroring `packages/core-objects/src/index.test.ts`'s
 * role (proving the package's `index.ts` barrel re-exports its public
 * schemas, the same way `core-objects`'s barrel re-exports every module
 * under `./lumina-object.js`, `./commands.js`, etc. — see
 * `packages/core-objects/src/index.ts`).
 *
 * `packages/memory` has no placeholder-function scaffold (unlike
 * `core-objects`'s now-vestigial `corePlaceholder`) because this package is
 * scaffolded with its real ADR-0022 surface from day one — there is nothing
 * left to placeholder.
 *
 * Expected to fail (red) until `implementer` adds `packages/memory/src/index.ts`
 * re-exporting `./memory-record-events.js` (and `./memory-record.js`, the
 * `MemoryRecord` type per ADR-0022 Karar (b) — untested here directly since
 * it is a compile-time-only interface with no runtime schema, matching
 * `core-objects`'s `LuminaObject` precedent, which likewise has no
 * dedicated test file).
 *
 * F2-T8 (RED step, ADR-0024) additionally pins the barrel re-exporting
 * `./memory-access-policy-events.js` (`memoryAccessGrantedPayloadSchema`/
 * `memoryAccessRevokedPayloadSchema`) and
 * `./is-agent-allowed-to-access-memory.js`
 * (`isAgentAllowedToAccessMemory`) — `MemoryAccessPolicy` itself
 * (`./memory-access-policy.js`) is, like `MemoryRecord`, a compile-time-only
 * interface with no runtime schema and is only exercised here as a type,
 * not a dedicated runtime test.
 */

describe('packages/memory public export surface', () => {
  it('re-exports memoryRecordAddedPayloadSchema', () => {
    expect(memoryRecordAddedPayloadSchema.safeParse({ content: 'x' }).success).toBe(true);
  });

  it('re-exports memoryRecordEditedPayloadSchema', () => {
    expect(memoryRecordEditedPayloadSchema.safeParse({ content: 'x' }).success).toBe(true);
  });

  it('re-exports memoryRecordDeletedPayloadSchema', () => {
    expect(memoryRecordDeletedPayloadSchema.safeParse({}).success).toBe(true);
  });

  it('re-exports memoryAccessGrantedPayloadSchema (ADR-0024 §g)', () => {
    expect(
      memoryAccessGrantedPayloadSchema.safeParse({ agentIdentifier: 'answer-question' }).success,
    ).toBe(true);
  });

  it('re-exports memoryAccessRevokedPayloadSchema (ADR-0024 §g)', () => {
    expect(
      memoryAccessRevokedPayloadSchema.safeParse({ agentIdentifier: 'answer-question' }).success,
    ).toBe(true);
  });

  it('re-exports isAgentAllowedToAccessMemory (ADR-0024 §l)', () => {
    expect(isAgentAllowedToAccessMemory(undefined)).toBe(false);

    const policy: MemoryAccessPolicy = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      agentIdentifier: 'answer-question',
      grantedAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    };
    expect(isAgentAllowedToAccessMemory(policy)).toBe(true);
  });
});
