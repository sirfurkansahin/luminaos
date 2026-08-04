import { useCallback, useSyncExternalStore } from 'react';

function readObjectId(): string | undefined {
  const raw = new URLSearchParams(window.location.search).get('objectId');
  return raw === null ? undefined : raw;
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

export function useObjectIdParam(): {
  objectId: string | undefined;
  openObject: (objectId: string) => void;
  closeObject: () => void;
} {
  const objectId = useSyncExternalStore(subscribe, readObjectId, readObjectId);

  const openObject = useCallback((next: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('objectId', next);
    window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
    notify();
  }, []);

  const closeObject = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete('objectId');
    const query = params.toString();
    window.history.pushState(
      {},
      '',
      query.length > 0 ? `${window.location.pathname}?${query}` : window.location.pathname,
    );
    notify();
  }, []);

  return { objectId, openObject, closeObject };
}
