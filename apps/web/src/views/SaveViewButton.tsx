import { useState } from 'react';

import type { SavedView, ViewType } from '@luminaos/core-objects';
import {
  Button,
  Checkbox,
  DialogClose,
  DialogContent,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  Input,
} from '@luminaos/ui';

import { useCreateSavedViewMutation } from '../hooks/useSavedViewsQuery.js';
import { IconPicker } from './shared/IconPicker.js';

export interface SaveViewButtonProps {
  workspaceId: string;
  objectType: string;
  viewType: ViewType;
  // List/Board/Table capture the currently active query spec.
  querySpec?: SavedView['querySpec'];
  // Calendar captures only its currently-selected date field (F1-T9 plan
  // decision: a saved calendar/timeline view never freezes a date
  // range/filter, only the field selection — month/week navigation always
  // stays live).
  dateField?: string;
  // Timeline captures its currently-selected start/end fields.
  startField?: string;
  endField?: string;
}

/**
 * "Save current view" entry point (F1-T9 PR2 plan) — opens a dialog to name,
 * icon and optionally share the view currently active in `App.tsx`.
 *
 * For Calendar/Timeline, `dateField`/`startField`/`endField` are the *live*
 * field selection lifted up from `CalendarView`/`TimelineView` via their
 * `onDateFieldChange`/`onStartFieldChange`/`onEndFieldChange` callbacks
 * (wired in `App.tsx`) — this captures whatever the user is actually looking
 * at (seeded from a loaded saved view, defaulted to `candidates[0]`/`[1]`, or
 * changed via the in-view Select), never a value the user has to retype.
 */
export function SaveViewButton({
  workspaceId,
  objectType,
  viewType,
  querySpec,
  dateField,
  startField,
  endField,
}: SaveViewButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [shared, setShared] = useState(false);

  const mutation = useCreateSavedViewMutation(workspaceId);

  const resetForm = (): void => {
    setName('');
    setIcon(undefined);
    setShared(false);
  };

  const missingRequiredField =
    (viewType === 'calendar' && dateField === undefined) ||
    (viewType === 'timeline' && (startField === undefined || endField === undefined));

  const handleSubmit = (): void => {
    if (name.trim().length === 0 || icon === undefined || missingRequiredField) {
      return;
    }

    mutation.mutate(
      {
        name,
        icon,
        viewType,
        objectType,
        querySpec: querySpec ?? { objectType, filters: [] },
        shared,
        ...(viewType === 'calendar' && dateField !== undefined ? { dateField } : {}),
        ...(viewType === 'timeline' && startField !== undefined ? { startField } : {}),
        ...(viewType === 'timeline' && endField !== undefined ? { endField } : {}),
      },
      {
        onSuccess: () => {
          resetForm();
          setOpen(false);
        },
      },
    );
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          resetForm();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" data-testid="save-view-button">
          Görünümü kaydet
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="save-view-dialog">
        <DialogTitle>Görünümü kaydet</DialogTitle>

        <label htmlFor="save-view-name-input">Ad</label>
        <Input
          id="save-view-name-input"
          data-testid="save-view-name-input"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />

        <IconPicker value={icon} onChange={setIcon} />

        {viewType === 'calendar' ? (
          <p data-testid="save-view-date-field-display">Tarih alanı: {dateField ?? '—'}</p>
        ) : null}

        {viewType === 'timeline' ? (
          <p data-testid="save-view-start-end-field-display">
            Başlangıç: {startField ?? '—'} · Bitiş: {endField ?? '—'}
          </p>
        ) : null}

        <label htmlFor="save-view-shared-checkbox">
          <Checkbox
            id="save-view-shared-checkbox"
            data-testid="save-view-shared-checkbox"
            checked={shared}
            onCheckedChange={(checked) => {
              setShared(checked === true);
            }}
          />
          Workspace ile paylaş
        </label>

        {mutation.isError ? (
          <span role="alert" data-testid="save-view-error">
            Görünüm kaydedilemedi. Lütfen tekrar deneyin.
          </span>
        ) : null}

        <div>
          <DialogClose asChild>
            <Button variant="ghost">Vazgeç</Button>
          </DialogClose>
          <Button
            data-testid="save-view-submit"
            variant="primary"
            onClick={handleSubmit}
            disabled={mutation.isPending || missingRequiredField}
          >
            Kaydet
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
