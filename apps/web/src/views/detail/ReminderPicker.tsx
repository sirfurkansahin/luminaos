import { useQueryClient } from '@tanstack/react-query';

import { Checkbox, DateTimePicker } from '@luminaos/ui';

import { useSetFieldValuesMutation } from '../../hooks/useObjectsQuery.js';

export interface ReminderPickerProps {
  workspaceId: string;
  objectId: string;
  remindAt: unknown;
  remindAcknowledged: unknown;
}

export function ReminderPicker({
  workspaceId,
  objectId,
  remindAt,
  remindAcknowledged,
}: ReminderPickerProps) {
  const queryClient = useQueryClient();
  const { mutate } = useSetFieldValuesMutation(workspaceId);

  const remindAtValue = typeof remindAt === 'string' ? remindAt : '';
  const remindAcknowledgedValue =
    typeof remindAcknowledged === 'boolean' ? remindAcknowledged : false;

  function commit(values: Record<string, unknown>): void {
    mutate(
      { objectId, values },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['object', workspaceId, objectId] });
        },
      },
    );
  }

  return (
    <div>
      <DateTimePicker
        mode="datetime-local"
        data-testid="reminder-remind-at-input"
        aria-label="Hatırlatma zamanı"
        value={remindAtValue}
        onChange={(event) => {
          commit({ remindAt: event.target.value });
        }}
      />
      <Checkbox
        data-testid="reminder-remind-acknowledged-checkbox"
        aria-label="Hatırlatma onaylandı"
        checked={remindAcknowledgedValue}
        onCheckedChange={(checked) => {
          commit({ remindAcknowledged: checked === true });
        }}
      />
    </div>
  );
}
