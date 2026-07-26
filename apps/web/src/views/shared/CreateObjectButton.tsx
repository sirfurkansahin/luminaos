import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@luminaos/ui';

import { createObject } from '../../lib/apiClient.js';

export interface CreateObjectButtonProps {
  workspaceId: string;
  objectType: string;
}

export function CreateObjectButton({ workspaceId, objectType }: CreateObjectButtonProps) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => createObject(workspaceId, { objectType, title: 'Adsız' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['objects', workspaceId] });
    },
  });

  return (
    <div>
      <Button
        data-testid="create-object-button"
        variant="primary"
        onClick={() => {
          mutation.mutate();
        }}
      >
        + Yeni
      </Button>
      {mutation.isError ? (
        <span data-testid="create-object-button-error" role="alert">
          Nesne oluşturulamadı. Lütfen tekrar deneyin.
        </span>
      ) : null}
    </div>
  );
}
