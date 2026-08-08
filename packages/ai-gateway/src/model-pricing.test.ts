import { describe, expect, it } from 'vitest';

import {
  CLAUDE_FABLE_5,
  CLAUDE_HAIKU_4_5,
  CLAUDE_OPUS_5,
  CLAUDE_SONNET_5,
  DEFAULT_ANTHROPIC_MODEL,
  MODEL_PRICING,
  calculateCostUsd,
} from './model-pricing.js';

/**
 * Designed signatures (must be matched exactly by implementer — F1-T14 PR1,
 * red step). Per `docs/specs/F1-E4/F1-T14-ai-gateway.md` and the plan at
 * `precious-roaming-harbor.md`: replace the old
 * `DEFAULT_ANTHROPIC_MODEL = 'claude-placeholder-model'` placeholder with
 * real model IDs, and add a per-million-token USD pricing table +
 * `calculateCostUsd(model, usage)` utility.
 *
 * Pricing table (verified against platform.claude.com/docs/en/about-claude/pricing
 * as of August 2026 — per million tokens, input / output):
 *   - claude-opus-5:            $5 / $25
 *   - claude-sonnet-5:          $3 / $15 (STANDARD price effective 2026-09-01,
 *                                deliberately not the $2/$10 introductory price)
 *   - claude-haiku-4-5-20251001: $1 / $5
 *   - claude-fable-5:           $10 / $50
 *
 * `DEFAULT_ANTHROPIC_MODEL` must equal `CLAUDE_SONNET_5` — this replaces the
 * old placeholder string and is re-exported from `anthropic-provider.ts`
 * (asserted there too, see `anthropic-provider.test.ts`).
 *
 * `calculateCostUsd(model, usage)` looks up `model` in `MODEL_PRICING` and
 * returns `usage.inputTokens / 1_000_000 * inputPricePerMillionUsd +
 * usage.outputTokens / 1_000_000 * outputPricePerMillionUsd`. An unknown
 * model (not present in `MODEL_PRICING`) throws — silently mis-pricing usage
 * is worse than crashing.
 */

describe('model-pricing — constants', () => {
  it('exports the real model ID strings (no placeholder left)', () => {
    expect(CLAUDE_OPUS_5).toBe('claude-opus-5');
    expect(CLAUDE_SONNET_5).toBe('claude-sonnet-5');
    expect(CLAUDE_HAIKU_4_5).toBe('claude-haiku-4-5-20251001');
    expect(CLAUDE_FABLE_5).toBe('claude-fable-5');
  });

  it('DEFAULT_ANTHROPIC_MODEL equals CLAUDE_SONNET_5', () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe(CLAUDE_SONNET_5);
  });

  it('MODEL_PRICING has an entry for every exported model with the documented per-million-token rates', () => {
    expect(MODEL_PRICING[CLAUDE_OPUS_5]).toEqual({
      inputPricePerMillionUsd: 5,
      outputPricePerMillionUsd: 25,
    });
    expect(MODEL_PRICING[CLAUDE_SONNET_5]).toEqual({
      inputPricePerMillionUsd: 3,
      outputPricePerMillionUsd: 15,
    });
    expect(MODEL_PRICING[CLAUDE_HAIKU_4_5]).toEqual({
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 5,
    });
    expect(MODEL_PRICING[CLAUDE_FABLE_5]).toEqual({
      inputPricePerMillionUsd: 10,
      outputPricePerMillionUsd: 50,
    });
  });
});

describe('calculateCostUsd — known models, exact round-number cases', () => {
  it('claude-sonnet-5 at exactly 1M input + 1M output tokens costs $18 (3 + 15)', () => {
    expect(
      calculateCostUsd(CLAUDE_SONNET_5, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(18);
  });

  it('claude-opus-5 at exactly 1M input + 1M output tokens costs $30 (5 + 25)', () => {
    expect(
      calculateCostUsd(CLAUDE_OPUS_5, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(30);
  });

  it('claude-fable-5 at exactly 2M input + 0 output tokens costs $20 (2 * 10)', () => {
    expect(calculateCostUsd(CLAUDE_FABLE_5, { inputTokens: 2_000_000, outputTokens: 0 })).toBe(20);
  });
});

describe('calculateCostUsd — known models, non-round-million cases (per-model table lookup, not a hardcoded rate)', () => {
  it('claude-haiku-4-5 at 500k input + 200k output tokens costs exactly $1.5', () => {
    // 500_000/1_000_000 * 1 + 200_000/1_000_000 * 5 = 0.5 + 1 = 1.5
    const cost = calculateCostUsd(CLAUDE_HAIKU_4_5, {
      inputTokens: 500_000,
      outputTokens: 200_000,
    });
    expect(cost).toBeCloseTo(1.5, 10);
  });

  it('claude-sonnet-5 at 250_000 input + 100_000 output tokens costs exactly $2.25', () => {
    // 250_000/1_000_000 * 3 + 100_000/1_000_000 * 15 = 0.75 + 1.5 = 2.25
    const cost = calculateCostUsd(CLAUDE_SONNET_5, { inputTokens: 250_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(2.25, 10);
  });

  it('claude-opus-5 at 333_333 input + 1 output token uses the per-model rate, not another model rate', () => {
    // 333_333/1_000_000 * 5 + 1/1_000_000 * 25 = 1.666665 + 0.000025 = 1.66669
    const cost = calculateCostUsd(CLAUDE_OPUS_5, { inputTokens: 333_333, outputTokens: 1 });
    expect(cost).toBeCloseTo(1.66669, 10);
  });
});

describe('calculateCostUsd — zero usage', () => {
  it('returns 0 for zero input and zero output tokens, for any known model', () => {
    expect(calculateCostUsd(CLAUDE_SONNET_5, { inputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(calculateCostUsd(CLAUDE_OPUS_5, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe('calculateCostUsd — unknown model throws', () => {
  it('throws a clear error when the model string is not present in MODEL_PRICING, rather than silently mis-pricing', () => {
    expect(() =>
      calculateCostUsd('unknown-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toThrow(/unknown-model/);
  });

  it('does not fall back to DEFAULT_ANTHROPIC_MODEL pricing or return 0 for an unrecognized model', () => {
    // Guards against the "silent fallback" alternative design explicitly
    // rejected in the spec: an unknown model must throw, not resolve to a
    // number (0, or DEFAULT_ANTHROPIC_MODEL's rate).
    expect(() =>
      calculateCostUsd('totally-made-up-model-xyz', { inputTokens: 1, outputTokens: 1 }),
    ).toThrow();
  });
});
