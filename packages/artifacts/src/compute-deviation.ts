export type DeviationDirection = 'up' | 'down' | 'unchanged';

export interface DeviationResult {
  delta: number;
  percentChange: number | null;
  direction: DeviationDirection;
}

/**
 * ADR-0044 Karar (f) — computes the deviation between a captured baseline
 * value and the current value. `percentChange` is `null` (never
 * `Infinity`/`-Infinity`/`NaN`) whenever `capturedValue` is `0`, since a
 * percentage-of-zero is not a meaningful number.
 */
export function computeDeviation(input: {
  capturedValue: number;
  currentValue: number;
}): DeviationResult {
  const { capturedValue, currentValue } = input;
  const delta = currentValue - capturedValue;
  const percentChange = capturedValue === 0 ? null : (delta / capturedValue) * 100;
  const direction: DeviationDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';

  return { delta, percentChange, direction };
}
