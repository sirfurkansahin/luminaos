import { describe, expect, it } from 'vitest';

import {
  agentNotificationDeliveredPayloadSchema,
  agentNotificationSuppressedPayloadSchema,
} from './notification-delivery-events.js';

/**
 * F3-T13 PR1 (RED step), ADR-0047 Karar (d) and the spec's PR1 Kabul
 * Kriterleri — `packages/agent-runtime/src/notification-delivery-events.ts`'s
 * `AgentNotificationDelivered`/`AgentNotificationSuppressed` payload schemas.
 * Mirrors `agent-action-record-events.test.ts`'s/`autonomy-tier-events.
 * test.ts`'s exact table-driven valid/invalid + `.strict()`-lock-in
 * convention: `workspaceId`/`actor`/`occurredAt` come from the surrounding
 * `DomainEvent` envelope, NOT the payload (same convention as every other
 * event schema in this package).
 *
 * `sourceObjectId`/`commentId` are pinned as `z.uuid()` (real object/comment
 * ids elsewhere in this codebase are uuids, e.g. `causationEventId` in
 * `agent-action-record-events.ts`); `recipientUserId`/`actionType` mirror
 * `taskAutonomyTierSetPayloadSchema`'s `actionType: z.string().min(1).max(100)`
 * bound exactly.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/notification-delivery-events.ts`.
 */

const VALID_UUID = '123e4567-e89b-42d3-a456-426614174000';
const VALID_UUID_2 = '223e4567-e89b-42d3-a456-426614174001';

describe('agentNotificationDeliveredPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      commentId: VALID_UUID_2,
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a missing recipientUserId', () => {
    const payload = {
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      commentId: VALID_UUID_2,
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects an empty-string recipientUserId', () => {
    const payload = {
      recipientUserId: '',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      commentId: VALID_UUID_2,
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a missing actionType', () => {
    const payload = {
      recipientUserId: 'user-1',
      sourceObjectId: VALID_UUID,
      commentId: VALID_UUID_2,
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects actionType over 100 chars', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'a'.repeat(101),
      sourceObjectId: VALID_UUID,
      commentId: VALID_UUID_2,
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a non-uuid sourceObjectId', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: 'not-a-uuid',
      commentId: VALID_UUID_2,
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a non-uuid commentId', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      commentId: 'not-a-uuid',
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a missing commentId -- a "delivered" outcome always has a real comment', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      commentId: VALID_UUID_2,
      extra: 'field',
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a payload carrying workspaceId/actor/occurredAt -- those belong to the DomainEvent envelope, never the payload', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      commentId: VALID_UUID_2,
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: 'agent-1' },
      occurredAt: '2026-09-13T00:00:00.000Z',
    };
    expect(agentNotificationDeliveredPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('agentNotificationSuppressedPayloadSchema', () => {
  it('accepts a well-formed payload with reason "quiet_hours"', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      reason: 'quiet_hours',
    };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('accepts a well-formed payload with reason "budget_exceeded"', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      reason: 'budget_exceeded',
    };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects an invalid reason value outside the 2-member enum (e.g. "delivered" is not a suppression reason)', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      reason: 'delivered',
    };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a missing reason', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
    };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a missing sourceObjectId', () => {
    const payload = { recipientUserId: 'user-1', actionType: 'createTask', reason: 'quiet_hours' };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('does NOT accept a commentId field at all -- a suppressed notification never has one (that field belongs only to the Delivered schema)', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      reason: 'quiet_hours',
      commentId: VALID_UUID_2,
    };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      reason: 'quiet_hours',
      extra: 'field',
    };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a payload carrying workspaceId/actor/occurredAt -- those belong to the DomainEvent envelope, never the payload', () => {
    const payload = {
      recipientUserId: 'user-1',
      actionType: 'createTask',
      sourceObjectId: VALID_UUID,
      reason: 'quiet_hours',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: 'agent-1' },
      occurredAt: '2026-09-13T00:00:00.000Z',
    };
    expect(agentNotificationSuppressedPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
