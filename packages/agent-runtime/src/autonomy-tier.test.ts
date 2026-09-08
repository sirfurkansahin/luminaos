import { describe, expect, it } from 'vitest';

import { AUTONOMY_GOVERNANCE_FLOOR, AUTONOMY_TIER_RANK, isAutoDecidable } from './autonomy-tier.js';

import type { AutonomyTier } from './autonomy-tier.js';

/**
 * F3-T5 PR1 (RED step), ADR-0039 Karar (b)/(c) and the spec's PR1 Kabul
 * Kriterleri (`docs/specs/F3-E2/F3-T5-otonomi-kadrani.md`) —
 * `packages/agent-runtime/src/autonomy-tier.ts`. Mirrors `agent-action-
 * record.test.ts`'s house style: this file is scoped to the PIECE of that
 * module that has actual runtime behavior -- `isAutoDecidable`,
 * `AUTONOMY_TIER_RANK`, `AUTONOMY_GOVERNANCE_FLOOR` -- plus a switch-based
 * exhaustiveness canary over the 3-member `AutonomyTier` union (compile-time
 * lock-in, same `never`-typed default-branch pattern as `agent-action-
 * record.test.ts`'s `describeResourceKind`). `TaskAutonomySetting` itself is
 * a plain interface with zero runtime behavior -- nothing to unit-test about
 * its shape beyond what the exhaustiveness canary and the event-schema test
 * file (`autonomy-tier-events.test.ts`) already lock in.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/agent-runtime/src/autonomy-tier.ts`.
 */

describe('isAutoDecidable', () => {
  it.each([
    ['propose', false],
    ['approve_and_act', true],
    ['act_and_notify', true],
  ] as const)('isAutoDecidable(%s) === %s', (tier, expected) => {
    expect(isAutoDecidable(tier)).toBe(expected);
  });
});

describe('AUTONOMY_TIER_RANK', () => {
  it('has exactly the 3 expected AutonomyTier keys, no more no less', () => {
    expect(Object.keys(AUTONOMY_TIER_RANK).sort()).toEqual(
      ['act_and_notify', 'approve_and_act', 'propose'].sort(),
    );
  });

  it('ranks ascending propose < approve_and_act < act_and_notify', () => {
    expect(AUTONOMY_TIER_RANK.propose).toBeLessThan(AUTONOMY_TIER_RANK.approve_and_act);
    expect(AUTONOMY_TIER_RANK.approve_and_act).toBeLessThan(AUTONOMY_TIER_RANK.act_and_notify);
  });

  it('propose ranks 0 -- the single distinguished "human still decides" tier (ADR-0039 §b doc-comment)', () => {
    expect(AUTONOMY_TIER_RANK.propose).toBe(0);
  });
});

describe('AUTONOMY_GOVERNANCE_FLOOR', () => {
  it('contains exactly "reconfigureAgentPermissions" -- ADR-0039 Karar (c)\'s governance floor, no more no less', () => {
    expect(AUTONOMY_GOVERNANCE_FLOOR).toEqual(['reconfigureAgentPermissions']);
  });

  it('is a usable readonly membership check (.includes) for the one governance-floor action type', () => {
    expect(AUTONOMY_GOVERNANCE_FLOOR.includes('reconfigureAgentPermissions')).toBe(true);
    expect(AUTONOMY_GOVERNANCE_FLOOR.includes('createTask')).toBe(false);
  });
});

/**
 * Compile-time exhaustiveness check + a runtime canary that all 3
 * `AutonomyTier` members are individually narrowable. If a future
 * `AutonomyTier` member is added without updating this switch, the
 * `default` branch's `const exhaustiveCheck: never = tier` line fails to
 * typecheck -- this file (and `pnpm typecheck`) breaks loudly instead of
 * silently missing a case. Mirrors `agent-action-record.test.ts`'s
 * `describeResourceKind` pattern exactly.
 */
function describeTier(tier: AutonomyTier): string {
  switch (tier) {
    case 'propose':
      return 'propose';
    case 'approve_and_act':
      return 'approve_and_act';
    case 'act_and_notify':
      return 'act_and_notify';
    default: {
      const exhaustiveCheck: never = tier;
      throw new Error(`Unhandled AutonomyTier: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

describe('AutonomyTier -- discriminated-union narrowing (exhaustiveness canary)', () => {
  it.each([
    ['propose', 'propose'],
    ['approve_and_act', 'approve_and_act'],
    ['act_and_notify', 'act_and_notify'],
  ] as const)('narrows %s correctly (%#)', (tier, expected) => {
    expect(describeTier(tier)).toBe(expected);
  });
});
