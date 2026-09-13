import { describe, expect, it } from 'vitest';

import {
  agentNotificationPreferenceSetPayloadSchema,
  quietHoursWindowSchema,
} from './notification-preference-events.js';

/**
 * F3-T13 PR1 (RED step), ADR-0047 Karar (a)/(b) and the spec's PR1 Kabul
 * Kriterleri (`docs/specs/F3-E5/F3-T13-bildirim-butcesi-sessiz-saatler.md`) —
 * `packages/agent-runtime/src/notification-preference-events.ts`'s
 * `AgentNotificationPreferenceSet` payload schema. Mirrors `autonomy-tier-
 * events.test.ts`'s exact table-driven valid/invalid structure and
 * `.strict()`-lock-in convention: `workspaceId`/`actor`/`occurredAt` all come
 * from the surrounding `DomainEvent` envelope, NOT the payload — the real
 * setting actor (`actor.id === userId`, self-only per ADR-0047 Karar i) IS
 * the envelope's own `actor`, never duplicated into the payload. The
 * `userId` the preference belongs to is likewise NOT carried in the payload
 * for the same reason — it's always `actor.id`, since `set()` is
 * self-only-with-no-admin-exception (ADR-0047 Karar i); a future PR
 * revisiting that RBAC rule would be the point to revisit this schema too.
 *
 * `notificationBudgetPerWindow` bounds (0-10000) and `startHourUtc`/
 * `endHourUtc` bounds (0-23) are this test file's OWN pinned contract
 * choices (ADR-0047 Karar (b) specifies the semantics — a kayan-pencere
 * count and a 0-23 UTC hour — but not exact numeric bounds); `implementer`
 * must match these bounds exactly, same house style as `autonomy-tier-
 * events.test.ts`'s pinned 100-char `actionType` boundary.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/notification-preference-events.ts`.
 */

describe('quietHoursWindowSchema', () => {
  it('accepts a well-formed window', () => {
    expect(quietHoursWindowSchema.safeParse({ startHourUtc: 22, endHourUtc: 7 }).success).toBe(
      true,
    );
  });

  it('accepts a non-wrapping window (start < end)', () => {
    expect(quietHoursWindowSchema.safeParse({ startHourUtc: 1, endHourUtc: 5 }).success).toBe(true);
  });

  it.each([0, 23])('accepts hour boundary value %i for both fields', (hour) => {
    expect(quietHoursWindowSchema.safeParse({ startHourUtc: hour, endHourUtc: hour }).success).toBe(
      true,
    );
  });

  it.each([-1, 24, 100])('rejects out-of-range startHourUtc=%i', (hour) => {
    expect(quietHoursWindowSchema.safeParse({ startHourUtc: hour, endHourUtc: 7 }).success).toBe(
      false,
    );
  });

  it.each([-1, 24, 100])('rejects out-of-range endHourUtc=%i', (hour) => {
    expect(quietHoursWindowSchema.safeParse({ startHourUtc: 22, endHourUtc: hour }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer hour', () => {
    expect(quietHoursWindowSchema.safeParse({ startHourUtc: 22.5, endHourUtc: 7 }).success).toBe(
      false,
    );
  });

  it('rejects a missing startHourUtc', () => {
    expect(quietHoursWindowSchema.safeParse({ endHourUtc: 7 }).success).toBe(false);
  });

  it('rejects a missing endHourUtc', () => {
    expect(quietHoursWindowSchema.safeParse({ startHourUtc: 22 }).success).toBe(false);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    expect(
      quietHoursWindowSchema.safeParse({ startHourUtc: 22, endHourUtc: 7, extra: 'field' }).success,
    ).toBe(false);
  });
});

describe('agentNotificationPreferenceSetPayloadSchema', () => {
  it('accepts a well-formed payload with quietHours set', () => {
    const payload = {
      notificationBudgetPerWindow: 10,
      quietHours: { startHourUtc: 22, endHourUtc: 7 },
    };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('accepts quietHours: null (no quiet hours configured)', () => {
    const payload = { notificationBudgetPerWindow: 10, quietHours: null };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('accepts notificationBudgetPerWindow: 0 (a valid "silence everything" budget)', () => {
    const payload = { notificationBudgetPerWindow: 0, quietHours: null };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a negative notificationBudgetPerWindow', () => {
    const payload = { notificationBudgetPerWindow: -1, quietHours: null };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a non-integer notificationBudgetPerWindow', () => {
    const payload = { notificationBudgetPerWindow: 1.5, quietHours: null };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects notificationBudgetPerWindow over the 10000 pinned upper bound', () => {
    const payload = { notificationBudgetPerWindow: 10_001, quietHours: null };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('accepts notificationBudgetPerWindow at exactly the 10000 upper boundary', () => {
    const payload = { notificationBudgetPerWindow: 10_000, quietHours: null };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a missing notificationBudgetPerWindow', () => {
    expect(
      agentNotificationPreferenceSetPayloadSchema.safeParse({ quietHours: null }).success,
    ).toBe(false);
  });

  it('rejects a missing quietHours key entirely (must be explicit null or an object)', () => {
    expect(
      agentNotificationPreferenceSetPayloadSchema.safeParse({ notificationBudgetPerWindow: 10 })
        .success,
    ).toBe(false);
  });

  it('rejects a malformed nested quietHours (out-of-range hour)', () => {
    const payload = {
      notificationBudgetPerWindow: 10,
      quietHours: { startHourUtc: 22, endHourUtc: 24 },
    };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const payload = {
      notificationBudgetPerWindow: 10,
      quietHours: null,
      extra: 'field',
    };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a payload carrying workspaceId/userId/actor/occurredAt -- those belong to the DomainEvent envelope (userId is always actor.id, self-only per ADR-0047 Karar i), never the payload', () => {
    const payload = {
      notificationBudgetPerWindow: 10,
      quietHours: null,
      workspaceId: 'ws-1',
      userId: 'user-1',
      actor: { type: 'user', id: 'user-1' },
      occurredAt: '2026-09-13T00:00:00.000Z',
    };
    expect(agentNotificationPreferenceSetPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
