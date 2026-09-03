import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { assertValidManifestGrant } from './permission-manifest-commands.js';

import type { AgentDataScope, AgentTimeWindow } from './agent-permission-manifest.js';

/**
 * F3-T1 PR1 (RED step) — `assertValidManifestGrant`, the pure validator
 * guarding `AgentPermissionGranted` writes, per ADR-0035 Karar (c) and the
 * spec's Kabul Kriterleri ("boş `actionTypes`, boş `objectTypes` dizisi,
 * `startsAt >= expiresAt` gibi geçersiz girdileri reddeder"):
 *
 *   export function assertValidManifestGrant(input: {
 *     actionTypes: string[];
 *     dataScope: AgentDataScope;
 *     timeWindow: AgentTimeWindow;
 *   }): void;
 *
 * Throws `ValidationError` (mirrors `packages/automation`'s
 * `trigger-commands.ts` assertion pattern — `@luminaos/shared`'s
 * `ValidationError`, thrown directly, never a bare `Error`) on:
 *   - an empty `actionTypes` array
 *   - `dataScope.objectTypes` being an empty array `[]` (NOT the `'all'`
 *     sentinel, which is always valid regardless of length)
 *   - `timeWindow.startsAt >= timeWindow.expiresAt` when both are non-null
 *
 * Does NOT throw for a fully valid input, an unbounded window (both
 * `startsAt`/`expiresAt` null), a `startsAt < expiresAt` bounded window, or
 * `dataScope.objectTypes === 'all'`.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/permission-manifest-commands.ts` (and its
 * sibling `packages/agent-runtime/src/agent-permission-manifest.ts`).
 */

interface ManifestGrantInput {
  actionTypes: string[];
  dataScope: AgentDataScope;
  timeWindow: AgentTimeWindow;
}

function buildInput(overrides: Partial<ManifestGrantInput> = {}): ManifestGrantInput {
  return {
    actionTypes: ['send-email'],
    dataScope: { objectTypes: 'all' },
    timeWindow: { startsAt: null, expiresAt: null },
    ...overrides,
  };
}

describe('assertValidManifestGrant — actionTypes', () => {
  it('throws ValidationError when actionTypes is an empty array', () => {
    expect(() => assertValidManifestGrant(buildInput({ actionTypes: [] }))).toThrow(
      ValidationError,
    );
  });

  it('does not throw when actionTypes has at least one entry', () => {
    expect(() =>
      assertValidManifestGrant(buildInput({ actionTypes: ['send-email'] })),
    ).not.toThrow();
  });
});

describe('assertValidManifestGrant — dataScope', () => {
  it('throws ValidationError when dataScope.objectTypes is an empty array (not the "all" sentinel)', () => {
    expect(() => assertValidManifestGrant(buildInput({ dataScope: { objectTypes: [] } }))).toThrow(
      ValidationError,
    );
  });

  it('does not throw when dataScope.objectTypes is "all"', () => {
    expect(() =>
      assertValidManifestGrant(buildInput({ dataScope: { objectTypes: 'all' } })),
    ).not.toThrow();
  });

  it('does not throw when dataScope.objectTypes is a non-empty specific array', () => {
    expect(() =>
      assertValidManifestGrant(buildInput({ dataScope: { objectTypes: ['task', 'note'] } })),
    ).not.toThrow();
  });
});

describe('assertValidManifestGrant — timeWindow', () => {
  it('throws ValidationError when startsAt === expiresAt (both non-null)', () => {
    const sameInstant = new Date('2026-06-01T00:00:00.000Z');
    expect(() =>
      assertValidManifestGrant(
        buildInput({ timeWindow: { startsAt: sameInstant, expiresAt: sameInstant } }),
      ),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when startsAt > expiresAt (both non-null)', () => {
    expect(() =>
      assertValidManifestGrant(
        buildInput({
          timeWindow: {
            startsAt: new Date('2026-07-01T00:00:00.000Z'),
            expiresAt: new Date('2026-06-01T00:00:00.000Z'),
          },
        }),
      ),
    ).toThrow(ValidationError);
  });

  it('does not throw when startsAt < expiresAt (both non-null)', () => {
    expect(() =>
      assertValidManifestGrant(
        buildInput({
          timeWindow: {
            startsAt: new Date('2026-06-01T00:00:00.000Z'),
            expiresAt: new Date('2026-07-01T00:00:00.000Z'),
          },
        }),
      ),
    ).not.toThrow();
  });

  it('does not throw when startsAt and expiresAt are both null (unbounded window is valid)', () => {
    expect(() =>
      assertValidManifestGrant(buildInput({ timeWindow: { startsAt: null, expiresAt: null } })),
    ).not.toThrow();
  });

  it('does not throw when only startsAt is set (expiresAt null)', () => {
    expect(() =>
      assertValidManifestGrant(
        buildInput({
          timeWindow: { startsAt: new Date('2026-06-01T00:00:00.000Z'), expiresAt: null },
        }),
      ),
    ).not.toThrow();
  });

  it('does not throw when only expiresAt is set (startsAt null)', () => {
    expect(() =>
      assertValidManifestGrant(
        buildInput({
          timeWindow: { startsAt: null, expiresAt: new Date('2026-07-01T00:00:00.000Z') },
        }),
      ),
    ).not.toThrow();
  });
});

describe('assertValidManifestGrant — fully valid input', () => {
  it('does not throw for a fully valid grant input', () => {
    expect(() =>
      assertValidManifestGrant(
        buildInput({
          actionTypes: ['send-email', 'read-calendar'],
          dataScope: { objectTypes: 'all' },
          timeWindow: {
            startsAt: new Date('2026-06-01T00:00:00.000Z'),
            expiresAt: new Date('2026-07-01T00:00:00.000Z'),
          },
        }),
      ),
    ).not.toThrow();
  });
});
