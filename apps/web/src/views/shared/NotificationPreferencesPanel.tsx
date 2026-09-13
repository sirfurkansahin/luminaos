import { useState } from 'react';

import { Button, Checkbox, EmptyState, Input, Skeleton } from '@luminaos/ui';

import {
  useNotificationPreferenceQuery,
  useSetNotificationPreferenceMutation,
} from '../../hooks/useNotificationPreferenceQuery.js';

/**
 * F3-T13 PR3 (bildirim bütçesi/sessiz saatler, ADR-0047 Karar b/g) -- "kişisel
 * bildirim tercihi" settings panel. Mirrors `AutonomyTierPanel.tsx`'s
 * top-level loading/error state convention (data-testid=
 * "notification-preferences-loading"/"-error") but, unlike its "commit on
 * every change" pattern, uses `BaselineCreationForm.tsx`'s "local controlled
 * `useState` per field + explicit Save button" shape -- the budget number
 * AND the two-part quiet-hours window are logically ONE settings-record
 * write, so committing on every keystroke would fire spurious partial-value
 * mutations.
 */
export interface NotificationPreferencesPanelProps {
  workspaceId: string;
  userId: string;
}

export function NotificationPreferencesPanel({
  workspaceId,
  userId,
}: NotificationPreferencesPanelProps) {
  const { data, isLoading, isError } = useNotificationPreferenceQuery(workspaceId, userId);
  const setMutation = useSetNotificationPreferenceMutation(workspaceId, userId);

  const preference = data?.preference ?? null;

  const [budgetDraft, setBudgetDraft] = useState(
    String(preference?.notificationBudgetPerWindow ?? 0),
  );
  const [quietHoursChecked, setQuietHoursChecked] = useState(
    preference?.quietHours !== null && preference?.quietHours !== undefined,
  );
  const [startHourDraft, setStartHourDraft] = useState(
    String(preference?.quietHours?.startHourUtc ?? 0),
  );
  const [endHourDraft, setEndHourDraft] = useState(String(preference?.quietHours?.endHourUtc ?? 0));

  if (isLoading) {
    return (
      <div data-testid="notification-preferences-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="notification-preferences-error"
        title="Bir hata oluştu"
        description="Bildirim tercihleri yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  function handleSave(): void {
    setMutation.mutate({
      notificationBudgetPerWindow: Number(budgetDraft) || 0,
      quietHours: quietHoursChecked
        ? {
            startHourUtc: Number(startHourDraft) || 0,
            endHourUtc: Number(endHourDraft) || 0,
          }
        : null,
    });
  }

  return (
    <div>
      {setMutation.isError ? (
        <EmptyState
          data-testid="notification-preferences-set-error"
          title="Bildirim tercihleri güncellenemedi"
          description="Kısa bir süre sonra tekrar deneyin."
        />
      ) : null}

      <Input
        type="number"
        data-testid="notification-preferences-budget-input"
        aria-label="Bildirim bütçesi"
        value={budgetDraft}
        onChange={(event) => {
          setBudgetDraft(event.target.value);
        }}
      />

      <Checkbox
        data-testid="notification-preferences-quiet-hours-checkbox"
        aria-label="Sessiz saatler"
        checked={quietHoursChecked}
        onCheckedChange={(next) => {
          setQuietHoursChecked(next === true);
        }}
      />

      <Input
        type="number"
        data-testid="notification-preferences-quiet-hours-start-input"
        aria-label="Sessiz saat başlangıcı"
        value={startHourDraft}
        disabled={!quietHoursChecked}
        onChange={(event) => {
          setStartHourDraft(event.target.value);
        }}
      />

      <Input
        type="number"
        data-testid="notification-preferences-quiet-hours-end-input"
        aria-label="Sessiz saat bitişi"
        value={endHourDraft}
        disabled={!quietHoursChecked}
        onChange={(event) => {
          setEndHourDraft(event.target.value);
        }}
      />

      <Button type="button" data-testid="notification-preferences-save-button" onClick={handleSave}>
        Kaydet
      </Button>
    </div>
  );
}
