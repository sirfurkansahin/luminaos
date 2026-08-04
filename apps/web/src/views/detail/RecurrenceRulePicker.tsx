import { useState } from 'react';

import type { RecurrenceRule } from '@luminaos/core-objects';
import {
  Button,
  Checkbox,
  DateTimePicker,
  Input,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
} from '@luminaos/ui';

import { useRecurrenceRuleMutations } from '../../hooks/useRecurrenceRuleMutations.js';

export interface RecurrenceRulePickerProps {
  workspaceId: string;
  objectId: string;
  currentRule: RecurrenceRule | undefined;
}

const WEEKDAY_LABELS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

function isFrequency(value: string): value is RecurrenceRule['frequency'] {
  return value === 'daily' || value === 'weekly' || value === 'monthly';
}

export function RecurrenceRulePicker({
  workspaceId,
  objectId,
  currentRule,
}: RecurrenceRulePickerProps) {
  const { setRule, clearRule } = useRecurrenceRuleMutations(workspaceId, objectId);

  const [frequency, setFrequency] = useState<RecurrenceRule['frequency'] | undefined>(
    currentRule?.frequency,
  );
  const [intervalDraft, setIntervalDraft] = useState(
    currentRule?.interval !== undefined ? currentRule.interval.toString() : '',
  );
  const [byWeekday, setByWeekday] = useState<number[]>(currentRule?.byWeekday ?? []);
  const [endDateDraft, setEndDateDraft] = useState(currentRule?.endDate ?? '');

  function toggleWeekday(day: number): void {
    setByWeekday((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
    );
  }

  function handleSubmit(): void {
    if (frequency === undefined) {
      return;
    }
    const parsedInterval = Number(intervalDraft);
    if (intervalDraft.trim() === '' || !Number.isInteger(parsedInterval) || parsedInterval < 1) {
      return;
    }

    const rule: RecurrenceRule = {
      frequency,
      interval: parsedInterval,
      ...(frequency === 'weekly' && byWeekday.length > 0
        ? { byWeekday: [...byWeekday].sort((a, b) => a - b) }
        : {}),
      ...(endDateDraft.trim() !== '' ? { endDate: endDateDraft } : {}),
    };

    setRule.mutate(rule);
  }

  return (
    <div>
      <SelectRoot
        onValueChange={(newValue) => {
          if (isFrequency(newValue)) {
            setFrequency(newValue);
          }
        }}
        {...(frequency !== undefined ? { value: frequency } : {})}
      >
        <SelectTrigger aria-label="Yineleme sıklığı">
          <SelectValue placeholder="" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="daily">Günlük</SelectItem>
          <SelectItem value="weekly">Haftalık</SelectItem>
          <SelectItem value="monthly">Aylık</SelectItem>
        </SelectContent>
      </SelectRoot>

      <Input
        type="number"
        data-testid="recurrence-interval-input"
        aria-label="Aralık"
        value={intervalDraft}
        onChange={(event) => {
          setIntervalDraft(event.target.value);
        }}
      />

      {frequency === 'weekly' ? (
        <div>
          {WEEKDAY_LABELS.map((label, day) => (
            <Checkbox
              key={day}
              data-testid={`recurrence-weekday-${day.toString()}`}
              aria-label={label}
              checked={byWeekday.includes(day)}
              onCheckedChange={() => {
                toggleWeekday(day);
              }}
            />
          ))}
        </div>
      ) : null}

      <DateTimePicker
        mode="date"
        data-testid="recurrence-end-date-input"
        aria-label="Bitiş tarihi"
        value={endDateDraft}
        onChange={(event) => {
          setEndDateDraft(event.target.value);
        }}
      />

      <Button
        type="button"
        data-testid="recurrence-submit-button"
        onClick={() => {
          handleSubmit();
        }}
      >
        Kaydet
      </Button>

      {currentRule !== undefined ? (
        <Button
          type="button"
          data-testid="recurrence-clear-button"
          onClick={() => {
            clearRule.mutate();
          }}
        >
          Yinelemeyi kaldır
        </Button>
      ) : null}
    </div>
  );
}
