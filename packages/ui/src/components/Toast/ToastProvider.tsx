import * as ToastPrimitive from '@radix-ui/react-toast';
import { useEffect } from 'react';

import { resetToasts } from './toast.js';
import { Toast } from './ToastItem.js';
import styles from './ToastProvider.module.css';
import { useToast } from './useToast.js';

import type { ReactNode } from 'react';

export interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps): React.JSX.Element {
  const { toasts, dismiss } = useToast();

  // The provider owns the toasts it renders. If it unmounts (app teardown, or
  // a fresh provider remounting in an isolated test), clear the shared store
  // so stale toasts do not resurface under the next mounted provider.
  //
  // Caveat for future reuse: since the store is a singleton, ANY remount
  // (e.g. a route/layout change, or React StrictMode's dev double-invoke)
  // silently drops every in-flight toast with no trace. Fine for generic
  // notices today — if this is ever used for security-relevant notices
  // (auth/session-expiry warnings), reconsider clearing on unmount vs. an
  // explicit `dismissAll()` call instead.
  useEffect(() => {
    return () => {
      resetToasts();
    };
  }, []);

  return (
    <ToastPrimitive.Provider>
      {children}
      {toasts.map((instance) => (
        <Toast
          key={instance.id}
          toast={instance}
          onOpenChange={(open) => {
            if (!open) {
              dismiss(instance.id);
            }
          }}
        />
      ))}
      <ToastPrimitive.Viewport className={styles.viewport} />
    </ToastPrimitive.Provider>
  );
}
