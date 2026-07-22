export type ToastVariant = 'default' | 'success' | 'warning' | 'danger';

// Every field is explicitly `| undefined` (not just optional) so callers can
// forward their own optional props (e.g. a component's own `duration?: number`
// prop, which TypeScript types as `number | undefined` once destructured)
// straight into `toast({ ...duration })` without tripping this repo's
// `exactOptionalPropertyTypes`.
export interface ToastOptions {
  title?: string | undefined;
  description?: string | undefined;
  variant?: ToastVariant | undefined;
  duration?: number | undefined;
}

// `toast()` below always resolves `variant`/`duration` to a concrete value
// (falling back to their defaults), so a queued instance never carries an
// explicit `undefined` for either — narrowing them to required here (rather
// than inheriting ToastOptions' optional versions) keeps consumers like
// ToastItem's `duration={toast.duration}` forward a definite `number` to
// Radix's own (merely-optional, `exactOptionalPropertyTypes`-sensitive) prop.
export interface ToastInstance extends Omit<ToastOptions, 'variant' | 'duration'> {
  id: string;
  variant: ToastVariant;
  duration: number;
}

type StoreListener = () => void;

const DEFAULT_DURATION_MS = 5000;

let toasts: ToastInstance[] = [];
const listeners = new Set<StoreListener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function subscribe(listener: StoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): ToastInstance[] {
  return toasts;
}

export function toast(options: ToastOptions): string {
  const id = generateId();
  const instance: ToastInstance = {
    ...options,
    variant: options.variant ?? 'default',
    duration: options.duration ?? DEFAULT_DURATION_MS,
    id,
  };
  toasts = [...toasts, instance];
  emit();
  return id;
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((instance) => instance.id !== id);
  emit();
}

// Clears every queued toast. Intended for a ToastProvider's unmount cleanup —
// a provider owns the toasts it renders, so when it goes away (e.g. app
// teardown, or a fresh provider remounting in an isolated test) any toasts it
// was displaying should not resurface under the next mounted provider.
export function resetToasts(): void {
  toasts = [];
  emit();
}
