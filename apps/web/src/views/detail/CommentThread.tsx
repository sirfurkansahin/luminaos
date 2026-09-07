import { useRef, useState } from 'react';

import { Button, EmptyState, Skeleton, Textarea } from '@luminaos/ui';

import { useAgentsQuery } from '../../hooks/useAgentsQuery.js';
import { useCommentsQuery, usePostCommentMutation } from '../../hooks/useCommentsQuery.js';

import type { Comment } from '../../lib/apiClient.js';
import type { KeyboardEvent } from 'react';

/**
 * F3-T3 PR7a (ADR-0037 §c/§h) -- object comment thread + @mention autocomplete
 * composer. Combines `AutomationHistoryPanel.tsx`'s plain-list-no-dialog
 * top-level states with `ChecklistWidget.tsx`'s "list + bottom composer,
 * clear draft on submit" shape.
 */
export interface CommentThreadProps {
  workspaceId: string;
  objectId: string;
}

interface MentionQuery {
  atIndex: number;
  endIndex: number;
  partial: string;
}

// Finds the LAST '@' in `draft` and the "word" that follows it (up to the
// next whitespace character, inclusive of consuming that one whitespace
// character, or the end of the draft if there is none) -- this is the
// "@handle" segment a click-to-select replaces, regardless of how much text
// has been typed after it.
function findMentionQuery(draft: string): MentionQuery | undefined {
  const atIndex = draft.lastIndexOf('@');
  if (atIndex === -1) {
    return undefined;
  }
  const afterAt = draft.slice(atIndex + 1);
  const whitespaceMatch = /\s/.exec(afterAt);
  const partial = whitespaceMatch !== null ? afterAt.slice(0, whitespaceMatch.index) : afterAt;
  const endIndex =
    whitespaceMatch !== null ? atIndex + 1 + whitespaceMatch.index + 1 : draft.length;
  return { atIndex, endIndex, partial };
}

function CommentRow({ comment }: { comment: Comment }) {
  const isAgentAuthored = comment.authorActor.type === 'agent';
  return (
    <li data-testid={`comment-item-${comment.id}`}>
      {isAgentAuthored ? 'Ajan: ' : ''}
      {comment.body}
    </li>
  );
}

export function CommentThread({ workspaceId, objectId }: CommentThreadProps) {
  const { data, isLoading, isError } = useCommentsQuery(workspaceId, objectId);
  const agentsQuery = useAgentsQuery(workspaceId);
  const postMutation = usePostCommentMutation(workspaceId, objectId);

  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submitDraft(): void {
    const text = draft.trim();
    if (text === '') {
      return;
    }
    postMutation.mutate(text);
    setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    }
  }

  const activeAgents = (agentsQuery.data?.agents ?? []).filter(
    (agent) => agent.lifecycle === 'active',
  );
  const mentionQuery = findMentionQuery(draft);
  const suggestions =
    mentionQuery !== undefined
      ? activeAgents.filter((agent) =>
          agent.name.toLowerCase().startsWith(mentionQuery.partial.toLowerCase()),
        )
      : [];

  function handleSelectSuggestion(agentName: string): void {
    if (mentionQuery === undefined) {
      return;
    }
    const nextDraft =
      draft.slice(0, mentionQuery.atIndex) + `@${agentName} ` + draft.slice(mentionQuery.endIndex);
    setDraft(nextDraft);
    textareaRef.current?.focus();
  }

  function renderComposer(): React.JSX.Element {
    return (
      <div>
        <Textarea
          ref={textareaRef}
          data-testid="comment-composer-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        {suggestions.length > 0 ? (
          <ul data-testid="comment-mention-suggestions" aria-label="Bahsetme önerileri">
            {suggestions.map((agent) => (
              <li key={agent.id}>
                <Button
                  type="button"
                  data-testid={`comment-mention-suggestion-${agent.id}`}
                  onClick={() => {
                    handleSelectSuggestion(agent.name);
                  }}
                >
                  {agent.name}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <Button
          type="button"
          data-testid="comment-composer-submit"
          onClick={() => {
            submitDraft();
          }}
        >
          Gönder
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="comment-thread-loading">
        <Skeleton height={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        data-testid="comment-thread-error"
        title="Bir hata oluştu"
        description="Yorumlar yüklenirken bir sorun oluştu. Lütfen tekrar deneyin."
      />
    );
  }

  const comments = data?.comments ?? [];

  return (
    <>
      {comments.length === 0 ? (
        <EmptyState
          data-testid="comment-thread-empty"
          title="Henüz yorum yok"
          description="Bu nesne için henüz bir yorum yapılmadı."
        />
      ) : (
        <ul aria-label="Yorumlar">
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </ul>
      )}
      {renderComposer()}
    </>
  );
}
