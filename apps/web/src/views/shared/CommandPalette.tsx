import { useEffect, useRef, useState } from 'react';

import type { ObjectType } from '@luminaos/core-objects';
import { Button, DialogContent, DialogRoot, DialogTitle, Input, toast } from '@luminaos/ui';

import { ExternalSearchResultChip } from './ExternalSearchResultChip.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useExternalSearchQuery } from '../../hooks/useExternalSearchQuery.js';
import { useInviteMeetingBotMutation } from '../../hooks/useInviteMeetingBotMutation.js';
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

// F2-T13 PR5 (ADR-0029 §d, ADR-0030 §i/§j) -- "Toplantıya bot davet et" quick
// action. Visible whenever the raw query is empty or case-insensitively
// matches its own label or one of these keywords.
const INVITE_BOT_ACTION_LABEL = 'Toplantıya bot davet et';
const INVITE_BOT_KEYWORDS = ['bot', 'toplantı', 'meet', 'kayıt'];

function inviteBotActionMatchesQuery(rawQuery: string): boolean {
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const lowered = trimmed.toLowerCase();
  return (
    INVITE_BOT_ACTION_LABEL.toLowerCase().includes(lowered) ||
    INVITE_BOT_KEYWORDS.some(
      (keyword) => keyword.toLowerCase().includes(lowered) || lowered.includes(keyword),
    )
  );
}

function notetakerConsentKey(workspaceId: string): string {
  return `luminaos:notetaker-consent:${workspaceId}`;
}

function hasNotetakerConsent(workspaceId: string): boolean {
  return window.localStorage.getItem(notetakerConsentKey(workspaceId)) === 'true';
}

/**
 * F2-T13 PR5 (ADR-0029 §d) -- one-time, per-workspace consent dialog before
 * the FIRST bot invite. Explains that a recording bot is invited and audio/
 * video is processed in the provider's own cloud (ADR-0029's Kademe 0 rule --
 * raw audio/video never passes through LuminaOS's own server).
 */
function NotetakerConsentDialog({
  open,
  onOpenChange,
  onAcknowledge,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onAcknowledge: () => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="notetaker-consent-dialog">
        <DialogTitle>Toplantı Kaydı Hakkında</DialogTitle>
        <p>
          Bu eylem toplantınıza bir kayıt botu davet eder. Bot, ses ve görüntüyü sağlayıcının kendi
          bulut altyapısında işler -- ham ses/görüntü LuminaOS sunucusundan geçmez, yalnızca sonuç
          (transkript ve kayıt bağlantısı) LuminaOS&apos;a iletilir.
        </p>
        <Button type="button" data-testid="notetaker-consent-acknowledge" onClick={onAcknowledge}>
          Anladım, devam et
        </Button>
      </DialogContent>
    </DialogRoot>
  );
}

/**
 * F2-T13 PR5 -- the ad hoc "invite a bot" form dialog. Owns its own local
 * input/error state, reset whenever it's closed or reopened.
 */
function NotetakerInviteDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  workspaceId: string;
}) {
  const [meetingUrl, setMeetingUrl] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const inviteMutation = useInviteMeetingBotMutation(workspaceId);

  function reset(): void {
    setMeetingUrl('');
    setErrorMessage(undefined);
  }

  function handleOpenChange(next: boolean): void {
    onOpenChange(next);
    if (!next) {
      reset();
    }
  }

  function handleSubmit(): void {
    const trimmedUrl = meetingUrl.trim();
    if (trimmedUrl.length === 0) {
      return;
    }
    setErrorMessage(undefined);
    inviteMutation.mutate(trimmedUrl, {
      onSuccess: () => {
        toast({ title: 'Bot toplantıya davet edildi.', variant: 'success' });
        handleOpenChange(false);
      },
      onError: (error: Error) => {
        setErrorMessage(error.message.length > 0 ? error.message : 'Bilinmeyen bir hata oluştu.');
      },
    });
  }

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="notetaker-invite-dialog">
        <DialogTitle>Toplantıya Bot Davet Et</DialogTitle>
        <Input
          data-testid="notetaker-meeting-url-input"
          placeholder="Toplantı linkini yapıştırın"
          value={meetingUrl}
          onChange={(event) => {
            setMeetingUrl(event.target.value);
          }}
        />
        {errorMessage !== undefined && <p data-testid="notetaker-invite-error">{errorMessage}</p>}
        <Button
          type="button"
          data-testid="notetaker-invite-submit"
          disabled={meetingUrl.trim().length === 0 || inviteMutation.isPending}
          onClick={handleSubmit}
        >
          Botu Davet Et
        </Button>
      </DialogContent>
    </DialogRoot>
  );
}

export function CommandPalette({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { openObject } = useObjectIdParam();

  function handleInviteBotActionClick(): void {
    if (hasNotetakerConsent(workspaceId)) {
      setInviteDialogOpen(true);
    } else {
      setConsentDialogOpen(true);
    }
  }

  function handleConsentAcknowledge(): void {
    window.localStorage.setItem(notetakerConsentKey(workspaceId), 'true');
    setConsentDialogOpen(false);
    setInviteDialogOpen(true);
  }

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
        {inviteBotActionMatchesQuery(rawQuery) && (
          <div
            data-testid="command-palette-invite-bot-action"
            role="button"
            tabIndex={0}
            onClick={handleInviteBotActionClick}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                handleInviteBotActionClick();
              }
            }}
          >
            {INVITE_BOT_ACTION_LABEL}
          </div>
        )}
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
      <NotetakerConsentDialog
        open={consentDialogOpen}
        onOpenChange={setConsentDialogOpen}
        onAcknowledge={handleConsentAcknowledge}
      />
      <NotetakerInviteDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
        workspaceId={workspaceId}
      />
    </DialogRoot>
  );
}
