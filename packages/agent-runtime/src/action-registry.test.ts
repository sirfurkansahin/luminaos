import { describe, expect, it } from 'vitest';

import { ACTION_REGISTRY, findActionRegistryEntry } from './action-registry.js';

import type { ActionModule, ActionRegistryEntry } from './action-registry.js';

/**
 * F3-T9 PR1 (RED step), ADR-0043 (`docs/adr/ADR-0043-komut-duzlemi-v2.md`)
 * Karar (a)/(b) and spec `docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md`'s PR1
 * Kabul Kriterleri -- `packages/agent-runtime/src/action-registry.ts`. Pins
 * the single source of truth for "which 6 action types exist, which module
 * owns each, and what Turkish label the frontend shows for each" -- mirrors
 * `autonomy-tier.test.ts`'s house style (plain `describe`/`it`, no mocking,
 * pure-TS module under test).
 *
 * The 6 `actionType` values and their Turkish `label`s are pulled
 * byte-for-byte from `apps/web/src/views/shared/AutonomyTierPanel.tsx`'s
 * `KNOWN_ACTION_TYPES` array (ADR-0043 Karar (a) requires these to stay
 * identical -- this registry is meant to become that array's single source
 * of truth in a later PR).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/action-registry.ts`.
 */

const EXPECTED_ENTRIES: readonly ActionRegistryEntry[] = [
  { actionType: 'createTask', module: 'task', label: 'Görev oluştur' },
  { actionType: 'generateSubtasks', module: 'task', label: 'Alt görevler oluştur' },
  { actionType: 'assignPeople', module: 'task', label: 'Kişi ata' },
  {
    actionType: 'createTaskFromMeeting',
    module: 'task',
    label: 'Toplantıdan görev oluştur',
  },
  {
    actionType: 'createTaskFromTrigger',
    module: 'task',
    label: 'Tetikleyiciden görev oluştur',
  },
  {
    actionType: 'reconfigureAgentPermissions',
    module: 'agentPermissions',
    label: 'Ajan izinlerini yeniden yapılandır',
  },
];

describe('ACTION_REGISTRY', () => {
  it('contains exactly 6 entries', () => {
    expect(ACTION_REGISTRY).toHaveLength(6);
  });

  it('has actionType values that are exactly the 6 known literals (set equality, no more no less)', () => {
    const actual = new Set(ACTION_REGISTRY.map((entry) => entry.actionType));
    const expected = new Set(EXPECTED_ENTRIES.map((entry) => entry.actionType));

    expect(actual.size).toBe(expected.size);
    expect(actual).toEqual(expected);
  });

  it.each(EXPECTED_ENTRIES.map((entry) => [entry.actionType, entry.module] as const))(
    'assigns actionType %s to module %s',
    (actionType, module) => {
      const entry = ACTION_REGISTRY.find((candidate) => candidate.actionType === actionType);
      expect(entry?.module).toBe(module);
    },
  );

  it.each(EXPECTED_ENTRIES.map((entry) => [entry.actionType, entry.label] as const))(
    "assigns actionType %s the exact Turkish label %s (mirrors AutonomyTierPanel.tsx's KNOWN_ACTION_TYPES)",
    (actionType, label) => {
      const entry = ACTION_REGISTRY.find((candidate) => candidate.actionType === actionType);
      expect(entry?.label).toBe(label);
    },
  );

  it('every entry has a non-empty label', () => {
    for (const entry of ACTION_REGISTRY) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('every entry\'s module is a valid ActionModule ("task" or "agentPermissions")', () => {
    const validModules: ActionModule[] = ['task', 'agentPermissions'];
    for (const entry of ACTION_REGISTRY) {
      expect(validModules).toContain(entry.module);
    }
  });
});

describe('findActionRegistryEntry', () => {
  it('returns the full, correct entry for a known actionType ("createTask")', () => {
    expect(findActionRegistryEntry('createTask')).toEqual({
      actionType: 'createTask',
      module: 'task',
      label: 'Görev oluştur',
    });
  });

  it('returns the full, correct entry for the sole agentPermissions-module actionType', () => {
    expect(findActionRegistryEntry('reconfigureAgentPermissions')).toEqual({
      actionType: 'reconfigureAgentPermissions',
      module: 'agentPermissions',
      label: 'Ajan izinlerini yeniden yapılandır',
    });
  });

  it('returns undefined for an actionType that does not exist in the registry', () => {
    expect(findActionRegistryEntry('nonexistentType')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(findActionRegistryEntry('')).toBeUndefined();
  });
});
