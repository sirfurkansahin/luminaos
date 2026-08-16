import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * RED-step test for F2-T3 PR4 (ADR-0020) -- `apps/desktop/src/
 * workspace-context.ts` does not exist yet. Per the approved plan, this
 * task deliberately does NOT build a real workspace-selection UI (deferred
 * to F2-T3b, alongside real login) -- `getWorkspaceId()` is a thin,
 * synchronous read of a single `localStorage` key, nothing more.
 *
 * Contract for `implementer`:
 *
 *   export function getWorkspaceId(): string | null;
 *
 * Reads `localStorage.getItem('luminaos.workspaceId')` and returns it
 * verbatim -- `null` when unset, the stored string otherwise. No caching,
 * no validation, no default value.
 */

interface WorkspaceContextModuleLike {
  getWorkspaceId: () => string | null;
  setWorkspaceId: (id: string) => void;
}

/**
 * `./workspace-context.ts` genuinely does not exist ANYWHERE on disk yet --
 * this dynamic import is EXPECTED to fail Vite's module-resolution at
 * collection time (reporting this file as "0 test" / a failed suite, not a
 * per-assertion failure) until `implementer` creates it. That
 * whole-suite-unresolved state IS this file's RED signal.
 */
async function importWorkspaceContextModule(): Promise<WorkspaceContextModuleLike> {
  return await import('./workspace-context');
}

const STORAGE_KEY = 'luminaos.workspaceId';

describe('getWorkspaceId (F2-T3 PR4, ADR-0020 -- real workspace-selection UI deferred to F2-T3b)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null when "luminaos.workspaceId" is not set in localStorage', async () => {
    const { getWorkspaceId } = await importWorkspaceContextModule();
    expect(getWorkspaceId()).toBeNull();
  });

  it('returns the stored value when "luminaos.workspaceId" is set', async () => {
    localStorage.setItem(STORAGE_KEY, 'ws-42');
    const { getWorkspaceId } = await importWorkspaceContextModule();
    expect(getWorkspaceId()).toBe('ws-42');
  });

  it('reflects a value change without needing re-import (reads localStorage fresh on every call)', async () => {
    const { getWorkspaceId } = await importWorkspaceContextModule();
    expect(getWorkspaceId()).toBeNull();
    localStorage.setItem(STORAGE_KEY, 'ws-99');
    expect(getWorkspaceId()).toBe('ws-99');
    localStorage.removeItem(STORAGE_KEY);
    expect(getWorkspaceId()).toBeNull();
  });
});

/**
 * RED-step tests for F2-T3b's `setWorkspaceId` addition (see
 * `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, "HEDEF ŞEKİL" item 4)
 * -- `./workspace-context.ts` does not export a `setWorkspaceId` function
 * yet. This is the real workspace-selection write path that replaces manual
 * `localStorage.setItem('luminaos.workspaceId', ...)` (README's dev-only
 * step) with a real function `SessionContext`/`WorkspacePicker` call.
 *
 * Contract for `implementer`:
 *
 *   export function setWorkspaceId(id: string): void;
 *
 * Writes `localStorage.setItem('luminaos.workspaceId', id)` -- no
 * validation beyond that (the caller is responsible for passing a real
 * workspace id).
 */
describe('setWorkspaceId (F2-T3b)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('writes the given id under the "luminaos.workspaceId" localStorage key', async () => {
    const { setWorkspaceId } = await importWorkspaceContextModule();
    setWorkspaceId('ws-77');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('ws-77');
  });

  it('a value written by setWorkspaceId is immediately visible to getWorkspaceId', async () => {
    const { setWorkspaceId, getWorkspaceId } = await importWorkspaceContextModule();
    expect(getWorkspaceId()).toBeNull();
    setWorkspaceId('ws-88');
    expect(getWorkspaceId()).toBe('ws-88');
  });

  it('overwrites a previously stored workspace id', async () => {
    localStorage.setItem(STORAGE_KEY, 'ws-old');
    const { setWorkspaceId, getWorkspaceId } = await importWorkspaceContextModule();
    setWorkspaceId('ws-new');
    expect(getWorkspaceId()).toBe('ws-new');
  });
});
