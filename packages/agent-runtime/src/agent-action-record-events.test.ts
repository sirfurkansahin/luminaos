import { describe, expect, it } from 'vitest';

import { agentActionRecordedPayloadSchema } from './agent-action-record-events.js';

/**
 * F3-T4 PR1 (RED step) — the `AgentActionRecorded` event payload schema,
 * per ADR-0038 Karar (a)/(b)/(c)/(d) and the spec's Kabul Kriterleri (PR1).
 * Mirrors `agent-permission-manifest-events.test.ts`'s exact table-driven
 * valid/invalid-payload structure (ADR-0035 §(j)'s ISO-8601-string-in-jsonb
 * convention, `.strict()` mass-assignment protection).
 *
 * `id`/`workspaceId`/`actor`/`occurredAt` all come from the surrounding
 * `DomainEvent` envelope, not the payload — same convention as
 * `agentPermissionGrantedPayloadSchema`. The envelope's own `actor` IS
 * `AgentActionRecord.actor` (the real approving human for `'decided'`, the
 * agent itself for `'autonomous'` — exactly who/what caused this event to be
 * appended), and the envelope's own `occurredAt` IS the record's
 * `occurredAt` (the record is written synchronously right after the action
 * completes, so "event appended at" and "action occurred at" are the same
 * instant) — duplicating either into the payload would just be two values
 * that must always agree, with no mechanism enforcing that:
 *
 *   export const agentActionRecordedPayloadSchema = z.object({
 *     provenance: z.enum(['decided', 'autonomous']),
 *     actionType: z.string().min(1).max(100),
 *     intent: z.string().min(1),
 *     rationale: z.string().min(1),
 *     resources: z.array(actionResourceReferenceSchema),
 *     rollbackPlan: rollbackPlanSchema,
 *     outcome: z.enum(['succeeded','partially_succeeded','failed','rejected']),
 *     resultRef: actionResourceReferenceSchema.nullable(),
 *     causationEventId: z.uuid().nullable(),
 *   }).strict();
 *
 * where `actionResourceReferenceSchema` is a `z.discriminatedUnion('kind', […])`
 * over the same 5 variants as `ActionResourceReference`
 * (`object`/`comment`/`meeting`/`agent`/`external`), and `rollbackPlanSchema`
 * validates `{ kind, targetResource?, description }` per ADR-0038 §b.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/agent-action-record-events.ts` (and its
 * sibling `agent-action-record.ts`, which this schema's shape is derived
 * from).
 */

function buildValidDecidedPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provenance: 'decided',
    actionType: 'createTask',
    intent: 'Bir görev oluştur',
    rationale: 'Kullanıcı toplantıdan bir aksiyon öğesi istedi.',
    resources: [{ kind: 'object', objectId: 'obj-123' }],
    rollbackPlan: {
      kind: 'delete',
      targetResource: { kind: 'object', objectId: 'obj-123' },
      description: 'Oluşturulan görevi sil.',
    },
    outcome: 'succeeded',
    resultRef: { kind: 'object', objectId: 'obj-123' },
    causationEventId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function buildValidAutonomousPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provenance: 'autonomous',
    actionType: 'answer-question',
    intent: "Bir yorumdaki @mention'a yanıt verildi",
    rationale:
      "Ajan, kendi izin manifestosu kapsamında bu nesnedeki bir mention'a otomatik yanıt verdi (ikinci bir insan onayı adımı yok, ADR-0037 Karar d).",
    resources: [
      { kind: 'object', objectId: 'obj-456' },
      { kind: 'comment', commentId: 'comment-789' },
    ],
    rollbackPlan: {
      kind: 'delete',
      targetResource: { kind: 'comment', commentId: 'reply-1' },
      description: 'Ajanın yanıt yorumunu sil.',
    },
    outcome: 'succeeded',
    resultRef: { kind: 'comment', commentId: 'reply-1' },
    causationEventId: null,
    ...overrides,
  };
}

describe('agentActionRecordedPayloadSchema — valid payloads', () => {
  it('accepts a well-formed "decided" provenance payload', () => {
    expect(agentActionRecordedPayloadSchema.safeParse(buildValidDecidedPayload()).success).toBe(
      true,
    );
  });

  it('accepts a well-formed "autonomous" provenance payload', () => {
    expect(agentActionRecordedPayloadSchema.safeParse(buildValidAutonomousPayload()).success).toBe(
      true,
    );
  });
});

describe('agentActionRecordedPayloadSchema — provenance', () => {
  it('rejects an invalid provenance value', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({ provenance: 'manual' }),
    );

    expect(result.success).toBe(false);
  });
});

describe('agentActionRecordedPayloadSchema — outcome', () => {
  it('rejects an invalid outcome value', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({ outcome: 'timeout' }),
    );

    expect(result.success).toBe(false);
  });
});

describe('agentActionRecordedPayloadSchema — resources[] validation', () => {
  it('rejects a resources[] entry missing "kind"', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({ resources: [{ objectId: 'obj-123' }] }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects a resources[] entry with an unknown "kind" value', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({
        resources: [{ kind: 'workspace', workspaceId: 'ws-1' }],
      }),
    );

    expect(result.success).toBe(false);
  });
});

describe('agentActionRecordedPayloadSchema — rollbackPlan validation', () => {
  it('rejects a rollbackPlan with an unknown "kind" value', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({
        rollbackPlan: { kind: 'undo', description: 'Not a real RollbackPlan.kind value.' },
      }),
    );

    expect(result.success).toBe(false);
  });
});

describe('agentActionRecordedPayloadSchema — causationEventId', () => {
  it('accepts causationEventId: null (the autonomous-path shape, ADR-0038 §d)', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidAutonomousPayload({ causationEventId: null }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts a valid string causationEventId (the decided-path shape, ADR-0038 §c)', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({
        causationEventId: '22222222-2222-4222-8222-222222222222',
      }),
    );

    expect(result.success).toBe(true);
  });
});

describe('agentActionRecordedPayloadSchema — resultRef', () => {
  it('accepts resultRef: null (e.g. a rejected/failed outcome with no mutation)', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({
        outcome: 'rejected',
        resultRef: null,
        rollbackPlan: { kind: 'none', description: 'Hiçbir mutasyon oluşmadı.' },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts a valid ActionResourceReference object as resultRef', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({ resultRef: { kind: 'meeting', meetingId: 'meeting-1' } }),
    );

    expect(result.success).toBe(true);
  });
});

describe('agentActionRecordedPayloadSchema — .strict()', () => {
  it('rejects a payload with an unknown extra top-level field', () => {
    const result = agentActionRecordedPayloadSchema.safeParse(
      buildValidDecidedPayload({ extra: 'field' }),
    );

    expect(result.success).toBe(false);
  });
});
