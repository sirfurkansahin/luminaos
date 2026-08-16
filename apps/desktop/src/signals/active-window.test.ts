import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * RED-step test for ADR-0020-masaustu-sinyal-toplayicilar.md Karar (e)/(f)/(g)
 * — F2-T3 PR3 (masaüstü Tauri komutu + capability).
 *
 * Contract for `implementer` — `apps/desktop/src/signals/active-window.ts`
 * (does not exist yet, this import is expected to fail RED until it's
 * created):
 *
 * - Exports a named `getActiveWindowAppName(): Promise<string>` that calls
 *   `invoke('get_active_window_app_name')` (from `@tauri-apps/api/core`) and
 *   resolves with whatever string the backend command returns, unmodified.
 * - This is a thin IPC wrapper only — no HTTP/debounce-on-change logic here
 *   (that's ADR-0020 Karar c, PR4's `apps/desktop/src/` frontend-integration
 *   scope, layered on top of this helper).
 *
 * Per ADR-0020 §(i) "Test stratejisi" (a): frontend `invoke()` calls are
 * tested with `@tauri-apps/api/mocks`'s `mockIPC` — no real OS call, no
 * `cargo` build required, safe to run in this environment.
 */
/**
 * `./active-window.ts` doesn't exist yet -- same `*Like` escape hatch as
 * `apps/server/src/context/context.integration.test.ts`'s
 * `ContextGraphSyncWorkerLike`. The property is typed as a function value
 * (not an interface *method* signature) to avoid
 * `@typescript-eslint/unbound-method` once it's destructured below.
 */
interface ActiveWindowModuleLike {
  getActiveWindowAppName: () => Promise<string>;
}

/**
 * A genuinely-unresolved dynamic import (the module doesn't exist on disk
 * yet) type-checks as `any` under this repo's `projectService` ESLint setup
 * -- so the `as unknown as ActiveWindowModuleLike` assertion below is NOT
 * "unnecessary" in the sense that matters (it's the only thing standing
 * between every call site and an `any` cascade), even though TS's own
 * structural check would call it redundant. Both disabled rules resolve
 * themselves automatically -- no follow-up cleanup commit needed -- the
 * moment `implementer` creates `active-window.ts`.
 */
async function importActiveWindowModule(): Promise<ActiveWindowModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/signals/active-window.ts does not exist yet.
  return (await import('./active-window')) as unknown as ActiveWindowModuleLike;
}

describe('getActiveWindowAppName', () => {
  afterEach(() => {
    clearMocks();
  });

  it('invokes the "get_active_window_app_name" Tauri command and returns its result', async () => {
    const { getActiveWindowAppName } = await importActiveWindowModule();

    mockIPC((cmd) => {
      if (cmd === 'get_active_window_app_name') {
        return 'Code.exe';
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });

    await expect(getActiveWindowAppName()).resolves.toBe('Code.exe');
  });

  it('calls invoke with EXACTLY the command name "get_active_window_app_name" and no arguments', async () => {
    const { getActiveWindowAppName } = await importActiveWindowModule();

    const handler = vi.fn((cmd: string) => {
      if (cmd === 'get_active_window_app_name') {
        return 'firefox.exe';
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });
    mockIPC(handler);

    await getActiveWindowAppName();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe('get_active_window_app_name');
  });

  it('propagates a different mocked app name on a second call (proves it is not hardcoded)', async () => {
    const { getActiveWindowAppName } = await importActiveWindowModule();

    mockIPC((cmd) => {
      if (cmd === 'get_active_window_app_name') {
        return 'slack.exe';
      }
      throw new Error(`Unexpected invoke: ${cmd}`);
    });

    await expect(getActiveWindowAppName()).resolves.toBe('slack.exe');
  });
});
