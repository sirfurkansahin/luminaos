import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './CommandPalette.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { searchWorkspace } from '../../lib/apiClient.js';

import type { SearchResult } from '../../lib/apiClient.js';
import type { ReactNode } from 'react';

/**
 * F1-T13 PR7 (ADR-0013) — TDD red step. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/views/shared/CommandPalette.tsx to satisfy these tests):
 *
 *   export function CommandPalette({ workspaceId }: { workspaceId: string }): JSX.Element
 *
 * - Renders NOTHING visible by default (closed) — but IS mounted (always in
 *   the tree, listening for the global shortcut) so it can be added once near
 *   the top of App.tsx and just work.
 * - A global `Cmd+K` (metaKey) OR `Ctrl+K` (ctrlKey) keydown anywhere in the
 *   document OPENS the palette (a Dialog): shows a text input
 *   (data-testid="command-palette-input"), autofocused, and (once results
 *   exist) a results list.
 * - Typing in the input debounces 250ms (via useDebouncedValue) before
 *   triggering useSearchQuery — searchWorkspace is NOT called on every
 *   keystroke, only ~250ms after the user stops typing.
 * - Results are grouped by `type` into sections with Turkish headers, in this
 *   FIXED order: 'task' -> 'Görevler', 'doc' -> 'Dokümanlar',
 *   'note' -> 'Notlar', 'timeblock' -> 'Zaman Blokları'. A group section only
 *   renders if it has at least one result (no empty-section headers).
 * - Each result row: data-testid="command-palette-result", role="option",
 *   aria-selected reflecting whether it's the currently-active row. The FIRST
 *   result (flat index 0, across all rendered groups in the fixed order
 *   above) is active by default once results exist.
 * - ArrowDown/ArrowUp move the active selection across the FLATTENED list of
 *   all visible results (in the order the groups/rows are rendered) and CLAMP
 *   at the boundaries (ArrowUp on the first result / ArrowDown on the last
 *   result is a no-op — does NOT wrap). This is a judgment call: clamping was
 *   chosen over wrapping as the simpler, more common palette convention
 *   (VS Code's Cmd+P, for example, wraps — but nothing in the spec pins
 *   either way, so implementer must match THIS clamp behavior exactly).
 * - Enter on the currently-active result calls openObject(result.objectId)
 *   and CLOSES the palette (input clears, dialog closes).
 * - Escape closes the palette without navigating anywhere (openObject NOT
 *   called).
 * - Clicking a result row (not just keyboard) also calls
 *   openObject(result.objectId) and closes the palette.
 * - Closing and RE-OPENING the palette (Cmd/Ctrl+K again) resets the input to
 *   empty (no stale query/results carried over from the previous open).
 *
 * Judgment calls (so implementer matches exactly):
 *   1. Active-row marker: `role="option"` + `aria-selected="true"|"false"` on
 *      each `data-testid="command-palette-result"` row (mirrors the ARIA
 *      listbox/option pattern rather than inventing a bespoke class/testid).
 *   2. ArrowUp/ArrowDown at a boundary CLAMPS (stays put), does not wrap.
 *   3. Debounce is tested with REAL timers (not `vi.useFakeTimers()`) plus
 *      `waitFor`'s real-timer polling: mixing `vi.useFakeTimers()` with
 *      `userEvent`'s internal keystroke scheduling is fragile in this
 *      codebase's React 18 + user-event v14 setup (see
 *      useDebouncedValue.test.ts, which only ever drives fake timers through
 *      `renderHook` + `act`, never through `userEvent`). Typing via
 *      `userEvent.type` with the library's default (near-zero) inter-keystroke
 *      delay reliably finishes well under 250ms of real wall-clock time, so
 *      asserting "not called immediately after typing finishes" is safe
 *      without fake timers, and a real 250ms+ `waitFor` window (well within
 *      its default 1000ms timeout) reliably observes the debounced call.
 *   4. Global Cmd/Ctrl+K and Escape/Arrow/Enter interactions are driven via
 *      `userEvent.keyboard(...)`'s modifier-hold syntax
 *      (`{Meta>}k{/Meta}` / `{Control>}k{/Control}`), targeting
 *      `document.activeElement` (mirrors this codebase's own
 *      `TableView.test.tsx`/`StatusPrioritySelect.test.tsx` convention of
 *      `await user.keyboard('{ArrowDown}')` after focusing an element —
 *      here the "focused element" starts as `document.body` for the
 *      open-shortcut, since nothing is focused until the palette opens the
 *      autofocused input).
 */

vi.mock('../../lib/apiClient.js', () => ({
  searchWorkspace: vi.fn(),
}));

vi.mock('../../hooks/useObjectIdParam.js', () => ({
  useObjectIdParam: vi.fn(),
}));

/**
 * `../../hooks/useExternalSearchQuery.ts` (ADR-0027 §f) does not exist yet.
 * Rather than a top-level `import { useExternalSearchQuery } from
 * '../../hooks/useExternalSearchQuery.js'` (which — unlike the already-real
 * `useObjectIdParam` mocked the same way above — has no real file for Vite to
 * resolve a binding against, even once `vi.mock` intercepts its CONTENT for
 * other importers such as the not-yet-updated `CommandPalette.tsx`), the
 * mock function is created via `vi.hoisted` and referenced ONLY by closure
 * inside the `vi.mock` factory below — this file never imports the hook
 * module itself, so there is nothing for our own bindings to fail to resolve.
 * `ExternalSearchResult`/the hook's return shape are declared locally
 * (ADR-0027 §a/§f's exact pinned shape) since they can't be type-imported
 * from the not-yet-existing module either.
 */
interface ExternalSearchResult {
  connectorType: string;
  title: string;
  snippet: string;
}

interface ExternalSearchQueryResult {
  data: { results: ExternalSearchResult[]; degraded: string[] } | undefined;
}

const { mockedUseExternalSearchQuery } = vi.hoisted(() => {
  return {
    mockedUseExternalSearchQuery:
      vi.fn<(workspaceId: string, query: string) => ExternalSearchQueryResult>(),
  };
});

// F2-T11 (RED step), ADR-0027 §f — mocked wholesale, the same way
// `useObjectIdParam` is mocked directly above (rather than mocking the
// underlying `searchExternalWorkspace` apiClient call, the way the existing
// internal-search tests mock `searchWorkspace`) — this gives each test full,
// synchronous control over the external-results payload without also having
// to drive the 250ms debounce window a second time for an orthogonal query.
vi.mock('../../hooks/useExternalSearchQuery.js', () => ({
  useExternalSearchQuery: mockedUseExternalSearchQuery,
}));

/**
 * F2-T13 PR5 (ADR-0029 §d, ADR-0030 §i/§j) — TDD red step for the new
 * "Toplantıya bot davet et" command-palette quick action. Contract under
 * test (none of this exists yet — `implementer` must build it next):
 *
 *   apps/web/src/hooks/useInviteMeetingBotMutation.ts (new file):
 *     export function useInviteMeetingBotMutation(workspaceId: string):
 *       UseMutationResult<InviteMeetingBotResult, Error, string>
 *     — mirrors useMcpGrantsQuery.ts's mutation shape exactly (mutationFn
 *     wraps apiClient's inviteMeetingBot(workspaceId, meetingUrl), no
 *     automatic invalidation).
 *
 *   apps/web/src/views/shared/CommandPalette.tsx (modified, not yet built):
 *     - a new row ABOVE the search-result groups,
 *       data-testid="command-palette-invite-bot-action", labeled "Toplantıya
 *       bot davet et", visible when the raw (non-debounced) query is empty OR
 *       case-insensitively matches its label or one of the keywords
 *       ['bot', 'toplantı', 'meet', 'kayıt'].
 *     - clicking it checks
 *       window.localStorage.getItem('luminaos:notetaker-consent:' + workspaceId):
 *       if not exactly 'true', opens a consent dialog
 *       (data-testid="notetaker-consent-dialog") with an acknowledge button
 *       (data-testid="notetaker-consent-acknowledge", "Anladım, devam et")
 *       that sets the flag AND immediately opens the invite dialog (no
 *       second click needed); if already 'true', skips straight to the
 *       invite dialog.
 *     - invite dialog (data-testid="notetaker-invite-dialog"): a URL input
 *       (data-testid="notetaker-meeting-url-input") and a submit button
 *       (data-testid="notetaker-invite-submit", "Botu Davet Et") disabled
 *       while the input is empty OR the mutation isPending. Submitting calls
 *       useInviteMeetingBotMutation(workspaceId)'s mutate with the typed
 *       meetingUrl (mirrors McpAccessPanel.test.tsx's `mutate(vars, {
 *       onSuccess, onError })` inline-callback pattern — this file manually
 *       invokes the captured onSuccess/onError inside `act(...)`, the same
 *       technique).
 *     - on success: invite dialog closes (input resets), and a success toast
 *       fires with the PINNED copy `{ title: 'Bot toplantıya davet edildi.',
 *       variant: 'success' }` (ADR-0030 §PR5's UI requirement).
 *     - on error: the invite dialog stays open and shows SOME non-empty
 *       inline error text (data-testid="notetaker-invite-error" — this
 *       exact testid is a test-writer judgment call, not pinned by any ADR;
 *       implementer may ALSO fire a danger toast in addition, this suite
 *       only asserts the inline message is observable).
 *     - closing the invite dialog (Escape, matching CommandPalette's own
 *       Radix-Dialog-Escape precedent above) resets its own local state
 *       (stale input) without closing the outer command palette itself —
 *       relies on Radix's nested-Dialog behavior of Escape closing only the
 *       topmost open Dialog.
 *
 * `useInviteMeetingBotMutation` doesn't exist yet, so — mirroring this same
 * file's handling of the (at the time) not-yet-existing `useExternalSearchQuery`
 * a few lines above, and `McpAccessPanel.test.tsx`'s identical technique for
 * its own not-yet-existing hooks module — the mock is created via `vi.hoisted`
 * and referenced only by closure inside the `vi.mock` factory below.
 *
 * `@luminaos/ui`'s `toast` is intercepted via a PARTIAL mock (`importOriginal`
 * + spread), keeping DialogRoot/DialogContent/DialogTitle/Input/Button real
 * (this file, like the rest of this suite, does not mock `@luminaos/ui`
 * wholesale) — only the `toast` export is replaced so this suite can assert
 * on it without a real ToastProvider mounted.
 */
interface InviteMeetingBotResult {
  object: { id: string; objectType: string; title: string };
  meetingDetails: {
    id: string;
    objectId: string;
    meetingUrl: string;
    provider: string;
    status: string;
    providerMeetingRef: string;
    providerRecordingUrl: string | null;
    transcriptText?: string | null;
    createdAt: string;
  };
}

const { mockedUseInviteMeetingBotMutation, mockedToast } = vi.hoisted(() => {
  return {
    mockedUseInviteMeetingBotMutation: vi.fn(),
    mockedToast: vi.fn(),
  };
});

vi.mock('../../hooks/useInviteMeetingBotMutation.js', () => ({
  useInviteMeetingBotMutation: mockedUseInviteMeetingBotMutation,
}));

vi.mock('@luminaos/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@luminaos/ui')>();
  return { ...actual, toast: mockedToast };
});

const mockedSearchWorkspace = vi.mocked(searchWorkspace);
const mockedUseObjectIdParam = vi.mocked(useObjectIdParam);

const WORKSPACE_ID = 'ws-1';
const NOTETAKER_CONSENT_KEY = `luminaos:notetaker-consent:${WORKSPACE_ID}`;

function makeMutationResultBase(mutate: (...args: never[]) => void): Record<string, unknown> {
  return {
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  };
}

function mockInviteMutation(overrides: Record<string, unknown> = {}): {
  mutate: ReturnType<typeof vi.fn>;
} {
  const mutate = vi.fn();
  mockedUseInviteMeetingBotMutation.mockReturnValue({
    ...makeMutationResultBase(mutate),
    ...overrides,
  });
  return { mutate };
}

function makeInviteResultFixture(
  overrides: Partial<InviteMeetingBotResult> = {},
): InviteMeetingBotResult {
  return {
    object: {
      id: 'obj-meeting-1',
      objectType: 'meeting',
      title: 'https://meet.google.com/abc-defg-hij',
    },
    meetingDetails: {
      id: 'md-1',
      objectId: 'obj-meeting-1',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      provider: 'google-meet',
      status: 'sunuldu',
      providerMeetingRef: 'mock-bot-1',
      providerRecordingUrl: null,
      transcriptText: null,
      createdAt: '2026-08-21T00:00:00.000Z',
    },
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  return { queryClient, Wrapper };
}

function renderPalette() {
  const { Wrapper } = createWrapper();
  return render(<CommandPalette workspaceId={WORKSPACE_ID} />, { wrapper: Wrapper });
}

function mockOpenObject() {
  const openObject = vi.fn();
  mockedUseObjectIdParam.mockReturnValue({
    objectId: undefined,
    openObject,
    closeObject: vi.fn(),
  });
  return openObject;
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    objectId: 'obj-1',
    title: 'Q3 Roadmap',
    type: 'task',
    score: 0.9,
    ...overrides,
  };
}

async function openViaMeta(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.keyboard('{Meta>}k{/Meta}');
}

function makeExternalResult(overrides: Partial<ExternalSearchResult> = {}): ExternalSearchResult {
  return {
    connectorType: 'notion',
    title: 'External Roadmap Page',
    snippet: 'External roadmap snippet text',
    ...overrides,
  };
}

beforeEach(() => {
  mockOpenObject();
  mockedSearchWorkspace.mockResolvedValue({ results: [] });
  // Default: no external results, mirroring a workspace with nothing
  // connected -- individual tests override this via
  // `mockedUseExternalSearchQuery.mockReturnValue(...)`.
  mockedUseExternalSearchQuery.mockReturnValue({ data: { results: [], degraded: [] } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CommandPalette', () => {
  it('renders nothing visible by default (closed)', () => {
    renderPalette();

    expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
  });

  it('Cmd+K (metaKey) opens the palette with an autofocused input', async () => {
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);

    const input = screen.getByTestId('command-palette-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('Ctrl+K (ctrlKey) also opens the palette (cross-platform)', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();
  });

  it('Escape closes the palette without calling openObject', async () => {
    const openObject = mockOpenObject();
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });
    expect(openObject).not.toHaveBeenCalled();
  });

  it('debounces the query 250ms before calling searchWorkspace — not on every keystroke', async () => {
    mockedSearchWorkspace.mockResolvedValue({ results: [makeResult()] });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'roadmap');

    // user-event v14's default inter-keystroke delay is near-zero, so typing
    // 7 characters finishes well under the 250ms debounce window — no call
    // should have fired yet.
    expect(mockedSearchWorkspace).not.toHaveBeenCalled();

    await waitFor(
      () => {
        expect(mockedSearchWorkspace).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
    expect(mockedSearchWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, 'roadmap');
  });

  it('groups results by type with Turkish headers, only for types with >=1 result', async () => {
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 't-2', title: 'Task two', type: 'task' }),
        makeResult({ objectId: 'd-1', title: 'Doc one', type: 'doc' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(3);
    });

    expect(screen.getByText('Görevler')).toBeInTheDocument();
    expect(screen.getByText('Dokümanlar')).toBeInTheDocument();
    expect(screen.queryByText('Notlar')).not.toBeInTheDocument();
    expect(screen.queryByText('Zaman Blokları')).not.toBeInTheDocument();
  });

  it('ArrowDown/ArrowUp move the active selection across the flattened results, clamping at both ends', async () => {
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 't-2', title: 'Task two', type: 'task' }),
        makeResult({ objectId: 'd-1', title: 'Doc one', type: 'doc' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(3);
    });

    const activeIndex = (): number =>
      screen
        .getAllByTestId('command-palette-result')
        .findIndex((row) => row.getAttribute('aria-selected') === 'true');

    // Default active row is the first result.
    expect(activeIndex()).toBe(0);

    await user.keyboard('{ArrowDown}');
    expect(activeIndex()).toBe(1);

    await user.keyboard('{ArrowDown}');
    expect(activeIndex()).toBe(2);

    // Clamps at the last row — one more ArrowDown is a no-op.
    await user.keyboard('{ArrowDown}');
    expect(activeIndex()).toBe(2);

    await user.keyboard('{ArrowUp}');
    expect(activeIndex()).toBe(1);

    await user.keyboard('{ArrowUp}');
    expect(activeIndex()).toBe(0);

    // Clamps at the first row — one more ArrowUp is a no-op.
    await user.keyboard('{ArrowUp}');
    expect(activeIndex()).toBe(0);
  });

  it('Enter on the active result calls openObject with its objectId and closes the palette', async () => {
    const openObject = mockOpenObject();
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 't-2', title: 'Task two', type: 'task' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(2);
    });

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(openObject).toHaveBeenCalledWith('t-2');
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });
  });

  it('clicking a result row calls openObject with its objectId and closes the palette', async () => {
    const openObject = mockOpenObject();
    mockedSearchWorkspace.mockResolvedValue({
      results: [
        makeResult({ objectId: 't-1', title: 'Task one', type: 'task' }),
        makeResult({ objectId: 'd-1', title: 'Doc one', type: 'doc' }),
      ],
    });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'task');

    await waitFor(() => {
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(2);
    });

    await user.click(screen.getByText('Doc one'));

    expect(openObject).toHaveBeenCalledWith('d-1');
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });
  });

  it('re-opening after a close starts with an empty input (no stale query carried over)', async () => {
    mockedSearchWorkspace.mockResolvedValue({ results: [makeResult()] });
    const user = userEvent.setup();
    renderPalette();

    await openViaMeta(user);
    await user.type(screen.getByTestId('command-palette-input'), 'roadmap');
    await waitFor(() => {
      expect(mockedSearchWorkspace).toHaveBeenCalledTimes(1);
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-input')).not.toBeInTheDocument();
    });

    await openViaMeta(user);

    expect(screen.getByTestId<HTMLInputElement>('command-palette-input').value).toBe('');
  });

  /**
   * F2-T11 (RED step), ADR-0027 §f — the new "Dış Kaynaklar" (External
   * Sources) block, fed by `useExternalSearchQuery(workspaceId,
   * debouncedQuery)`. Rendered BELOW the existing internal `GROUP_ORDER`
   * groups, using `data-testid="external-search-result-chip"` per ADR-0027
   * §f, and — per the same ADR section's rejected-alternatives discussion —
   * deliberately NEVER wired into `flatResults`/arrow-key navigation/
   * `selectResult`, since "what happens on select" is undefined scope for
   * external results (mirrors `ExternalEventChip`'s read-only precedent).
   */
  describe('external results ("Dış Kaynaklar" block, ADR-0027 §f)', () => {
    it('renders a "Dış Kaynaklar" block with one chip per external result when useExternalSearchQuery returns results', async () => {
      mockedUseExternalSearchQuery.mockReturnValue({
        data: {
          results: [
            makeExternalResult({ connectorType: 'notion', title: 'Notion Roadmap Page' }),
            makeExternalResult({ connectorType: 'slack', title: 'Slack Roadmap Thread' }),
          ],
          degraded: [],
        },
      });
      const user = userEvent.setup();
      renderPalette();

      await openViaMeta(user);
      await user.type(screen.getByTestId('command-palette-input'), 'roadmap');

      await waitFor(() => {
        expect(screen.getByText('Dış Kaynaklar')).toBeInTheDocument();
      });
      const chips = screen.getAllByTestId('external-search-result-chip');
      expect(chips).toHaveLength(2);
      expect(screen.getByText('Notion Roadmap Page')).toBeInTheDocument();
      expect(screen.getByText('Slack Roadmap Thread')).toBeInTheDocument();
    });

    it('renders NO "Dış Kaynaklar" heading/block at all when useExternalSearchQuery returns an empty results array', async () => {
      mockedUseExternalSearchQuery.mockReturnValue({ data: { results: [], degraded: [] } });
      const user = userEvent.setup();
      renderPalette();

      await openViaMeta(user);
      await user.type(screen.getByTestId('command-palette-input'), 'roadmap');

      await waitFor(() => {
        expect(mockedSearchWorkspace).toHaveBeenCalled();
      });
      expect(screen.queryByText('Dış Kaynaklar')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('external-search-result-chip')).toHaveLength(0);
    });

    it('external result chips are NEVER part of the arrow-key navigation — ArrowDown only ever cycles through internal command-palette-result rows', async () => {
      mockedSearchWorkspace.mockResolvedValue({
        results: [
          makeResult({ objectId: 't-1', title: 'Internal Task One', type: 'task' }),
          makeResult({ objectId: 't-2', title: 'Internal Task Two', type: 'task' }),
        ],
      });
      mockedUseExternalSearchQuery.mockReturnValue({
        data: {
          results: [
            makeExternalResult({ connectorType: 'notion', title: 'External Notion Result' }),
            makeExternalResult({ connectorType: 'github', title: 'External Github Result' }),
          ],
          degraded: [],
        },
      });
      const user = userEvent.setup();
      renderPalette();

      await openViaMeta(user);
      await user.type(screen.getByTestId('command-palette-input'), 'task');

      await waitFor(() => {
        expect(screen.getAllByTestId('command-palette-result')).toHaveLength(2);
      });
      // External chips are present alongside the internal rows...
      expect(screen.getAllByTestId('external-search-result-chip')).toHaveLength(2);

      const activeIndex = (): number =>
        screen
          .getAllByTestId('command-palette-result')
          .findIndex((row) => row.getAttribute('aria-selected') === 'true');

      expect(activeIndex()).toBe(0);
      await user.keyboard('{ArrowDown}');
      expect(activeIndex()).toBe(1);
      // Clamps at the LAST INTERNAL row (2 internal results) -- if external
      // chips were wrongly folded into flatResults this would still be able
      // to advance further.
      await user.keyboard('{ArrowDown}');
      expect(activeIndex()).toBe(1);
      // Still exactly 2 internal rows are considered "results" -- the count
      // never grew to include the external chips.
      expect(screen.getAllByTestId('command-palette-result')).toHaveLength(2);

      // External chips never carry the option/aria-selected wiring the
      // internal rows use for navigation.
      for (const chip of screen.getAllByTestId('external-search-result-chip')) {
        expect(chip).not.toHaveAttribute('role', 'option');
        expect(chip).not.toHaveAttribute('aria-selected');
      }
    });

    it('clicking an external result chip does nothing — no openObject call, palette stays open, no navigation', async () => {
      const openObject = mockOpenObject();
      mockedUseExternalSearchQuery.mockReturnValue({
        data: {
          results: [
            makeExternalResult({ connectorType: 'notion', title: 'Clickable-looking Chip' }),
          ],
          degraded: [],
        },
      });
      const user = userEvent.setup();
      renderPalette();

      await openViaMeta(user);
      await user.type(screen.getByTestId('command-palette-input'), 'roadmap');

      await waitFor(() => {
        expect(screen.getByTestId('external-search-result-chip')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Clickable-looking Chip'));

      expect(openObject).not.toHaveBeenCalled();
      // The palette must still be open -- a real click-to-select would have
      // closed it (mirrors the existing internal "clicking a result row"
      // test's closed-afterward assertion, inverted).
      expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();
    });
  });

  /**
   * F2-T13 PR5 (ADR-0029 §d, ADR-0030 §i/§j) — see the file-level comment
   * above the `InviteMeetingBotResult` interface for the full contract.
   */
  describe('"Toplantıya bot davet et" quick action (F2-T13 PR5)', () => {
    beforeEach(() => {
      window.localStorage.clear();
      mockInviteMutation();
    });

    async function openPaletteAndClickInviteBot(
      user: ReturnType<typeof userEvent.setup>,
    ): Promise<void> {
      await openViaMeta(user);
      await user.click(screen.getByTestId('command-palette-invite-bot-action'));
    }

    const MEETING_URL = 'https://meet.google.com/abc-defg-hij';

    it('renders the quick action, visible by default when the search query is empty', async () => {
      const user = userEvent.setup();
      renderPalette();

      await openViaMeta(user);

      expect(screen.getByTestId('command-palette-invite-bot-action')).toBeInTheDocument();
    });

    it('hides the quick action when the typed query matches neither its label nor a keyword', async () => {
      const user = userEvent.setup();
      renderPalette();

      await openViaMeta(user);
      await user.type(screen.getByTestId('command-palette-input'), 'randomtext');

      await waitFor(() => {
        expect(screen.queryByTestId('command-palette-invite-bot-action')).not.toBeInTheDocument();
      });
    });

    it('shows the quick action again for a case-insensitive keyword match (e.g. "BOT")', async () => {
      const user = userEvent.setup();
      renderPalette();

      await openViaMeta(user);
      await user.type(screen.getByTestId('command-palette-input'), 'BOT');

      await waitFor(() => {
        expect(screen.getByTestId('command-palette-invite-bot-action')).toBeInTheDocument();
      });
    });

    it('clicking the quick action with no consent flag set opens the consent dialog, not the invite dialog', async () => {
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);

      expect(screen.getByTestId('notetaker-consent-dialog')).toBeInTheDocument();
      expect(screen.queryByTestId('notetaker-invite-dialog')).not.toBeInTheDocument();
    });

    it('acknowledging consent sets the workspace-scoped localStorage flag and opens the invite dialog directly, without a second click', async () => {
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);
      await user.click(screen.getByTestId('notetaker-consent-acknowledge'));

      expect(window.localStorage.getItem(NOTETAKER_CONSENT_KEY)).toBe('true');
      expect(screen.queryByTestId('notetaker-consent-dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('notetaker-invite-dialog')).toBeInTheDocument();
    });

    it("skips the consent dialog entirely and opens the invite dialog directly when the consent flag is already 'true'", async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);

      expect(screen.queryByTestId('notetaker-consent-dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('notetaker-invite-dialog')).toBeInTheDocument();
    });

    it('disables the submit button while the meeting URL input is empty, and enables it once text is typed', async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);

      expect(screen.getByTestId('notetaker-invite-submit')).toBeDisabled();

      await user.type(screen.getByTestId('notetaker-meeting-url-input'), MEETING_URL);

      expect(screen.getByTestId('notetaker-invite-submit')).toBeEnabled();
    });

    it('disables the submit button while the mutation isPending, even with a non-empty input', async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      mockInviteMutation({ isPending: true });
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);
      await user.type(screen.getByTestId('notetaker-meeting-url-input'), MEETING_URL);

      expect(screen.getByTestId('notetaker-invite-submit')).toBeDisabled();
    });

    it('submitting a valid URL calls the invite mutation, hooked for this workspace, with the typed meeting URL', async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      const { mutate } = mockInviteMutation();
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);
      await user.type(screen.getByTestId('notetaker-meeting-url-input'), MEETING_URL);
      await user.click(screen.getByTestId('notetaker-invite-submit'));

      expect(mockedUseInviteMeetingBotMutation).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(mutate).toHaveBeenCalledTimes(1);
      const [calledMeetingUrl] = mutate.mock.calls[0] as [string, ...unknown[]];
      expect(calledMeetingUrl).toBe(MEETING_URL);
    });

    it('on mutation success, closes the invite dialog, resets its input, and shows the pinned success toast', async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      const { mutate } = mockInviteMutation();
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);
      await user.type(screen.getByTestId('notetaker-meeting-url-input'), MEETING_URL);
      await user.click(screen.getByTestId('notetaker-invite-submit'));

      const [, options] = mutate.mock.calls[0] as [
        string,
        { onSuccess?: (result: InviteMeetingBotResult) => void } | undefined,
      ];
      act(() => {
        options?.onSuccess?.(makeInviteResultFixture());
      });

      await waitFor(() => {
        expect(screen.queryByTestId('notetaker-invite-dialog')).not.toBeInTheDocument();
      });
      expect(mockedToast).toHaveBeenCalledWith({
        title: 'Bot toplantıya davet edildi.',
        variant: 'success',
      });
    });

    it('re-opening the invite dialog after a successful submit starts with an empty input (no stale meeting URL)', async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      const { mutate } = mockInviteMutation();
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);
      await user.type(screen.getByTestId('notetaker-meeting-url-input'), MEETING_URL);
      await user.click(screen.getByTestId('notetaker-invite-submit'));

      const [, options] = mutate.mock.calls[0] as [
        string,
        { onSuccess?: (result: InviteMeetingBotResult) => void } | undefined,
      ];
      act(() => {
        options?.onSuccess?.(makeInviteResultFixture());
      });
      await waitFor(() => {
        expect(screen.queryByTestId('notetaker-invite-dialog')).not.toBeInTheDocument();
      });

      await user.click(screen.getByTestId('command-palette-invite-bot-action'));

      expect(screen.getByTestId<HTMLInputElement>('notetaker-meeting-url-input').value).toBe('');
    });

    it('on mutation error, keeps the invite dialog open and shows a non-empty inline error message', async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      const { mutate } = mockInviteMutation();
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);
      await user.type(screen.getByTestId('notetaker-meeting-url-input'), MEETING_URL);
      await user.click(screen.getByTestId('notetaker-invite-submit'));

      const [, options] = mutate.mock.calls[0] as [
        string,
        { onError?: (error: Error) => void } | undefined,
      ];
      act(() => {
        options?.onError?.(new Error('boom'));
      });

      expect(screen.getByTestId('notetaker-invite-dialog')).toBeInTheDocument();
      const errorMessage = screen.getByTestId('notetaker-invite-error');
      expect(errorMessage).toBeInTheDocument();
      expect(errorMessage.textContent).not.toBe('');
    });

    it('closing the invite dialog (Escape) resets its stale input without closing the outer command palette, and re-opening shows an empty input', async () => {
      window.localStorage.setItem(NOTETAKER_CONSENT_KEY, 'true');
      const user = userEvent.setup();
      renderPalette();

      await openPaletteAndClickInviteBot(user);
      await user.type(
        screen.getByTestId('notetaker-meeting-url-input'),
        'https://meet.google.com/stale-text',
      );

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByTestId('notetaker-invite-dialog')).not.toBeInTheDocument();
      });
      // Only the nested invite dialog should have closed -- the outer command
      // palette (a separate DialogRoot) must still be open, relying on
      // Radix's nested-Dialog behavior of Escape closing only the topmost
      // open Dialog.
      expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();

      await user.click(screen.getByTestId('command-palette-invite-bot-action'));

      expect(screen.getByTestId<HTMLInputElement>('notetaker-meeting-url-input').value).toBe('');
    });
  });
});
