import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { StaticTierRoutingPolicy } from './routing-policy.js';

import type { AICompletionRequest } from './provider.js';
import type { ClassifiedAIRequest } from './routing-policy.js';
import type { SensitivityTier } from './sensitivity-tier.js';

/**
 * Designed signatures (must be matched exactly by implementer — F3-T12 PR1,
 * red step). Per `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md` Karar (b)/(c)
 * and `docs/specs/F3-E5/F3-T12-cihaz-ustu-model-koprusu.md`:
 *
 *   export type AIRoutingDestination = 'local' | 'cloud';
 *   export interface ClassifiedAIRequest {
 *     tier: SensitivityTier;
 *     request: AICompletionRequest;
 *   }
 *   export interface AIRoutingPolicy {
 *     route(input: ClassifiedAIRequest): AIRoutingDestination;
 *   }
 *   export class StaticTierRoutingPolicy implements AIRoutingPolicy {
 *     route(input: ClassifiedAIRequest): AIRoutingDestination;
 *   }
 *
 * v0 fixed mapping: tier0/tier1/tier2 -> 'local', tier3 -> 'cloud'. An
 * invalid/unknown tier throws `ValidationError` (from `@luminaos/shared`) --
 * this is the "only validate it IS a real enum value, do NOT content-analyze"
 * regression proof (İnsan kararı 3, ADR-0046). `route()` is a pure, sync,
 * zero-I/O decision function with no side effects.
 */

function buildRequest(overrides: Partial<AICompletionRequest> = {}): AICompletionRequest {
  return {
    prompt: 'Summarize this ticket in one sentence.',
    ...overrides,
  };
}

function buildClassified(tier: SensitivityTier): ClassifiedAIRequest {
  return { tier, request: buildRequest() };
}

describe('StaticTierRoutingPolicy — tier0/tier1/tier2 route to local', () => {
  it.each(['tier0', 'tier1', 'tier2'] as const)('routes %s to "local"', (tier) => {
    const policy = new StaticTierRoutingPolicy();
    expect(policy.route(buildClassified(tier))).toBe('local');
  });
});

describe('StaticTierRoutingPolicy — tier3 routes to cloud', () => {
  it('routes tier3 to "cloud"', () => {
    const policy = new StaticTierRoutingPolicy();
    expect(policy.route(buildClassified('tier3'))).toBe('cloud');
  });
});

describe('StaticTierRoutingPolicy — invalid tier throws ValidationError', () => {
  it('throws a ValidationError (not a generic Error) when tier is not a real SensitivityTier value', () => {
    const policy = new StaticTierRoutingPolicy();
    const invalidInput = {
      tier: 'garbage' as unknown as SensitivityTier,
      request: buildRequest(),
    };

    expect(() => policy.route(invalidInput)).toThrow();
    expect(() => policy.route(invalidInput)).toThrow(ValidationError);

    let caught: unknown;
    try {
      policy.route(invalidInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
  });
});

describe('StaticTierRoutingPolicy.route — pure function, no side effects', () => {
  it('returns the same result across repeated calls with the same input (deterministic)', () => {
    const policy = new StaticTierRoutingPolicy();
    const input = buildClassified('tier1');

    const first = policy.route(input);
    const second = policy.route(input);

    expect(first).toBe('local');
    expect(second).toBe(first);
  });

  it('does not mutate the input ClassifiedAIRequest object', () => {
    const policy = new StaticTierRoutingPolicy();
    const input = buildClassified('tier2');
    const snapshotBefore = JSON.parse(JSON.stringify(input)) as ClassifiedAIRequest;

    policy.route(input);

    expect(input).toEqual(snapshotBefore);
  });
});
