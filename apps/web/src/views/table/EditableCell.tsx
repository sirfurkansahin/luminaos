import { useEffect, useRef, useState } from 'react';

import { Input } from '@luminaos/ui';

import type { KeyboardEvent } from 'react';

export interface EditableCellProps {
  value: unknown;
  onCommit: (newValue: unknown) => void;
}

export function EditableCell({ value, onCommit }: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(() => String(value));
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter/Escape already resolve the edit (commit or cancel) inside their
  // own keydown handler; this suppresses the input's subsequent blur (fired
  // as the element unmounts) from committing a second time.
  const suppressBlurCommitRef = useRef(false);

  const startEditing = (): void => {
    setDraft(String(value));
    suppressBlurCommitRef.current = false;
    setIsEditing(true);
  };

  const commit = (): void => {
    onCommit(draft);
    setIsEditing(false);
  };

  const cancel = (): void => {
    setIsEditing(false);
  };

  const handleDisplayKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key === 'Enter') {
      startEditing();
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      suppressBlurCommitRef.current = true;
      commit();
    } else if (event.key === 'Escape') {
      suppressBlurCommitRef.current = true;
      cancel();
    }
  };

  const handleBlur = (): void => {
    if (suppressBlurCommitRef.current) {
      return;
    }
    commit();
  };

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        data-testid="editable-cell-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={handleInputKeyDown}
        onBlur={handleBlur}
      />
    );
  }

  return (
    <span
      data-testid="editable-cell-display"
      role="button"
      tabIndex={0}
      onClick={startEditing}
      onKeyDown={handleDisplayKeyDown}
    >
      {String(value)}
    </span>
  );
}
