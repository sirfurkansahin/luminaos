import { describe, expect, it } from 'vitest';

import {
  LocalProvider,
  SENSITIVITY_TIERS,
  StaticTierRoutingPolicy,
  aiGatewayPlaceholder,
  isSensitivityTier,
} from './index.js';

import type {
  AIRoutingDestination,
  AIRoutingPolicy,
  ClassifiedAIRequest,
  SensitivityTier,
} from './index.js';

describe('aiGatewayPlaceholder', () => {
  it('returns the package placeholder string', () => {
    expect(aiGatewayPlaceholder()).toBe('@luminaos/ai-gateway placeholder');
  });
});

/**
 * F3-T12 PR1 (ADR-0046) barrel-export smoke test — this package has no
 * existing convention for asserting `import type`-only re-exports (the
 * runtime `import type { ModelPricing } from './index.js'` case is closest,
 * see `model-pricing.test.ts`, but that file never round-trips the type
 * through `index.ts`). Runtime-value exports get a real truthy/behavioral
 * check below; pure-type exports (`AIRoutingDestination`, `ClassifiedAIRequest`,
 * `AIRoutingPolicy`, `SensitivityTier`) are proven only at compile time via
 * the `import type { ... } from './index.js'` above and the annotations
 * below -- if any of them stopped being re-exported, `tsc`/this file's own
 * type-check would fail, which is the only meaningful way to test a
 * type-only re-export.
 */
describe('index.ts — F3-T12 (ADR-0046) barrel re-exports', () => {
  it('re-exports isSensitivityTier and SENSITIVITY_TIERS as runtime values', () => {
    expect(typeof isSensitivityTier).toBe('function');
    expect(isSensitivityTier('tier0')).toBe(true);
    expect(SENSITIVITY_TIERS).toEqual(['tier0', 'tier1', 'tier2', 'tier3']);
  });

  it('re-exports StaticTierRoutingPolicy as a constructible runtime class implementing AIRoutingPolicy', () => {
    const policy: AIRoutingPolicy = new StaticTierRoutingPolicy();
    expect(typeof policy.route).toBe('function');

    const destination: AIRoutingDestination = policy.route({
      tier: 'tier0' as SensitivityTier,
      request: { prompt: 'hello' },
    } satisfies ClassifiedAIRequest);
    expect(destination).toBe('local');
  });

  it('re-exports LocalProvider as a constructible runtime class', async () => {
    const provider = new LocalProvider();
    const result = await provider.complete({ prompt: 'hello' });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
