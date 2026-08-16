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
}

/**
 * `./workspace-context.ts` genuinely does not exist ANYWHERE on disk yet --
 * this dynamic import is EXPECTED to fail Vite's module-resolution at
 * collection time (reporting this file as "0 test" / a failed suite, not a
 * per-assertion failure) until `implementer` creates it. That
 * whole-suite-unresolved state IS this file's RED signal.
 */
async function importWorkspaceContextModule(): Promise<WorkspaceContextModuleLike> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- RED step: apps/desktop/src/workspace-context.ts does not exist yet.
  return (await import('./workspace-context')) as unknown as WorkspaceContextModuleLike;
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
