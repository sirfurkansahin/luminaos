import * as ToastPrimitive from '@radix-ui/react-toast';

import styles from './ToastItem.module.css';

import type { ToastInstance } from './toast.js';

export interface ToastProps {
  toast: ToastInstance;
  onOpenChange?: (open: boolean) => void;
}

export function Toast({ toast, onOpenChange }: ToastProps): React.JSX.Element {
  const classNames = [styles.root, styles[toast.variant]].filter(Boolean).join(' ');

  return (
    <ToastPrimitive.Root
      className={classNames}
      open
      duration={toast.duration}
      // Spread conditionally rather than `onOpenChange={onOpenChange}`: the
      // destructured value is typed `T | undefined` (it's an optional prop),
      // and under this repo's `exactOptionalPropertyTypes` that can't be
      // assigned directly to Radix's own (merely-optional) `onOpenChange`
      // prop — only including the key when a handler is actually present
      // avoids ever setting it to an explicit `undefined`.
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {toast.title !== undefined && (
        <ToastPrimitive.Title className={styles.title}>{toast.title}</ToastPrimitive.Title>
      )}
      {toast.description !== undefined && (
        <ToastPrimitive.Description className={styles.description}>
          {toast.description}
        </ToastPrimitive.Description>
      )}
      <ToastPrimitive.Close className={styles.close} aria-label="Close">
        ×
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
