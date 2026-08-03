import { useCallback, useSyncExternalStore } from 'react';

export type ViewKind = 'list' | 'board' | 'table' | 'calendar' | 'timeline';

const VIEW_KINDS: ViewKind[] = ['list', 'board', 'table', 'calendar', 'timeline'];

function isViewKind(value: string | null): value is ViewKind {
  return value !== null && (VIEW_KINDS as string[]).includes(value);
}

function readView(): ViewKind {
  const raw = new URLSearchParams(window.location.search).get('view');
  return isViewKind(raw) ? raw : 'list';
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function useViewParam(): { view: ViewKind; setView: (next: ViewKind) => void } {
  const view = useSyncExternalStore(subscribe, readView, readView);

  const setView = useCallback((next: ViewKind) => {
    const params = new URLSearchParams(window.location.search);
    params.set('view', next);
    window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
    notify();
  }, []);

  return { view, setView };
}
