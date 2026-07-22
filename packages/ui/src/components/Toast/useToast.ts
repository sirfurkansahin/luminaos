import { useCallback, useSyncExternalStore } from 'react';

import { dismissToast, getSnapshot, subscribe } from './toast.js';

import type { ToastInstance } from './toast.js';

export interface UseToastResult {
  toasts: ToastInstance[];
  dismiss: (id: string) => void;
}

export function useToast(): UseToastResult {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const dismiss = useCallback((id: string) => {
    dismissToast(id);
  }, []);

  return { toasts, dismiss };
}
