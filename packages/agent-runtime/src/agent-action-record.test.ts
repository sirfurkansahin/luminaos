import { describe, expect, it } from 'vitest';

import {
  agentResource,
  commentResource,
  externalResource,
  meetingResource,
  objectResource,
} from './agent-action-record.js';

import type { ActionResourceReference, AgentActionRecord } from './agent-action-record.js';

/**
 * F3-T4 PR1 (RED step) — `packages/agent-runtime/src/agent-action-record.ts`,
 * per ADR-0038 Karar (a)/(b) and the spec's Kabul Kriterleri (PR1). This file
 * is scoped to the PIECE of that module that has actual runtime behavior:
 * the small pure factory helpers ADR-0038 Karar (a) calls out by name —
 * `objectResource(objectId)`, `commentResource(commentId)`, `meetingResource
 * (meetingId)`, `agentResource(agentIdentifier)`, `externalResource(label)`
 * — one per `ActionResourceReference` discriminated-union variant:
 *
 *   export type ActionResourceReference =
 *     | { kind: 'object'; objectId: string }
 *     | { kind: 'comment'; commentId: string }
 *     | { kind: 'meeting'; meetingId: string }
 *     | { kind: 'agent'; agentIdentifier: string }
 *     | { kind: 'external'; label: string };
 *
 *   export function objectResource(objectId: string): ActionResourceReference;
 *   export function commentResource(commentId: string): ActionResourceReference;
 *   export function meetingResource(meetingId: string): ActionResourceReference;
 *   export function agentResource(agentIdentifier: string): ActionResourceReference;
 *   export function externalResource(label: string): ActionResourceReference;
 *
 * `AgentActionRecord`/`RollbackPlan`/`ActionProvenance`/`AgentActionOutcome`
 * themselves are plain type/interface declarations with zero runtime
 * behavior (ADR-0038 §b) — there is nothing to unit-test about them at
 * runtime; their shape is instead locked in at COMPILE time below via a
 * switch-based exhaustiveness check over `ActionResourceReference['kind']`
 * (mirrors this codebase's `apps/server/src/commands/commands.service.ts`
 * `executeDecidedAction` exhaustive-switch-over-`action.type` style, made
 * explicit here with a `never`-typed default branch since vitest/tsc will
 * refuse to compile this file at all if a variant is ever added to the
 * union without a corresponding `case` below).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/agent-action-record.ts`.
 */

describe('objectResource', () => {
  it('returns a discriminated-union member with kind "object"', () => {
    expect(objectResource('obj-1')).toEqual({ kind: 'object', objectId: 'obj-1' });
  });
});

describe('commentResource', () => {
  it('returns a discriminated-union member with kind "comment"', () => {
    expect(commentResource('comment-1')).toEqual({ kind: 'comment', commentId: 'comment-1' });
  });
});

describe('meetingResource', () => {
  it('returns a discriminated-union member with kind "meeting"', () => {
    expect(meetingResource('meeting-1')).toEqual({ kind: 'meeting', meetingId: 'meeting-1' });
  });
});

describe('agentResource', () => {
  it('returns a discriminated-union member with kind "agent"', () => {
    expect(agentResource('answer-question')).toEqual({
      kind: 'agent',
      agentIdentifier: 'answer-question',
    });
  });
});

describe('externalResource', () => {
  it('returns a discriminated-union member with kind "external"', () => {
    expect(externalResource('Slack #general')).toEqual({
      kind: 'external',
      label: 'Slack #general',
    });
  });
});

/**
 * Compile-time exhaustiveness check + a runtime canary that each factory
 * really does produce a member the switch below recognizes. If a future
 * `ActionResourceReference` variant is added without updating this switch,
 * the `default` branch's `const exhaustiveCheck: never = resource` line
 * fails to typecheck — this file (and `pnpm typecheck`) breaks loudly
 * instead of silently missing a case.
 */
function describeResourceKind(resource: ActionResourceReference): string {
  switch (resource.kind) {
    case 'object':
      return `object:${resource.objectId}`;
    case 'comment':
      return `comment:${resource.commentId}`;
    case 'meeting':
      return `meeting:${resource.meetingId}`;
    case 'agent':
      return `agent:${resource.agentIdentifier}`;
    case 'external':
      return `external:${resource.label}`;
    default: {
      const exhaustiveCheck: never = resource;
      throw new Error(`Unhandled ActionResourceReference kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * F3-T6 PR1 (RED step), ADR-0040 Karar (c)/"Somut Şekiller" — pins the new,
 * REQUIRED `undoesRecordId: string | null` field on `AgentActionRecord`
 * (null on every normal record; the ORIGINAL record's own `id` on a future
 * undo-shaped record, PR2's `CommandsService.undoAction`).
 *
 * Like the exhaustiveness canary below, `AgentActionRecord` itself is a
 * plain interface with zero runtime behavior — there is nothing a `vitest
 * run` alone can fail on for a pure type addition (vitest's default esbuild
 * transform strips types without checking them). The REAL red gate for this
 * addition is `pnpm --filter @luminaos/agent-runtime typecheck`, which today
 * fails on the object literal below with "Object literal may only specify
 * known properties, and 'undoesRecordId' does not exist in type
 * 'AgentActionRecord'" (TS's excess-property check on a literal assigned
 * directly to an interface-typed return position). The runtime assertions
 * exist so this file is still meaningful under `vitest run` once the field
 * exists, mirroring `describeResourceKind`'s own compile-time/runtime split.
 */
function buildFullAgentActionRecord(overrides: Partial<AgentActionRecord> = {}): AgentActionRecord {
  return {
    id: 'record-1',
    workspaceId: 'workspace-1',
    provenance: 'decided',
    actor: { type: 'user', id: 'user-1' },
    actionType: 'createTask',
    intent: 'Bir görev oluştur',
    rationale: 'Kullanıcı toplantıdan bir aksiyon öğesi istedi.',
    resources: [objectResource('obj-1')],
    rollbackPlan: { kind: 'delete', description: 'Oluşturulan görevi sil.' },
    outcome: 'succeeded',
    resultRef: null,
    causationEventId: null,
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    // NEW (F3-T6) -- this key does not typecheck against today's
    // `AgentActionRecord` interface (RED via `pnpm typecheck`).
    undoesRecordId: null,
    ...overrides,
  };
}

describe('AgentActionRecord — undoesRecordId (F3-T6, ADR-0040 Karar c)', () => {
  it('is null on a normal (non-undo) record -- every existing caller today', () => {
    expect(buildFullAgentActionRecord().undoesRecordId).toBeNull();
  });

  it("holds the ORIGINAL record's own id on an undo-shaped record", () => {
    const record = buildFullAgentActionRecord({ undoesRecordId: 'original-record-id-01' });

    expect(record.undoesRecordId).toBe('original-record-id-01');
  });
});

describe('ActionResourceReference — discriminated-union narrowing (exhaustiveness canary)', () => {
  it.each([
    [() => objectResource('obj-1'), 'object:obj-1'],
    [() => commentResource('comment-1'), 'comment:comment-1'],
    [() => meetingResource('meeting-1'), 'meeting:meeting-1'],
    [() => agentResource('answer-question'), 'agent:answer-question'],
    [() => externalResource('Slack #general'), 'external:Slack #general'],
  ] as const)(
    'narrows every factory-produced variant correctly (%#)',
    (buildResource, expected) => {
      expect(describeResourceKind(buildResource())).toBe(expected);
    },
  );
});
