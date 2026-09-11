import {
  EmptyState,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@luminaos/ui';

import {
  useAutonomyTierSettingsQuery,
  useSetAutonomyTierMutation,
} from '../../hooks/useAutonomyTierSettingsQuery.js';

import type { AutonomyTier, TaskAutonomySetting } from '../../lib/apiClient.js';

/**
 * F3-T5 PR3 (ADR-0039 frontend, spec Kabul Kriterleri) -- "Otonomi kadranı"
 * settings panel. Combines `TriggerSuggestionsPanel.tsx`'s top-level
 * loading/error state convention with `McpAccessPanel.tsx`'s real
 * `SelectRoot`/`SelectTrigger`/`SelectContent`/`SelectItem` per-row dropdown
 * pattern from `@luminaos/ui`. Renders exactly 6 rows -- one per known action
 * type -- regardless of what the query's `settings` array contains.
 */
export interface AutonomyTierPanelProps {
  workspaceId: string;
}

const KNOWN_ACTION_TYPES: { actionType: string; label: string }[] = [
  { actionType: 'createTask', label: 'Görev oluştur' },
  { actionType: 'generateSubtasks', label: 'Alt görevler oluştur' },
  { actionType: 'assignPeople', label: 'Kişi ata' },
  { actionType: 'createTaskFromMeeting', label: 'Toplantıdan görev oluştur' },
  { actionType: 'createTaskFromTrigger', label: 'Tetikleyiciden görev oluştur' },
  { actionType: 'reconfigureAgentPermissions', label: 'Ajan izinlerini yeniden yapılandır' },
];

// Mirrors packages/agent-runtime/src/autonomy-tier.ts's AUTONOMY_GOVERNANCE_FLOOR
// (ADR-0039 Karar c) -- server-enforced; disabling here is UX only, not a
// security boundary (the PUT would 403 regardless).
const GOVERNANCE_FLOOR_ACTION_TYPES: readonly string[] = ['reconfigureAgentPermissions'];

const TIER_OPTIONS: { tier: AutonomyTier; label: string }[] = [
  { tier: 'propose', label: 'Öner' },
  { tier: 'approve_and_act', label: 'Onayla-yap' },
  { tier: 'act_and_notify', label: 'Yap-bildir' },
];

function AutonomyTierRow({
  actionType,
  label,
  currentTier,
  onChange,
}: {
  actionType: string;
  label: string;
  currentTier: AutonomyTier;
  onChange: (actionType: string, tier: AutonomyTier) => void;
}) {
  const disabled = GOVERNANCE_FLOOR_ACTION_TYPES.includes(actionType);

  return (
    <li data-testid={`autonomy-tier-item-${actionType}`}>
      <span>{label}</span>
      <SelectRoot
        value={currentTier}
        disabled={disabled}
        onValueChange={(next) => {
          onChange(actionType, next as AutonomyTier);
        }}
      >
        <SelectTrigger data-testid={`autonomy-tier-select-${actionType}`} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TIER_OPTIONS.map((option) => (
            <SelectItem
              key={option.tier}
              value={option.tier}
              data-testid={`autonomy-tier-option-${actionType}-${option.tier}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
    </li>
  );
}

export function AutonomyTierPanel({ workspaceId }: AutonomyTierPanelProps) {
  const { data, isLoading, isError } = useAutonomyTierSettingsQuery(workspaceId);
  const setMutation = useSetAutonomyTierMutation(workspaceId);

  function handleChange(actionType: string, tier: AutonomyTier): void {
    setMutation.mutate({ actionType, tier });
  }

  if (isLoading) {
    return (
      <div data-testid="autonomy-tier-settings-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="autonomy-tier-settings-error"
        title="Bir hata oluştu"
        description="Otonomi kadranı ayarları yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const settings: TaskAutonomySetting[] = data?.settings ?? [];

  return (
    <>
      {setMutation.isError ? (
        <EmptyState
          data-testid="autonomy-tier-set-error"
          title="Otonomi kademesi güncellenemedi"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      <ul aria-label="Otonomi kadranı">
        {KNOWN_ACTION_TYPES.map(({ actionType, label }) => {
          const currentTier =
            settings.find((setting) => setting.actionType === actionType)?.tier ?? 'propose';
          return (
            <AutonomyTierRow
              key={actionType}
              actionType={actionType}
              label={label}
              currentTier={currentTier}
              onChange={handleChange}
            />
          );
        })}
      </ul>
    </>
  );
}
