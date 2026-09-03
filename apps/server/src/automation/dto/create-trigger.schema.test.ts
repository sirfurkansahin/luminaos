import { describe, expect, it } from 'vitest';

import { triggerSpecSchema } from './create-trigger.schema.js';

/**
 * F2-T17 PR1 (RED step) — pins that `triggerSpecSchema` (currently
 * file-private inside `create-trigger.schema.ts`) is now EXPORTED, per
 * ADR-0034 Karar (e)/Bağlam madde 8: this discriminated union is needed a
 * THIRD time (by `../../ai/suggest-trigger-templates.ts`'s response schema)
 * and must NOT be re-written/duplicated.
 *
 * This file deliberately does NOT re-test `createTriggerSchema`'s own
 * already-covered behavior (that would duplicate whatever test coverage
 * already exists for the DTO as a whole) -- its only job is pinning that the
 * export exists with the right shape.
 *
 * Nothing under test here exists yet on `main`: the `import { triggerSpecSchema }`
 * line above is expected to fail today with a "no exported member
 * 'triggerSpecSchema'" / module-shape error (`triggerSpecSchema` is currently
 * declared but not `export`ed in `create-trigger.schema.ts`) until
 * `implementer` adds the `export` keyword.
 */
describe('triggerSpecSchema — exported from create-trigger.schema.ts (ADR-0034 Karar (e))', () => {
  it('is exported and accepts a valid ScheduleSpec-shaped object', () => {
    const result = triggerSpecSchema.safeParse({
      kind: 'scheduled',
      intervalMinutes: 60,
      actionTemplate: { title: 'Send a reminder' },
    });

    expect(result.success).toBe(true);
  });
});
