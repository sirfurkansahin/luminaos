import { describe, expect, it } from 'vitest';

import { evaluateManifestGrant } from './evaluate-manifest-grant.js';

import type { AgentPermissionManifest } from './agent-permission-manifest.js';

/**
 * F3-T1 PR1 (RED step) — `evaluateManifestGrant`, the pure fail-closed
 * evaluator, per ADR-0035 Karar (c) and the spec's Kabul Kriterleri:
 *
 *   export function evaluateManifestGrant(
 *     manifest: AgentPermissionManifest | undefined,
 *     request: { actionType: string; objectType?: string; now: Date },
 *   ): boolean;
 *
 * Fail-closed truth table (mirrors `packages/memory`'s
 * `isAgentAllowedToAccessMemory` fail-closed discipline, extended to 3
 * dimensions per ADR-0035 §c):
 *   - `manifest === undefined`                                -> false
 *   - `manifest.revokedAt !== null`                            -> false (even
 *     if action/scope/window would otherwise all match)
 *   - `request.actionType` not in `manifest.actionTypes`       -> false
 *   - `dataScope.objectTypes` is a specific array (not 'all')
 *     and `request.objectType` is provided but absent from it  -> false
 *   - `dataScope.objectTypes === 'all'`                        -> scope check
 *     always passes, regardless of `request.objectType`
 *   - `request.objectType === undefined` (omitted)              -> scope
 *     check is SKIPPED regardless of scope contents
 *   - `timeWindow.startsAt !== null && request.now < startsAt`  -> false
 *   - `timeWindow.expiresAt !== null && request.now > expiresAt` -> false
 *   - `startsAt`/`expiresAt` both null (unbounded)               -> window
 *     check always passes
 *   - `request.now === startsAt` or `request.now === expiresAt`
 *     (boundary-exact) -> INCLUSIVE, window check passes (evaluator uses
 *     strict `<`/`>`, not `<=`/`>=`)
 *   - a fully valid manifest (not revoked, correct actionType, 'all' scope,
 *     `now` inside an unbounded or bounded-and-valid window) -> true
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/evaluate-manifest-grant.ts` (and its sibling
 * `packages/agent-runtime/src/agent-permission-manifest.ts`, the type this
 * file's fixtures are typed against).
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_IDENTIFIER = 'answer-question';
const NOW = new Date('2026-06-01T12:00:00.000Z');

function buildManifest(overrides: Partial<AgentPermissionManifest> = {}): AgentPermissionManifest {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: WORKSPACE_ID,
    agentIdentifier: AGENT_IDENTIFIER,
    dataScope: { objectTypes: 'all' },
    actionTypes: ['send-email'],
    timeWindow: { startsAt: null, expiresAt: null },
    grantedAt: new Date('2026-01-01T00:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

function buildRequest(
  overrides: Partial<{ actionType: string; objectType: string; now: Date }> = {},
): { actionType: string; objectType?: string; now: Date } {
  return {
    actionType: 'send-email',
    objectType: 'task',
    now: NOW,
    ...overrides,
  };
}

describe('evaluateManifestGrant — fail-closed default', () => {
  it('returns false when manifest is undefined (no grant row exists)', () => {
    expect(evaluateManifestGrant(undefined, buildRequest())).toBe(false);
  });
});

describe('evaluateManifestGrant — revocation always wins', () => {
  it('returns false when manifest.revokedAt is set, even though action/scope/window all otherwise match', () => {
    const manifest = buildManifest({
      revokedAt: new Date('2026-02-01T00:00:00.000Z'),
      dataScope: { objectTypes: 'all' },
      actionTypes: ['send-email'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    expect(evaluateManifestGrant(manifest, buildRequest())).toBe(false);
  });
});

describe('evaluateManifestGrant — action type check', () => {
  it('returns false when request.actionType is not in manifest.actionTypes', () => {
    const manifest = buildManifest({ actionTypes: ['read-calendar'] });

    expect(evaluateManifestGrant(manifest, buildRequest({ actionType: 'send-email' }))).toBe(false);
  });
});

describe('evaluateManifestGrant — data scope check', () => {
  it('returns false when objectTypes is a specific array not containing request.objectType', () => {
    const manifest = buildManifest({ dataScope: { objectTypes: ['note', 'meeting'] } });

    expect(evaluateManifestGrant(manifest, buildRequest({ objectType: 'task' }))).toBe(false);
  });

  it("returns true when objectTypes === 'all' and request.objectType is provided", () => {
    const manifest = buildManifest({ dataScope: { objectTypes: 'all' } });

    expect(evaluateManifestGrant(manifest, buildRequest({ objectType: 'task' }))).toBe(true);
  });

  it("returns true when objectTypes === 'all' and request.objectType is omitted", () => {
    const manifest = buildManifest({ dataScope: { objectTypes: 'all' } });

    expect(evaluateManifestGrant(manifest, { actionType: 'send-email', now: NOW })).toBe(true);
  });

  it('skips the scope check entirely when request.objectType is omitted, even with a specific (non-all) scope array', () => {
    const manifest = buildManifest({ dataScope: { objectTypes: ['note', 'meeting'] } });

    expect(evaluateManifestGrant(manifest, { actionType: 'send-email', now: NOW })).toBe(true);
  });

  it('returns true when objectTypes is a specific array that DOES contain request.objectType', () => {
    const manifest = buildManifest({ dataScope: { objectTypes: ['task', 'note'] } });

    expect(evaluateManifestGrant(manifest, buildRequest({ objectType: 'task' }))).toBe(true);
  });
});

describe('evaluateManifestGrant — time window check', () => {
  it('returns false when timeWindow.startsAt is non-null and request.now < startsAt', () => {
    const manifest = buildManifest({
      timeWindow: { startsAt: new Date('2026-07-01T00:00:00.000Z'), expiresAt: null },
    });

    expect(evaluateManifestGrant(manifest, buildRequest({ now: NOW }))).toBe(false);
  });

  it('returns false when timeWindow.expiresAt is non-null and request.now > expiresAt', () => {
    const manifest = buildManifest({
      timeWindow: { startsAt: null, expiresAt: new Date('2026-01-01T00:00:00.000Z') },
    });

    expect(evaluateManifestGrant(manifest, buildRequest({ now: NOW }))).toBe(false);
  });

  it('returns true when startsAt and expiresAt are both null (unbounded window)', () => {
    const manifest = buildManifest({ timeWindow: { startsAt: null, expiresAt: null } });

    expect(evaluateManifestGrant(manifest, buildRequest({ now: NOW }))).toBe(true);
  });

  it('returns true when request.now is exactly equal to startsAt (inclusive boundary)', () => {
    const startsAt = new Date('2026-06-01T12:00:00.000Z');
    const manifest = buildManifest({ timeWindow: { startsAt, expiresAt: null } });

    expect(evaluateManifestGrant(manifest, buildRequest({ now: startsAt }))).toBe(true);
  });

  it('returns true when request.now is exactly equal to expiresAt (inclusive boundary)', () => {
    const expiresAt = new Date('2026-06-01T12:00:00.000Z');
    const manifest = buildManifest({ timeWindow: { startsAt: null, expiresAt } });

    expect(evaluateManifestGrant(manifest, buildRequest({ now: expiresAt }))).toBe(true);
  });

  it('returns true when request.now is strictly inside a bounded, valid window', () => {
    const manifest = buildManifest({
      timeWindow: {
        startsAt: new Date('2026-05-01T00:00:00.000Z'),
        expiresAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    });

    expect(evaluateManifestGrant(manifest, buildRequest({ now: NOW }))).toBe(true);
  });
});

describe('evaluateManifestGrant — fully valid grant', () => {
  it("returns true for a non-revoked manifest with a matching actionType, 'all' scope, and an unbounded window", () => {
    const manifest = buildManifest({
      revokedAt: null,
      actionTypes: ['send-email', 'read-calendar'],
      dataScope: { objectTypes: 'all' },
      timeWindow: { startsAt: null, expiresAt: null },
    });

    expect(
      evaluateManifestGrant(manifest, buildRequest({ actionType: 'send-email', now: NOW })),
    ).toBe(true);
  });
});
