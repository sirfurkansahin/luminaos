/**
 * F3-T9 PR1, ADR-0043 (`docs/adr/ADR-0043-komut-duzlemi-v2.md`) Karar (a)/(b)
 * and spec `docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md` -- the single source
 * of truth for "which action types exist, which module owns each, and what
 * Turkish label the frontend shows for each".
 *
 * The 6 entries and their labels are pulled byte-for-byte from
 * `apps/web/src/views/shared/AutonomyTierPanel.tsx`'s `KNOWN_ACTION_TYPES`
 * array -- ADR-0043 Karar (a) requires these to stay identical. This
 * registry is meant to become that array's single source of truth in a
 * later PR.
 */
export type ActionModule = 'task' | 'agentPermissions';

export interface ActionRegistryEntry {
  actionType: string;
  module: ActionModule;
  label: string;
}

export const ACTION_REGISTRY: readonly ActionRegistryEntry[] = [
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

export function findActionRegistryEntry(actionType: string): ActionRegistryEntry | undefined {
  return ACTION_REGISTRY.find((entry) => entry.actionType === actionType);
}
