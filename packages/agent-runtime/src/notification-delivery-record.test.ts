import { describe, expect, it } from 'vitest';

import type {
  NotificationDeliveryOutcome,
  NotificationDeliveryRecord,
} from './notification-delivery-record.js';

/**
 * F3-T13 PR1 (RED step), ADR-0047 Karar (d)/"Somut Şekiller" — `packages/
 * agent-runtime/src/notification-delivery-record.ts`. Mirrors `autonomy-
 * tier.test.ts`'s house style: `NotificationDeliveryRecord` itself is a
 * plain interface with zero runtime behavior (ADR-0047 §d) -- nothing to
 * unit-test about its shape beyond a compile-time-locked exhaustiveness
 * canary over the 3-member `NotificationDeliveryOutcome` union (same
 * `never`-typed default-branch pattern as `autonomy-tier.test.ts`'s
 * `describeTier` / `agent-action-record.test.ts`'s `describeResourceKind`).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/notification-delivery-record.ts`.
 *
 * NOTE on red-state mechanics: since this file only imports TYPES (`import
 * type { ... }`), vitest's esbuild transform strips the import entirely and
 * this file WILL run under `vitest run` even with the module missing on
 * disk today, reporting a false-green until `implementer` lands the real
 * module — the actual red gate for this file is `pnpm --filter
 * @luminaos/agent-runtime typecheck`, which fails on the unresolved
 * `./notification-delivery-record.js` specifier. Same caveat as
 * `agent-action-record.test.ts`'s `undoesRecordId` section.
 */

function buildDeliveryRecord(
  overrides: Partial<NotificationDeliveryRecord> = {},
): NotificationDeliveryRecord {
  return {
    id: 'delivery-1',
    workspaceId: 'workspace-1',
    recipientUserId: 'user-1',
    actionType: 'createTask',
    sourceObjectId: 'obj-1',
    outcome: 'delivered',
    commentId: 'comment-1',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('NotificationDeliveryRecord -- shape (F3-T13 PR1, ADR-0047 Karar d)', () => {
  it('a "delivered" record carries a non-null commentId', () => {
    const record = buildDeliveryRecord({ outcome: 'delivered', commentId: 'comment-42' });

    expect(record.outcome).toBe('delivered');
    expect(record.commentId).toBe('comment-42');
  });

  it('a "suppressed_quiet_hours" record has a null commentId', () => {
    const record = buildDeliveryRecord({ outcome: 'suppressed_quiet_hours', commentId: null });

    expect(record.outcome).toBe('suppressed_quiet_hours');
    expect(record.commentId).toBeNull();
  });

  it('a "suppressed_budget_exceeded" record has a null commentId', () => {
    const record = buildDeliveryRecord({ outcome: 'suppressed_budget_exceeded', commentId: null });

    expect(record.outcome).toBe('suppressed_budget_exceeded');
    expect(record.commentId).toBeNull();
  });

  it('carries workspaceId/recipientUserId/actionType/sourceObjectId as plain strings', () => {
    const record = buildDeliveryRecord();

    expect(record.workspaceId).toBe('workspace-1');
    expect(record.recipientUserId).toBe('user-1');
    expect(record.actionType).toBe('createTask');
    expect(record.sourceObjectId).toBe('obj-1');
  });
});

/**
 * Compile-time exhaustiveness check + a runtime canary that all 3
 * `NotificationDeliveryOutcome` members are individually narrowable. If a
 * future outcome is added without updating this switch, the `default`
 * branch's `const exhaustiveCheck: never = outcome` line fails to typecheck
 * -- this file (and `pnpm typecheck`) breaks loudly instead of silently
 * missing a case.
 */
function describeOutcome(outcome: NotificationDeliveryOutcome): string {
  switch (outcome) {
    case 'delivered':
      return 'delivered';
    case 'suppressed_quiet_hours':
      return 'suppressed_quiet_hours';
    case 'suppressed_budget_exceeded':
      return 'suppressed_budget_exceeded';
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled NotificationDeliveryOutcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

describe('NotificationDeliveryOutcome -- discriminated narrowing (exhaustiveness canary)', () => {
  it.each([
    ['delivered', 'delivered'],
    ['suppressed_quiet_hours', 'suppressed_quiet_hours'],
    ['suppressed_budget_exceeded', 'suppressed_budget_exceeded'],
  ] as const)('narrows %s correctly (%#)', (outcome, expected) => {
    expect(describeOutcome(outcome)).toBe(expected);
  });
});
