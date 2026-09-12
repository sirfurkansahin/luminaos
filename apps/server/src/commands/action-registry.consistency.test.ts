import { describe, expect, it } from 'vitest';

import { ACTION_REGISTRY } from '@luminaos/agent-runtime';

import { PROPOSED_ACTION_TYPES } from '../ai/parse-command.js';

/**
 * F3-T9 PR1 (RED step), ADR-0043 (`docs/adr/ADR-0043-komut-duzlemi-v2.md`)
 * Karar (b) and spec `docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md`'s PR1
 * Kabul Kriterleri -- a pure consistency guard between
 * `packages/agent-runtime/src/action-registry.ts`'s `ACTION_REGISTRY` and
 * `apps/server/src/ai/parse-command.ts`'s `proposedActionSchema` (the schema
 * `commands.service.ts`'s `dispatchExecute` switch is ultimately typed
 * against). This file deliberately never imports or exercises
 * `dispatchExecute` itself -- that switch is separately, already tested and
 * is NOT touched by this PR; this test is a proxy proving the registry
 * cannot silently drift out of sync with the schema that switch depends on.
 *
 * Expected to fail (red) until `implementer`:
 *  - adds `packages/agent-runtime/src/action-registry.ts` exporting
 *    `ACTION_REGISTRY`, AND
 *  - adds `export const PROPOSED_ACTION_TYPES =
 *    proposedActionSchema.element.shape.type.options;` to
 *    `apps/server/src/ai/parse-command.ts`.
 */

describe('ACTION_REGISTRY vs PROPOSED_ACTION_TYPES consistency', () => {
  it('the set of ACTION_REGISTRY.actionType values is exactly equal to the set of PROPOSED_ACTION_TYPES (no extra either direction)', () => {
    const registryTypes = new Set(ACTION_REGISTRY.map((entry) => entry.actionType));
    const schemaTypes = new Set(PROPOSED_ACTION_TYPES as readonly string[]);

    expect(registryTypes.size).toBe(schemaTypes.size);

    for (const type of registryTypes) {
      expect(schemaTypes.has(type)).toBe(true);
    }

    for (const type of schemaTypes) {
      expect(registryTypes.has(type)).toBe(true);
    }

    expect(registryTypes).toEqual(schemaTypes);
  });

  /**
   * Regression-proof per ADR-0043 Karar (b) and the spec's explicit Kabul
   * Kriterleri: this does NOT just assert the happy path above -- it proves
   * the SAME comparison technique used above would genuinely catch a
   * one-sided drift, by manually corrupting a copy of the registry's type
   * set (one entry removed) and asserting THAT altered set is correctly
   * detected as unequal to `PROPOSED_ACTION_TYPES`. If this test ever
   * passed "by accident" (e.g. because both sets were empty, or the
   * equality check were a no-op), this second assertion would fail and
   * expose it.
   */
  it('DRIFT SIMULATION: a registry set missing one known actionType is correctly detected as NOT equal to PROPOSED_ACTION_TYPES', () => {
    const registryTypes = new Set(ACTION_REGISTRY.map((entry) => entry.actionType));
    const schemaTypes = new Set(PROPOSED_ACTION_TYPES as readonly string[]);

    const [removedType, ...remainingTypes] = Array.from(registryTypes);
    expect(removedType).toBeDefined();

    const driftedTypes = new Set(remainingTypes);

    expect(driftedTypes.size).toBe(schemaTypes.size - 1);
    expect(driftedTypes).not.toEqual(schemaTypes);
  });

  /**
   * DRIFT SIMULATION (other direction): a registry set with one EXTRA,
   * made-up actionType is correctly detected as NOT equal to
   * `PROPOSED_ACTION_TYPES`, proving the comparison also catches the
   * registry claiming to support a type the schema does not allow.
   */
  it('DRIFT SIMULATION: a registry set with one extra, unknown actionType is correctly detected as NOT equal to PROPOSED_ACTION_TYPES', () => {
    const registryTypes = new Set(ACTION_REGISTRY.map((entry) => entry.actionType));
    const schemaTypes = new Set(PROPOSED_ACTION_TYPES as readonly string[]);

    const driftedTypes = new Set([...registryTypes, 'someMadeUpActionType']);

    expect(driftedTypes.size).toBe(schemaTypes.size + 1);
    expect(driftedTypes).not.toEqual(schemaTypes);
  });
});
