import { ValidationError } from '@luminaos/shared';

import { isSensitivityTier } from './sensitivity-tier.js';

import type { AICompletionRequest } from './provider.js';
import type { SensitivityTier } from './sensitivity-tier.js';

/**
 * See `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md` Karar (b)/(c). A
 * request that has already been classified into a `SensitivityTier` is
 * routed to either a local (on-device) or cloud provider. Routing only ever
 * inspects the already-assigned `tier` label — never the request's raw
 * contents — per İnsan kararı 3 (ADR-0046): "only validate it IS a real enum
 * value, do NOT content-analyze".
 */
export type AIRoutingDestination = 'local' | 'cloud';

export interface ClassifiedAIRequest {
  tier: SensitivityTier;
  request: AICompletionRequest;
}

export interface AIRoutingPolicy {
  route(input: ClassifiedAIRequest): AIRoutingDestination;
}

/**
 * v0 fixed mapping: tier0/tier1/tier2 -> 'local', tier3 -> 'cloud'. Pure,
 * sync, zero-I/O — no mutation of `input`, deterministic on repeated calls
 * with the same input.
 */
export class StaticTierRoutingPolicy implements AIRoutingPolicy {
  route(input: ClassifiedAIRequest): AIRoutingDestination {
    if (!isSensitivityTier(input.tier)) {
      throw new ValidationError(`Unknown sensitivity tier: "${String(input.tier)}"`, {
        tier: input.tier,
      });
    }

    return input.tier === 'tier3' ? 'cloud' : 'local';
  }
}
