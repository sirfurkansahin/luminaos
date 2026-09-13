import { ACTION_REGISTRY, findActionRegistryEntry } from '@luminaos/agent-runtime';
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
import { useNotificationUsageSummaryQuery } from '../../hooks/useNotificationUsageSummaryQuery.js';

import type { AutonomyTier, TaskAutonomySetting } from '../../lib/apiClient.js';

/**
 * F3-T5 PR3 (ADR-0039 frontend, spec Kabul Kriterleri) -- "Otonomi kadranı"
 * settings panel. Combines `TriggerSuggestionsPanel.tsx`'s top-level
 * loading/error state convention with `McpAccessPanel.tsx`'s real
 * `SelectRoot`/`SelectTrigger`/`SelectContent`/`SelectItem` per-row dropdown
 * pattern from `@luminaos/ui`. Renders exactly 6 rows -- one per known action
 * type -- regardless of what the query's `settings` array contains.
 *
 * F3-T13 PR3 (ADR-0047 Karar g) additionally renders a passive "aşırı yük ->
 * yeniden dengeleme önerisi" banner (`data-testid="autonomy-rebalance-
 * suggestion"`) driven by `useNotificationUsageSummaryQuery(workspaceId,
 * userId)` -- `userId` is OPTIONAL (widening, not breaking, every pre-
 * existing caller) because a workspace this panel is rendered without a
 * known caller identity simply never shows the banner (fail-quiet, insan
 * kararı 1 -- this is a passive suggestion, never a blocking state).
 */
export interface AutonomyTierPanelProps {
  workspaceId: string;
  userId?: string;
}

// F3-T9 PR2 (ADR-0043 Karar f) -- derived from `@luminaos/agent-runtime`'s
// `ACTION_REGISTRY` (single source of truth, PLAN.md §5's "ikilik oluşmaz"
// principle) instead of a hand-maintained duplicate list. Rendered output
// stays byte-identical to the previous hardcoded array.
const KNOWN_ACTION_TYPES: { actionType: string; label: string }[] = ACTION_REGISTRY.map(
  ({ actionType, label }) => ({ actionType, label }),
);

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

export function AutonomyTierPanel({ workspaceId, userId }: AutonomyTierPanelProps) {
  const { data, isLoading, isError } = useAutonomyTierSettingsQuery(workspaceId);
  const setMutation = useSetAutonomyTierMutation(workspaceId);

  // F3-T13 PR3 (ADR-0047 Karar g) -- called unconditionally (rules of hooks),
  // ahead of the early loading/error returns below, even though its result
  // is only consulted after them. `userId ?? ''` is a harmless placeholder
  // for the (currently-untested-in-production) case where no caller identity
  // is known yet -- the derived `showRebalanceSuggestion` below always
  // resolves to `false` for a `?? ''` placeholder query result, so no banner
  // renders (fail-quiet, same as loading/erroring).
  const usageSummaryQuery = useNotificationUsageSummaryQuery(workspaceId, userId ?? '');

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

  // Fail-quiet (ADR-0047 Karar g/insan kararı 1): a loading/erroring/missing
  // usage summary, or `overloaded === false`, or a `null` `topActionType`,
  // is treated exactly like "no suggestion" -- never a panel-wide error
  // state, never blocking the 6 rows below. Optional-chained off
  // `usageSummaryQuery` itself (rather than assuming a `UseQueryResult`
  // shape) because every one of this file's OTHER, pre-existing tests mocks
  // `useNotificationUsageSummaryQuery` only at the module level without ever
  // configuring a return value for it (they don't exercise this banner at
  // all) -- the mock's default `vi.fn()` return is `undefined` there, which
  // the real `UseQueryResult` return type disallows; the next 4 lines are
  // therefore defensive against that test-only shape, not the production
  // one, hence the targeted `no-unnecessary-condition` disables below.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
  const summary = usageSummaryQuery?.data?.summary;
  const topActionType = summary?.topActionType ?? null;
  const showRebalanceSuggestion =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
    !usageSummaryQuery?.isLoading &&
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
    !usageSummaryQuery?.isError &&
    summary?.overloaded === true &&
    topActionType !== null;

  return (
    <>
      {setMutation.isError ? (
        <EmptyState
          data-testid="autonomy-tier-set-error"
          title="Otonomi kademesi güncellenemedi"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      {showRebalanceSuggestion ? (
        <div data-testid="autonomy-rebalance-suggestion">
          <p>
            Bildirim bütçeniz doldu. En çok bildirime yol açan aksiyon:{' '}
            {findActionRegistryEntry(topActionType.actionType)?.label ?? topActionType.actionType}.
            Bu aksiyonun otonomi kademesini gözden geçirmeyi düşünebilirsiniz.
          </p>
        </div>
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
