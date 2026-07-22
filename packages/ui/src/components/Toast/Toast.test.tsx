import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from './toast.js';
import { ToastProvider } from './ToastProvider.js';

/**
 * Contract under test (not yet implemented — implementer must build the
 * following files to satisfy these tests, and add `@radix-ui/react-toast` as
 * a dependency). Toast is structurally different from the other 6 Radix
 * components: it is not a set of re-exported compound parts a caller
 * composes per-usage, it is an imperative push API backed by one
 * app-level provider.
 *
 *   // toast.ts — module-level imperative API + store, callable from
 *   // anywhere (not just inside a React component), similar in spirit to
 *   // sonner/react-hot-toast's `toast()`:
 *   interface ToastOptions {
 *     title?: string;
 *     description?: string;
 *     variant?: 'default' | 'success' | 'warning' | 'danger'; // default 'default'
 *     duration?: number; // ms; default 5000
 *   }
 *   interface ToastInstance extends ToastOptions { id: string; }
 *   function toast(options: ToastOptions): string; // returns the generated id,
 *       // pushes the instance into a module-level subscribable store that
 *       // ToastProvider (below) subscribes to.
 *
 *   // useToast.ts:
 *   interface UseToastResult { toasts: ToastInstance[]; dismiss: (id: string) => void; }
 *   function useToast(): UseToastResult;
 *
 *   // ToastProvider.tsx — mounted once near the app root:
 *   interface ToastProviderProps { children: ReactNode; }
 *   function ToastProvider({ children }: ToastProviderProps): JSX.Element;
 *       // Wraps Radix Toast.Provider, subscribes to the toast.ts store, renders
 *       // one <Toast> per queued instance, and Radix's Toast.Viewport.
 *
 *   // Toast.tsx — renders a single toast instance:
 *   interface ToastProps {
 *     toast: ToastInstance;
 *     onOpenChange?: (open: boolean) => void;
 *   }
 *   function Toast({ toast, onOpenChange }: ToastProps): JSX.Element;
 *       // Renders Radix Toast.Root (open, onOpenChange, duration=toast.duration,
 *       // styles.root) > Toast.Title > Toast.Description > Toast.Close (an
 *       // accessible-name "Close" icon button). Radix's Toast.Root provides the
 *       // ARIA live-region announcement semantics (role="status"/aria-live) —
 *       // we do not hand-roll this.
 *
 * All wrapped Radix parts' props extend `Omit<ComponentPropsWithoutRef<typeof
 * Toast.X>, 'dangerouslySetInnerHTML'>` (security-reviewer requirement from
 * PR-A — user-supplied `title`/`description` text must render as text
 * children, never as raw HTML).
 *
 * Behavior under test:
 * - Calling the imperative `toast({ title, description })` function (from a
 *   plain event handler, proving it does not require the `useToast()` hook)
 *   renders a toast with that title/description text.
 * - The rendered toast is discoverable via an ARIA live-region role
 *   (`role="status"`, per Radix's own rendered output).
 * - Activating the toast's close control removes it from the DOM.
 * - With fake timers, a toast auto-dismisses after its configured `duration`.
 */

function TriggerButton({ duration }: { duration?: number }) {
  return (
    <button
      type="button"
      onClick={() => {
        toast({ title: 'Saved', description: 'Your changes have been saved.', duration });
      }}
    >
      Show toast
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  it('renders a toast with title/description text after calling the imperative toast() function', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TriggerButton />
      </ToastProvider>,
    );

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show toast' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Your changes have been saved.')).toBeInTheDocument();
  });

  it('exposes the rendered toast via an ARIA live-region role (status)', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TriggerButton />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Show toast' }));

    const region = await screen.findByRole('status');
    expect(region).toHaveTextContent('Saved');
  });

  it('removes the toast from the DOM when its close control is activated', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TriggerButton />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Show toast' }));
    await screen.findByText('Saved');

    await user.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => {
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    });
  });

  it('auto-dismisses after the configured duration', async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <TriggerButton duration={1000} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Show toast' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();

    vi.advanceTimersByTime(1500);

    await waitFor(() => {
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    });
  });
});
