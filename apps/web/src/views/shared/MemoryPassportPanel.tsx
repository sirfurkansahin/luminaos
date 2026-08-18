import { useState } from 'react';

import type { MemoryRecord } from '@luminaos/memory';
import {
  Button,
  DialogContent,
  DialogRoot,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
} from '@luminaos/ui';

import {
  useCreateMemoryRecordMutation,
  useDeleteMemoryRecordMutation,
  useMemoryRecordsQuery,
  useUpdateMemoryRecordMutation,
} from '../../hooks/useMemoryRecordsQuery.js';

export interface MemoryPassportPanelProps {
  workspaceId: string;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('tr-TR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Human-readable source-trace derived from `createdAt` ONLY — ADR-0022: in
 * v1 `kaynakOlayId` is always self-referential to the record's own creation
 * event and carries no meaningful information to the user, so its raw UUID
 * must never be rendered.
 */
function formatSourceTrace(record: MemoryRecord): string {
  return `${DATE_FORMATTER.format(record.createdAt)} tarihinde eklendi`;
}

function MemoryRecordRow({
  record,
  onUpdate,
  onDelete,
}: {
  record: MemoryRecord;
  onUpdate: (recordId: string, content: string) => void;
  onDelete: (recordId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(record.content);

  if (isEditing) {
    return (
      <li data-testid={`memory-record-item-${record.id}`}>
        <Input
          data-testid={`memory-record-edit-input-${record.id}`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <Button
          type="button"
          data-testid={`memory-record-edit-save-${record.id}`}
          onClick={() => {
            if (draft.trim().length > 0) {
              onUpdate(record.id, draft);
            }
            setIsEditing(false);
          }}
        >
          Kaydet
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid={`memory-record-edit-cancel-${record.id}`}
          onClick={() => {
            setDraft(record.content);
            setIsEditing(false);
          }}
        >
          Vazgeç
        </Button>
      </li>
    );
  }

  return (
    <li data-testid={`memory-record-item-${record.id}`}>
      <span>{record.content}</span>
      <span>{formatSourceTrace(record)}</span>
      <Button
        type="button"
        variant="secondary"
        data-testid={`memory-record-edit-${record.id}`}
        onClick={() => {
          setDraft(record.content);
          setIsEditing(true);
        }}
      >
        Düzenle
      </Button>
      <Button
        type="button"
        variant="secondary"
        data-testid={`memory-record-delete-${record.id}`}
        onClick={() => {
          onDelete(record.id);
        }}
      >
        Sil
      </Button>
    </li>
  );
}

export function MemoryPassportPanel({ workspaceId }: MemoryPassportPanelProps) {
  const [open, setOpen] = useState(false);
  const [newContent, setNewContent] = useState('');

  const { data, isLoading, isError } = useMemoryRecordsQuery(workspaceId);
  const createMutation = useCreateMemoryRecordMutation(workspaceId);
  const updateMutation = useUpdateMemoryRecordMutation(workspaceId);
  const deleteMutation = useDeleteMemoryRecordMutation(workspaceId);

  function handleCreateSubmit(): void {
    const content = newContent.trim();
    if (content.length === 0) {
      return;
    }
    createMutation.mutate({ content });
    setNewContent('');
  }

  function renderBody(): React.JSX.Element {
    if (isLoading) {
      return (
        <div data-testid="memory-passport-loading">
          <Skeleton height={32} />
        </div>
      );
    }

    if (isError) {
      return (
        <EmptyState
          data-testid="memory-passport-error"
          title="Bir hata oluştu"
          description="Bilgi kayıtları yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
        />
      );
    }

    const records = data?.records ?? [];

    if (records.length === 0) {
      return (
        <EmptyState
          data-testid="memory-passport-empty"
          title="Henüz bir kayıt yok"
          description="Senin hakkında henüz bir bilgi kaydedilmedi."
        />
      );
    }

    return (
      <ul aria-label="Hakkımda bilinenler">
        {records.map((record) => (
          <MemoryRecordRow
            key={record.id}
            record={record}
            onUpdate={(recordId, content) => {
              updateMutation.mutate({ recordId, input: { content } });
            }}
            onDelete={(recordId) => {
              deleteMutation.mutate(recordId);
            }}
          />
        ))}
      </ul>
    );
  }

  return (
    <>
      <Button
        type="button"
        data-testid="memory-passport-trigger"
        onClick={() => {
          setOpen(true);
        }}
      >
        Hakkımda ne biliyorsun?
      </Button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="memory-passport-dialog">
          <DialogTitle>Hakkımda ne biliyorsun?</DialogTitle>
          {renderBody()}
          <div>
            <Input
              data-testid="memory-passport-create-input"
              value={newContent}
              onChange={(event) => {
                setNewContent(event.target.value);
              }}
            />
            <Button
              type="button"
              data-testid="memory-passport-create-submit"
              onClick={handleCreateSubmit}
            >
              Ekle
            </Button>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
}
