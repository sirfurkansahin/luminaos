import { useEffect, useRef, useState } from 'react';

import type { ObjectType } from '@luminaos/core-objects';
import { DialogContent, DialogRoot, DialogTitle, Input } from '@luminaos/ui';

import { ExternalSearchResultChip } from './ExternalSearchResultChip.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useExternalSearchQuery } from '../../hooks/useExternalSearchQuery.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { useSearchQuery } from '../../hooks/useSearchQuery.js';

import type { SearchResult } from '../../lib/apiClient.js';
import type { KeyboardEvent } from 'react';

const DEBOUNCE_MS = 250;

const GROUP_ORDER: ReadonlyArray<{ type: ObjectType; label: string }> = [
  { type: 'task', label: 'Görevler' },
  { type: 'doc', label: 'Dokümanlar' },
  { type: 'note', label: 'Notlar' },
  { type: 'timeblock', label: 'Zaman Blokları' },
];

export function CommandPalette({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { openObject } = useObjectIdParam();

  const debouncedQuery = useDebouncedValue(rawQuery, DEBOUNCE_MS);
  const { data } = useSearchQuery(workspaceId, debouncedQuery);
  const { data: externalData } = useExternalSearchQuery(workspaceId, debouncedQuery);

  // Whenever a fresh result set arrives, the previously-active index may no
  // longer make sense (fewer/reordered rows) — the pinned contract requires
  // the first row to be active again on every new search. Adjusted here
  // (during render, React's documented pattern for "reset state when a prop
  // changes") rather than in a `useEffect` body, which the repo's
  // `react-hooks/set-state-in-effect` lint rule flags as a cascading-render
  // risk.
  const [previousData, setPreviousData] = useState(data);
  if (data !== previousData) {
    setPreviousData(data);
    setActiveIndex(0);
  }

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    function handleGlobalKeyDown(event: globalThis.KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        // Without this, the browser's own bookmark-search shortcut fires too.
        event.preventDefault();
        setOpen(true);
      }
    }

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, []);

  const results = data?.results ?? [];
  const groups = GROUP_ORDER.map((group) => ({
    ...group,
    items: results.filter((result) => result.type === group.type),
  })).filter((group) => group.items.length > 0);
  const flatResults = groups.flatMap((group) => group.items);
  const externalResults = externalData?.results ?? [];

  function reset(): void {
    setRawQuery('');
    setActiveIndex(0);
  }

  function selectResult(result: SearchResult): void {
    openObject(result.objectId);
    setOpen(false);
    reset();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (flatResults.length > 0) {
        setActiveIndex((current) => Math.min(current + 1, flatResults.length - 1));
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (flatResults.length > 0) {
        setActiveIndex((current) => Math.max(current - 1, 0));
      }
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const activeResult = flatResults[activeIndex];
      if (activeResult !== undefined) {
        selectResult(activeResult);
      }
    }
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
        }
      }}
    >
      <DialogContent data-testid="command-palette">
        <DialogTitle>Komut Paleti</DialogTitle>
        <Input
          ref={inputRef}
          data-testid="command-palette-input"
          value={rawQuery}
          onChange={(event) => {
            setRawQuery(event.target.value);
          }}
          onKeyDown={handleInputKeyDown}
        />
        {groups.map((group) => (
          <div key={group.type}>
            <span>{group.label}</span>
            <ul>
              {group.items.map((item) => (
                <li
                  key={item.objectId}
                  data-testid="command-palette-result"
                  role="option"
                  aria-selected={flatResults.indexOf(item) === activeIndex}
                  tabIndex={-1}
                  onClick={() => {
                    selectResult(item);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      selectResult(item);
                    }
                  }}
                >
                  {item.title}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {externalResults.length > 0 && (
          <div>
            <span>Dış Kaynaklar</span>
            {externalResults.map((result, index) => (
              // External results have no stable id in the pinned ADR-0027 §f
              // shape (connectorType/title/snippet); mirrors
              // ExternalEventChip's read-only, non-interactive precedent
              // which has the same gap.

              <ExternalSearchResultChip key={index} result={result} />
            ))}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
