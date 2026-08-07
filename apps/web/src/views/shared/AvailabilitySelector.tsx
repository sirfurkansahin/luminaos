import { SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValue } from '@luminaos/ui';

import { useAvailabilityQuery, useSetAvailabilityMutation } from '../../hooks/useAvailability.js';

import type { AvailabilityStatus } from '../../lib/apiClient.js';

export interface AvailabilitySelectorProps {
  workspaceId: string;
}

const STATUS_LABELS: Record<AvailabilityStatus, string> = {
  available: 'Müsait',
  focus: 'Odaklanma',
  ooo: 'Ofis Dışı',
};

const DEFAULT_STATUS: AvailabilityStatus = 'available';

function isAvailabilityStatus(value: string): value is AvailabilityStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, value);
}

/**
 * Header Odak/OOO selector (F1-T12 PR8b) — shows the workspace's current
 * availability status and lets the user change it. Defaults to "Müsait"
 * (`available`) when `useAvailabilityQuery` resolves to `null` (never set).
 */
export function AvailabilitySelector({ workspaceId }: AvailabilitySelectorProps) {
  const query = useAvailabilityQuery(workspaceId);
  const mutation = useSetAvailabilityMutation(workspaceId);

  const currentStatus: AvailabilityStatus = query.data?.status ?? DEFAULT_STATUS;

  return (
    <SelectRoot
      value={currentStatus}
      onValueChange={(next) => {
        if (isAvailabilityStatus(next)) {
          mutation.mutate({ status: next });
        }
      }}
    >
      <SelectTrigger data-testid="availability-select" aria-label="Uygunluk durumu">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(STATUS_LABELS) as AvailabilityStatus[]).map((status) => (
          <SelectItem key={status} value={status}>
            {STATUS_LABELS[status]}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
