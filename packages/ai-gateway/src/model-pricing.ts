import { ValidationError } from '@luminaos/shared';

import type { AITokenUsage } from './provider.js';

export const CLAUDE_OPUS_5 = 'claude-opus-5';
export const CLAUDE_SONNET_5 = 'claude-sonnet-5';
export const CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5-20251001';
export const CLAUDE_FABLE_5 = 'claude-fable-5';

export const DEFAULT_ANTHROPIC_MODEL = CLAUDE_SONNET_5;

export interface ModelPricing {
  inputPricePerMillionUsd: number;
  outputPricePerMillionUsd: number;
}

/**
 * Fiyatlar Ağustos 2026 itibarıyla platform.claude.com/docs/en/about-claude/pricing
 * kaynaklıdır, değişirse güncellenmeli. Sonnet 5 için 1 Eylül 2026 sonrası
 * STANDART fiyat ($3/$15) kullanılıyor, $2/$10 tanıtım fiyatı değil — tablo
 * tanıtım penceresi bitince sessizce yanlış hale gelmesin diye.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  [CLAUDE_OPUS_5]: { inputPricePerMillionUsd: 5, outputPricePerMillionUsd: 25 },
  [CLAUDE_SONNET_5]: { inputPricePerMillionUsd: 3, outputPricePerMillionUsd: 15 },
  [CLAUDE_HAIKU_4_5]: { inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 5 },
  [CLAUDE_FABLE_5]: { inputPricePerMillionUsd: 10, outputPricePerMillionUsd: 50 },
};

export function calculateCostUsd(model: string, usage: AITokenUsage): number {
  const pricing = MODEL_PRICING[model];
  if (pricing === undefined) {
    throw new ValidationError(`Unknown model for cost calculation: "${model}"`, { model });
  }
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPricePerMillionUsd +
    (usage.outputTokens / 1_000_000) * pricing.outputPricePerMillionUsd
  );
}
