import { describe, expect, it } from 'vitest';

import {
  agentPermissionGrantedPayloadSchema,
  agentPermissionRevokedPayloadSchema,
} from './agent-permission-manifest-events.js';

/**
 * Smoke tests for the `AgentPermissionGranted`/`AgentPermissionRevoked`
 * payload schemas (ADR-0035 Karar (b)/(j)). This PR (F3-T1 PR1) declares
 * these schemas as part of its scope but has no real event-writing
 * consumer yet (PR2 introduces one) — these tests exist to lock in the
 * `.strict()` mass-assignment protection and the ISO-8601 date convention
 * ahead of that consumer, mirroring `memory-access-policy-events.test.ts`.
 */

describe('agentPermissionGrantedPayloadSchema', () => {
  it('accepts a well-formed payload with an unbounded time window', () => {
    const payload = {
      agentIdentifier: 'answer-question',
      dataScope: { objectTypes: 'all' as const },
      actionTypes: ['send-email'],
      timeWindow: { startsAt: null, expiresAt: null },
    };

    expect(agentPermissionGrantedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('accepts a well-formed payload with a bounded, ISO-8601 time window', () => {
    const payload = {
      agentIdentifier: 'answer-question',
      dataScope: { objectTypes: ['task', 'note'] },
      actionTypes: ['send-email', 'read-calendar'],
      timeWindow: {
        startsAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
      },
    };

    expect(agentPermissionGrantedPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = agentPermissionGrantedPayloadSchema.safeParse({
      agentIdentifier: 'answer-question',
      dataScope: { objectTypes: 'all' },
      actionTypes: ['send-email'],
      timeWindow: { startsAt: null, expiresAt: null },
      extra: 'field',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty actionTypes array', () => {
    const result = agentPermissionGrantedPayloadSchema.safeParse({
      agentIdentifier: 'answer-question',
      dataScope: { objectTypes: 'all' },
      actionTypes: [],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO-8601 date string in timeWindow', () => {
    const result = agentPermissionGrantedPayloadSchema.safeParse({
      agentIdentifier: 'answer-question',
      dataScope: { objectTypes: 'all' },
      actionTypes: ['send-email'],
      timeWindow: { startsAt: 'not-a-date', expiresAt: null },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a missing agentIdentifier', () => {
    expect(
      agentPermissionGrantedPayloadSchema.safeParse({
        dataScope: { objectTypes: 'all' },
        actionTypes: ['send-email'],
        timeWindow: { startsAt: null, expiresAt: null },
      }).success,
    ).toBe(false);
  });
});

describe('agentPermissionRevokedPayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(
      agentPermissionRevokedPayloadSchema.safeParse({ agentIdentifier: 'answer-question' }).success,
    ).toBe(true);
  });

  it('rejects a payload with an unknown extra key (.strict())', () => {
    const result = agentPermissionRevokedPayloadSchema.safeParse({
      agentIdentifier: 'answer-question',
      reason: 'no longer needed',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty-string agentIdentifier', () => {
    expect(agentPermissionRevokedPayloadSchema.safeParse({ agentIdentifier: '' }).success).toBe(
      false,
    );
  });
});
