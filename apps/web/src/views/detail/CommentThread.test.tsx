import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentThread as CommentThreadModuleExport } from './CommentThread.js';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * F3-T3 PR7a (ADR-0037 §c/§h) — TDD red step. Contract under test (not yet
 * implemented — implementer must build
 * apps/web/src/views/detail/CommentThread.tsx to satisfy these tests):
 *
 *   export interface CommentThreadProps { workspaceId: string; objectId: string; }
 *   export function CommentThread(props: CommentThreadProps): React.JSX.Element;
 *
 * Fetches its OWN data via `useCommentsQuery(workspaceId, objectId)`
 * (../../hooks/useCommentsQuery.ts, mocked wholesale below) AND
 * `useAgentsQuery(workspaceId)` (../../hooks/useAgentsQuery.ts, mocked
 * wholesale below — needed only for @mention autocomplete candidates, does
 * NOT gate the thread's own loading/error/empty states).
 *
 * Top-level states, keyed OFF `useCommentsQuery`'s `{ data, isLoading,
 * isError }` only:
 *   - isLoading -> data-testid="comment-thread-loading"
 *   - isError -> data-testid="comment-thread-error"
 *   - data.comments.length === 0 -> data-testid="comment-thread-empty" (the
 *     composer below is STILL rendered in this state, so a user can post the
 *     first comment)
 *   - otherwise -> `<ul aria-label="Yorumlar">`, one `<li data-testid=
 *     "comment-item-<id>">` PER comment, in the SAME order as
 *     `data.comments` (no client-side re-sorting). Each row's text content
 *     includes the comment's `body`. When `authorActor.type === 'agent'`,
 *     the row's text is prefixed with "Ajan: " (e.g. "Ajan: <body>"); a
 *     `'user'`-authored row has NO such prefix anywhere in its text.
 *
 * The composer (rendered in EVERY state except loading/error -- i.e.
 * whenever the object id is known and the comments query has resolved,
 * whether empty or non-empty):
 *   - `@luminaos/ui` `Textarea` data-testid="comment-composer-input"
 *   - `@luminaos/ui` `Button` data-testid="comment-composer-submit", Turkish
 *     label containing "Gönder"
 *   - submitting (button click, OR pressing Enter WITHOUT Shift inside the
 *     textarea -- Shift+Enter must NOT submit, it inserts a newline) with a
 *     non-empty/non-whitespace draft calls `usePostCommentMutation(
 *     workspaceId, objectId)`'s `mutate` with EXACTLY the trimmed draft
 *     string, then clears the draft back to ''.
 *   - submitting with an empty/whitespace-only draft is a no-op (mutate NOT
 *     called, draft left as-is).
 *
 * @mention autocomplete (ADR-0037 §h): as the user types, if the substring
 * from the LAST unclosed '@' (i.e. an '@' with no whitespace after it up to
 * the cursor/end) to the end of the draft is a case-insensitive PREFIX of an
 * ACTIVE agent's `name` (agents from `useAgentsQuery`, filtered to
 * `lifecycle === 'active'` -- deactivated agents are never suggested), show:
 *   - `<... data-testid="comment-mention-suggestions">` wrapping one
 *     `data-testid="comment-mention-suggestion-<agentId>"` per matching
 *     agent (agent's `name` visible as its text).
 *   - clicking a suggestion replaces ONLY that trailing partial `@handle`
 *     segment of the draft with `@<agent.name> ` (full name + ONE trailing
 *     space), leaving any text before the '@' untouched, and refocuses the
 *     composer textarea (`document.activeElement` becomes the textarea).
 * No suggestions are shown when the draft has no unclosed '@', or when the
 * trailing partial after '@' matches no active agent's name prefix.
 *
 * `useCommentsQuery`/`usePostCommentMutation`
 * (../../hooks/useCommentsQuery.ts) and `useAgentsQuery`
 * (../../hooks/useAgentsQuery.ts) do not exist yet, so — mirroring
 * `AutomationHistoryPanel.test.tsx`'s handling of the equally-not-yet-existing
 * `useProposalsQuery` hooks — mock functions are created via `vi.hoisted` and
 * referenced ONLY by closure inside the `vi.mock` factories below; this file
 * never imports either hook module itself. The `Comment`/`Agent` shapes are
 * declared locally for the same reason. `./CommentThread.tsx` itself DOES
 * NOT exist yet either — imported directly (`ModuleExport` cast), so this
 * test file is expected to fail to even resolve that import until the
 * component exists — the documented TDD red state.
 */

interface Comment {
  id: string;
  workspaceId: string;
  objectId: string;
  authorActor: { type: 'user' | 'agent'; id: string };
  body: string;
  mentionedAgentIds: string[];
  createdAt: string;
}

interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  agentIdentifier: string;
  lifecycle: 'active' | 'deactivated';
  createdAt: string;
}

const { mockedUseCommentsQuery, mockedUsePostCommentMutation, mockedUseAgentsQuery } = vi.hoisted(
  () => {
    return {
      mockedUseCommentsQuery: vi.fn(),
      mockedUsePostCommentMutation: vi.fn(),
      mockedUseAgentsQuery: vi.fn(),
    };
  },
);

vi.mock('../../hooks/useCommentsQuery.js', () => ({
  useCommentsQuery: mockedUseCommentsQuery,
  usePostCommentMutation: mockedUsePostCommentMutation,
}));

vi.mock('../../hooks/useAgentsQuery.js', () => ({
  useAgentsQuery: mockedUseAgentsQuery,
}));

const CommentThread = CommentThreadModuleExport;

const workspaceId = 'ws-1';
const objectId = 'obj-1';

function makeCommentFixture(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1',
    workspaceId,
    objectId,
    authorActor: { type: 'user', id: 'user-1' },
    body: 'Merhaba dünya',
    mentionedAgentIds: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAgentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    workspaceId,
    name: 'ReportBot',
    agentIdentifier: 'report-bot@luminaos.internal',
    lifecycle: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockCommentsQuery(
  data: { comments: Comment[] } | undefined,
  overrides: Partial<UseQueryResult<{ comments: Comment[] }>> = {},
): void {
  mockedUseCommentsQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function mockAgentsQuery(agents: Agent[]): void {
  mockedUseAgentsQuery.mockReturnValue({
    data: { agents },
    isLoading: false,
    isError: false,
    error: null,
  });
}

function mockPostMutation(): { postMutate: ReturnType<typeof vi.fn> } {
  const postMutate = vi.fn();
  mockedUsePostCommentMutation.mockReturnValue({
    mutate: postMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: 'idle',
  });
  return { postMutate };
}

function setupDefault(
  comments: Comment[] = [],
  agents: Agent[] = [],
): {
  postMutate: ReturnType<typeof vi.fn>;
} {
  mockCommentsQuery({ comments });
  mockAgentsQuery(agents);
  return mockPostMutation();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CommentThread', () => {
  it('renders a loading state (data-testid="comment-thread-loading") while the comments query is loading', () => {
    mockCommentsQuery(undefined, { isLoading: true });
    mockAgentsQuery([]);
    mockPostMutation();

    render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);

    expect(screen.getByTestId('comment-thread-loading')).toBeInTheDocument();
  });

  it('renders an error state (data-testid="comment-thread-error") when the comments query isError', () => {
    mockCommentsQuery(undefined, { isError: true, error: new Error('boom') });
    mockAgentsQuery([]);
    mockPostMutation();

    render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);

    expect(screen.getByTestId('comment-thread-error')).toBeInTheDocument();
  });

  it('renders an empty state (data-testid="comment-thread-empty") when there are zero comments, but still renders the composer', () => {
    setupDefault([]);

    render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);

    expect(screen.getByTestId('comment-thread-empty')).toBeInTheDocument();
    expect(screen.getByTestId('comment-composer-input')).toBeInTheDocument();
    expect(screen.getByTestId('comment-composer-submit')).toBeInTheDocument();
  });

  it('renders one row per comment, in the same order as the data, each showing its body', () => {
    const first = makeCommentFixture({ id: 'comment-1', body: 'İlk yorum' });
    const second = makeCommentFixture({ id: 'comment-2', body: 'İkinci yorum' });
    setupDefault([first, second]);

    render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);

    const rows = screen.getAllByTestId(/^comment-item-comment-\d$/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'comment-item-comment-1',
      'comment-item-comment-2',
    ]);
    expect(rows[0]).toHaveTextContent('İlk yorum');
    expect(rows[1]).toHaveTextContent('İkinci yorum');
  });

  it('prefixes an agent-authored comment row with "Ajan: "', () => {
    const agentComment = makeCommentFixture({
      id: 'comment-agent-1',
      authorActor: { type: 'agent', id: 'agent-1' },
      body: 'Görev tamamlandı olarak işaretlendi',
    });
    setupDefault([agentComment]);

    render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);

    const row = screen.getByTestId('comment-item-comment-agent-1');
    expect(row).toHaveTextContent('Ajan:');
    expect(row).toHaveTextContent('Görev tamamlandı olarak işaretlendi');
  });

  it('does NOT prefix a user-authored comment row with "Ajan: "', () => {
    const userComment = makeCommentFixture({
      id: 'comment-user-1',
      authorActor: { type: 'user', id: 'user-1' },
      body: 'Normal bir yorum',
    });
    setupDefault([userComment]);

    render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);

    const row = screen.getByTestId('comment-item-comment-user-1');
    expect(row.textContent).not.toContain('Ajan:');
  });

  describe('composer', () => {
    it('does not call the post mutation when submitting an empty/whitespace-only draft via the submit button', async () => {
      const { postMutate } = setupDefault([]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      await user.type(screen.getByTestId('comment-composer-input'), '   ');
      await user.click(screen.getByTestId('comment-composer-submit'));

      expect(postMutate).not.toHaveBeenCalled();
    });

    it('calls the post mutation with the typed body when the submit button is clicked', async () => {
      const { postMutate } = setupDefault([]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      await user.type(screen.getByTestId('comment-composer-input'), 'Merhaba ekip');
      await user.click(screen.getByTestId('comment-composer-submit'));

      expect(postMutate).toHaveBeenCalledWith('Merhaba ekip');
    });

    it('clears the composer draft after a successful submit', async () => {
      setupDefault([]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      const input = screen.getByTestId('comment-composer-input');
      await user.type(input, 'Merhaba ekip');
      await user.click(screen.getByTestId('comment-composer-submit'));

      expect(input).toHaveValue('');
    });

    it('pressing Enter (without Shift) inside the composer submits the draft', async () => {
      const { postMutate } = setupDefault([]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      await user.type(screen.getByTestId('comment-composer-input'), 'Merhaba ekip{Enter}');

      expect(postMutate).toHaveBeenCalledWith('Merhaba ekip');
    });

    it('pressing Shift+Enter inside the composer does NOT submit -- it inserts a newline instead', async () => {
      const { postMutate } = setupDefault([]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      const input = screen.getByTestId('comment-composer-input');
      await user.type(input, 'Birinci satır{Shift>}{Enter}{/Shift}İkinci satır');

      expect(postMutate).not.toHaveBeenCalled();
      expect(input).toHaveValue('Birinci satır\nİkinci satır');
    });
  });

  describe('@mention autocomplete', () => {
    it('shows no suggestions dropdown when the draft has no unclosed "@"', async () => {
      setupDefault([], [makeAgentFixture({ id: 'agent-1', name: 'ReportBot' })]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      await user.type(screen.getByTestId('comment-composer-input'), 'Merhaba ekip');

      expect(screen.queryByTestId('comment-mention-suggestions')).not.toBeInTheDocument();
    });

    it('shows matching suggestions (case-insensitive prefix) for an active agent when typing "@" + a partial name', async () => {
      setupDefault(
        [],
        [
          makeAgentFixture({ id: 'agent-1', name: 'ReportBot' }),
          makeAgentFixture({ id: 'agent-2', name: 'Scheduler' }),
        ],
      );
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      await user.type(screen.getByTestId('comment-composer-input'), 'Hey @rep');

      expect(screen.getByTestId('comment-mention-suggestions')).toBeInTheDocument();
      expect(screen.getByTestId('comment-mention-suggestion-agent-1')).toBeInTheDocument();
      expect(screen.queryByTestId('comment-mention-suggestion-agent-2')).not.toBeInTheDocument();
    });

    it('excludes deactivated agents from mention suggestions even if their name matches', async () => {
      setupDefault(
        [],
        [makeAgentFixture({ id: 'agent-old', name: 'OldBot', lifecycle: 'deactivated' })],
      );
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      await user.type(screen.getByTestId('comment-composer-input'), '@Old');

      expect(screen.queryByTestId('comment-mention-suggestions')).not.toBeInTheDocument();
    });

    it('shows no suggestions when the trailing partial after "@" matches no active agent name', async () => {
      setupDefault([], [makeAgentFixture({ id: 'agent-1', name: 'ReportBot' })]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      await user.type(screen.getByTestId('comment-composer-input'), '@zzz');

      expect(screen.queryByTestId('comment-mention-suggestions')).not.toBeInTheDocument();
    });

    it('clicking a suggestion replaces the trailing partial @handle with the full "@AgentName " and refocuses the composer', async () => {
      setupDefault([], [makeAgentFixture({ id: 'agent-1', name: 'ReportBot' })]);
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      const input = screen.getByTestId('comment-composer-input');
      await user.type(input, 'Hey @rep');
      await user.click(screen.getByTestId('comment-mention-suggestion-agent-1'));

      expect(input).toHaveValue('Hey @ReportBot ');
      expect(document.activeElement).toBe(input);
    });

    it('clicking a suggestion only replaces the trailing @handle segment, leaving preceding text untouched', async () => {
      setupDefault(
        [],
        [
          makeAgentFixture({ id: 'agent-1', name: 'ReportBot' }),
          makeAgentFixture({ id: 'agent-2', name: 'Scheduler' }),
        ],
      );
      const user = userEvent.setup();

      render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);
      const input = screen.getByTestId('comment-composer-input');
      await user.type(input, 'Selam ekip, @sch lütfen bak');
      await user.click(screen.getByTestId('comment-mention-suggestion-agent-2'));

      expect(input).toHaveValue('Selam ekip, @Scheduler  lütfen bak'.replace('  ', ' '));
    });
  });

  it('sources identity from the workspaceId/objectId props -- every hook is called with exactly those values', () => {
    setupDefault([]);

    render(<CommentThread workspaceId={workspaceId} objectId={objectId} />);

    expect(mockedUseCommentsQuery).toHaveBeenCalledWith(workspaceId, objectId);
    expect(mockedUseAgentsQuery).toHaveBeenCalledWith(workspaceId);
    expect(mockedUsePostCommentMutation).toHaveBeenCalledWith(workspaceId, objectId);
  });
});
