import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button, DialogClose, DialogContent, DialogRoot, DialogTitle, Input } from '@luminaos/ui';

import { createObject, scheduleTimeBlock } from '../../lib/apiClient.js';

const DEFAULT_START_HOUR = '09:00';
const DEFAULT_END_HOUR = '10:00';

export interface CreateTimeblockModalProps {
  workspaceId: string;
  dateISO: string;
  onClose: () => void;
}

/**
 * Click-day-to-create-timeblock modal (F1-T12 PR8b — the accepted substitute
 * for pixel-precise drag-to-create; see docs/specs/F1-E3/F1-T12-takvim.md's
 * "Kapsam DIŞI" note). Submitting chains `createObject` (objectType:
 * 'timeblock') then `scheduleTimeBlock` on the newly-created object's id —
 * either step rejecting shows an inline error and leaves the modal open.
 *
 * Uses `useMutation`/`useQueryClient` (mirrors `CreateObjectButton.tsx`'s
 * cache-invalidating pattern) so the Calendar view's `['objects', workspaceId,
 * ...]`-keyed queries refetch once the new timeblock exists — without this,
 * the newly-created block would stay invisible in the grid until a manual
 * page refresh.
 */
export function CreateTimeblockModal({ workspaceId, dateISO, onClose }: CreateTimeblockModalProps) {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(`${dateISO}T${DEFAULT_START_HOUR}`);
  const [end, setEnd] = useState(`${dateISO}T${DEFAULT_END_HOUR}`);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const { object } = await createObject(workspaceId, { objectType: 'timeblock', title });
      await scheduleTimeBlock(workspaceId, object.id, { start, end });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['objects', workspaceId] });
      onClose();
    },
  });

  const handleSubmit = (): void => {
    mutation.mutate();
  };

  return (
    <DialogRoot
      open={true}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent data-testid="create-timeblock-modal">
        <DialogTitle>Zaman bloğu oluştur</DialogTitle>

        <label htmlFor="timeblock-title-input">Başlık</label>
        <Input
          id="timeblock-title-input"
          data-testid="timeblock-title-input"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />

        <label htmlFor="timeblock-start-input">Başlangıç</label>
        <Input
          id="timeblock-start-input"
          data-testid="timeblock-start-input"
          type="datetime-local"
          value={start}
          onChange={(event) => {
            setStart(event.target.value);
          }}
        />

        <label htmlFor="timeblock-end-input">Bitiş</label>
        <Input
          id="timeblock-end-input"
          data-testid="timeblock-end-input"
          type="datetime-local"
          value={end}
          onChange={(event) => {
            setEnd(event.target.value);
          }}
        />

        {mutation.isError ? (
          <span role="alert" data-testid="timeblock-modal-error">
            Zaman bloğu oluşturulamadı. Lütfen tekrar deneyin.
          </span>
        ) : null}

        <div>
          <DialogClose asChild>
            <Button variant="ghost" data-testid="timeblock-cancel-button">
              Vazgeç
            </Button>
          </DialogClose>
          <Button
            variant="primary"
            data-testid="timeblock-submit-button"
            disabled={mutation.isPending}
            onClick={handleSubmit}
          >
            Oluştur
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
