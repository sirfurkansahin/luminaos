/**
 * Kod-karşılığı of ADR-0029's four-kademe sensitive-data classification
 * (Kademe 0-3) — see `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md` Karar
 * (b). A CLOSED enum, exactly 4 values. No content analysis happens here —
 * this module only recognizes/validates already-classified tier labels.
 */

export type SensitivityTier = 'tier0' | 'tier1' | 'tier2' | 'tier3';

export const SENSITIVITY_TIERS: readonly SensitivityTier[] = ['tier0', 'tier1', 'tier2', 'tier3'];

export function isSensitivityTier(value: unknown): value is SensitivityTier {
  return typeof value === 'string' && (SENSITIVITY_TIERS as readonly string[]).includes(value);
}
