import { describe, expect, it } from 'vitest';

import {
  memoryRecordAddedPayloadSchema,
  memoryRecordDeletedPayloadSchema,
  memoryRecordEditedPayloadSchema,
} from './index.js';

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
});
