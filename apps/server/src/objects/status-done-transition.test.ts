import { describe, expect, it } from 'vitest';

import type { FieldDefinition, FieldPermissions } from '@luminaos/core-objects';

import { detectStatusDoneTransition } from './status-done-transition.js';

/**
 * F1-T10 PR4 (RED step) — the pure `status`/`isDone` false->true
 * transition-DETECTION logic ADR-0010 §"(f) Tetikleyici tespiti" pins:
 *
 *   "Tetikleme, `status` alanının ÖNCEKİ seçilen seçeneğinin `isDone`
 *   bayrağı ile YENİ seçimin `isDone` bayrağı karşılaştırılarak yapılır —
 *   yalnızca gerçek bir false->true geçişinde ateşlenir. Zaten tamamlanmış
 *   bir göreve yapılan sonraki düzenlemeler (ör. `priority` değişikliği, ya
 *   da `status`'un "Bitti"den "Bitti" olmayan bir başka `isDone:true`
 *   seçeneğine ... geçişi DIŞINDA bir true->true durumu) tetiklemeyi
 *   tekrarlamaz."
 *
 * `./status-done-transition.ts` does NOT exist yet — the import above is
 * expected to fail module resolution ("Cannot find module") the instant this
 * file loads, before any `describe`/`it` block runs. That is the correct red
 * state; `implementer` must create `./status-done-transition.ts` matching
 * the contract pinned below to turn this green.
 *
 * ============================================================================
 * SCOPE BOUNDARY: this file tests the comparison logic IN ISOLATION, as a
 * pure function taking already-resolved inputs (a field key, the ACTIVE
 * field-definition set for the object's type, and the previous/new value) —
 * it does NOT drive this through `ObjectsService.setFieldValues`'s real
 * `priorEvents`/`workingFieldValues` machinery (that wiring, and the actual
 * call into `TaskRecurrenceService`, is
 * `./object-recurrence-trigger.integration.test.ts`'s job, a separate file
 * in this same PR). Extracted as a pure function specifically so this
 * false->true nuance can be pinned exhaustively without the cost of a real
 * Postgres-backed integration test per case.
 *
 * ============================================================================
 * CONTRACT PINNED HERE (implementer must match exactly —
 * `./status-done-transition.ts` does not exist yet):
 *
 *   export function detectStatusDoneTransition(input: {
 *     fieldKey: string;
 *     definitions: FieldDefinition[]; // the object type's ACTIVE field definitions
 *     previousValue: unknown;         // this object's `status` value BEFORE this write
 *     newValue: unknown;              // the value THIS write is setting fieldKey to
 *   }): boolean;
 *
 * - Only ever returns `true` for `input.fieldKey === 'status'` — any other
 *   fieldKey (e.g. `'priority'`) returns `false` immediately, regardless of
 *   `previousValue`/`newValue`, per ADR-0010 §(f)'s explicit "status alanı"
 *   framing (the `isDone` flag is only ever consulted on the `status` field,
 *   never any other `select` field that might happen to carry an `isDone:
 *   true` option).
 * - Looks up the ACTIVE `select`-typed field definition with `key ===
 *   'status'` in `definitions`; if none exists (unseeded workspace, or the
 *   field was archived), returns `false` (defensive — cannot resolve
 *   `isDone` semantics without the option list).
 * - Resolves `previousValue`/`newValue` against that definition's
 *   `config.options` (each `{ value, label, isDone? }`, per
 *   `@luminaos/core-objects`'s `optionSchema`): a value that matches no
 *   known option's `value` (including `undefined`, e.g. a brand-new object
 *   that never had `status` set before) is treated as `isDone: false`
 *   (absence of completion, not an error).
 * - Returns `true` if and only if the PREVIOUS resolved `isDone` is `false`
 *   (or absent/unmatched) AND the NEW resolved `isDone` is exactly `true` —
 *   a genuine false->true transition.
 * - Returns `false` for true->true (same option re-submitted, OR a
 *   hypothetical switch between two DIFFERENT `isDone: true` options), for
 *   true->false (un-completing), and for false->false (any edit that never
 *   touches an `isDone: true` option).
 * ============================================================================
 */

const TASK_STATUS_PERMISSIONS: FieldPermissions = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'view',
};

function buildStatusDefinition(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: 'field-def-status',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    objectType: 'task',
    key: 'status',
    label: 'Status',
    fieldType: 'select',
    config: {
      options: [
        { value: 'todo', label: 'Yapılacak' },
        { value: 'doing', label: 'Sürüyor' },
        { value: 'done', label: 'Bitti', isDone: true },
      ],
    },
    permissions: TASK_STATUS_PERMISSIONS,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildPriorityDefinition(): FieldDefinition {
  return {
    id: 'field-def-priority',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    objectType: 'task',
    key: 'priority',
    label: 'Priority',
    fieldType: 'select',
    config: {
      options: [
        { value: 'low', label: 'Düşük' },
        { value: 'medium', label: 'Orta' },
        { value: 'high', label: 'Yüksek' },
        { value: 'urgent', label: 'Acil' },
      ],
    },
    permissions: TASK_STATUS_PERMISSIONS,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('detectStatusDoneTransition', () => {
  it('returns true for a genuine todo -> done transition', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition()],
      previousValue: 'todo',
      newValue: 'done',
    });

    expect(result).toBe(true);
  });

  it('returns true for a genuine doing -> done transition', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition()],
      previousValue: 'doing',
      newValue: 'done',
    });

    expect(result).toBe(true);
  });

  it('returns true when the previous value is undefined (never set) and the new value is done', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition()],
      previousValue: undefined,
      newValue: 'done',
    });

    expect(result).toBe(true);
  });

  it('returns false for a re-submission of the SAME isDone:true option (true -> true, no-op edit)', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition()],
      previousValue: 'done',
      newValue: 'done',
    });

    expect(result).toBe(false);
  });

  it('returns false when switching between two DIFFERENT isDone:true options (true -> true)', () => {
    const definitionWithTwoDoneOptions = buildStatusDefinition({
      config: {
        options: [
          { value: 'todo', label: 'Yapılacak' },
          { value: 'done', label: 'Bitti', isDone: true },
          { value: 'archived-done', label: 'Arşivlenmiş Bitti', isDone: true },
        ],
      },
    });

    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [definitionWithTwoDoneOptions],
      previousValue: 'done',
      newValue: 'archived-done',
    });

    expect(result).toBe(false);
  });

  it('returns false for an un-completing done -> todo transition (true -> false)', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition()],
      previousValue: 'done',
      newValue: 'todo',
    });

    expect(result).toBe(false);
  });

  it('returns false for a todo -> doing transition (false -> false, never touches isDone)', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition()],
      previousValue: 'todo',
      newValue: 'doing',
    });

    expect(result).toBe(false);
  });

  it('returns false for ANY fieldKey other than "status", even if it happens to also be isDone-shaped', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'priority',
      definitions: [buildStatusDefinition(), buildPriorityDefinition()],
      previousValue: 'low',
      newValue: 'urgent',
    });

    expect(result).toBe(false);
  });

  it('returns false when no active "status" field definition exists at all', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildPriorityDefinition()],
      previousValue: 'todo',
      newValue: 'done',
    });

    expect(result).toBe(false);
  });

  it('returns false when the "status" field definition is archived (not active)', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition({ lifecycle: 'archived' })],
      previousValue: 'todo',
      newValue: 'done',
    });

    expect(result).toBe(false);
  });

  it('returns false when newValue does not match any known option (defensive)', () => {
    const result = detectStatusDoneTransition({
      fieldKey: 'status',
      definitions: [buildStatusDefinition()],
      previousValue: 'todo',
      newValue: 'not-a-real-option',
    });

    expect(result).toBe(false);
  });
});
