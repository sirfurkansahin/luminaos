import { describe, expect, it } from 'vitest';

import { taskAutonomyTierSetPayloadSchema } from './autonomy-tier-events.js';

/**
 * F3-T5 PR1 (RED step), ADR-0039 Karar (b) — `packages/agent-runtime/src/
 * autonomy-tier-events.ts`'s `TaskAutonomyTierSet` payload schema. Table-
 * driven valid/invalid payloads, mirrors `agent-permission-manifest-events.
 * test.ts`'s exact structure/`.strict()`-lock-in convention:
 * `workspaceId`/`actor`/`occurredAt` all come from the surrounding
 * `DomainEvent` envelope, NOT the payload -- the payload itself carries only
 * `{ actionType, tier }`.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/autonomy-tier-events.ts`.
 */

describe('taskAutonomyTierSetPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    const payload = { actionType: 'createTask', tier: 'approve_and_act' };
    expect(taskAutonomyTierSetPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it.each(['propose', 'approve_and_act', 'act_and_notify'] as const)(
    'accepts each of the 3 valid tier values (tier=%s)',
    (tier) => {
      expect(
        taskAutonomyTierSetPayloadSchema.safeParse({ actionType: 'createTask', tier }).success,
      ).toBe(true);
    },
  );

  it('rejects a missing actionType', () => {
    expect(taskAutonomyTierSetPayloadSchema.safeParse({ tier: 'propose' }).success).toBe(false);
  });

  it('rejects an empty-string actionType (min length 1)', () => {
    expect(
      taskAutonomyTierSetPayloadSchema.safeParse({ actionType: '', tier: 'propose' }).success,
    ).toBe(false);
  });

  it('rejects actionType over 100 chars', () => {
    expect(
      taskAutonomyTierSetPayloadSchema.safeParse({ actionType: 'a'.repeat(101), tier: 'propose' })
        .success,
    ).toBe(false);
  });

  it('accepts actionType at exactly the 100-char boundary', () => {
    expect(
      taskAutonomyTierSetPayloadSchema.safeParse({ actionType: 'a'.repeat(100), tier: 'propose' })
        .success,
    ).toBe(true);
  });

  it('rejects a missing tier', () => {
    expect(taskAutonomyTierSetPayloadSchema.safeParse({ actionType: 'createTask' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid tier value outside the 3-member enum', () => {
    expect(
      taskAutonomyTierSetPayloadSchema.safeParse({ actionType: 'createTask', tier: 'auto_pilot' })
        .success,
    ).toBe(false);
  });

  it('rejects an empty-string tier', () => {
    expect(
      taskAutonomyTierSetPayloadSchema.safeParse({ actionType: 'createTask', tier: '' }).success,
    ).toBe(false);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = taskAutonomyTierSetPayloadSchema.safeParse({
      actionType: 'createTask',
      tier: 'propose',
      extra: 'field',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload carrying workspaceId/actor/occurredAt -- those belong to the DomainEvent envelope, never the payload', () => {
    const result = taskAutonomyTierSetPayloadSchema.safeParse({
      actionType: 'createTask',
      tier: 'propose',
      workspaceId: 'ws-1',
      actor: { type: 'user', id: 'user-1' },
      occurredAt: '2026-09-08T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});
