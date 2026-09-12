import { describe, expect, it } from 'vitest';

import { computeDeviation } from './compute-deviation.js';

/**
 * F3-T10 PR1 (RED step), ADR-0044 Karar (f) —
 * `packages/artifacts/src/compute-deviation.ts`.
 *
 *   export type DeviationDirection = 'up' | 'down' | 'unchanged';
 *   export interface DeviationResult {
 *     delta: number;
 *     percentChange: number | null;
 *     direction: DeviationDirection;
 *   }
 *   export function computeDeviation(input: {
 *     capturedValue: number;
 *     currentValue: number;
 *   }): DeviationResult;
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/compute-deviation.ts` — this module does not exist
 * yet at all, so this import fails with "Cannot find module".
 */

describe('computeDeviation — currentValue > capturedValue -> "up"', () => {
  it('captured:100, current:150 -> delta:50, percentChange:50, direction:"up"', () => {
    const result = computeDeviation({ capturedValue: 100, currentValue: 150 });

    expect(result.delta).toBe(50);
    expect(result.percentChange).toBe(50);
    expect(result.direction).toBe('up');
  });
});

describe('computeDeviation — currentValue < capturedValue -> "down"', () => {
  it('captured:100, current:75 -> delta:-25, percentChange:-25, direction:"down"', () => {
    const result = computeDeviation({ capturedValue: 100, currentValue: 75 });

    expect(result.delta).toBe(-25);
    expect(result.percentChange).toBe(-25);
    expect(result.direction).toBe('down');
  });
});

describe('computeDeviation — currentValue === capturedValue -> "unchanged"', () => {
  it('captured:42, current:42 -> delta:0, percentChange:0, direction:"unchanged"', () => {
    const result = computeDeviation({ capturedValue: 42, currentValue: 42 });

    expect(result.delta).toBe(0);
    expect(result.percentChange).toBe(0);
    expect(result.direction).toBe('unchanged');
  });
});

describe('computeDeviation — security/correctness-critical: capturedValue === 0 never produces Infinity/NaN, always percentChange: null (ADR-0044 Karar f)', () => {
  it('captured:0, current:0 -> delta:0, direction:"unchanged", percentChange EXACTLY null', () => {
    const result = computeDeviation({ capturedValue: 0, currentValue: 0 });

    expect(result.delta).toBe(0);
    expect(result.direction).toBe('unchanged');
    expect(result.percentChange).toBeNull();
    expect(Number.isFinite(result.percentChange)).toBe(false);
    expect(result.percentChange).not.toBe(Infinity);
    expect(result.percentChange === null || Number.isNaN(result.percentChange)).toBe(true);
    expect(Number.isNaN(result.percentChange as unknown as number)).toBe(false); // it's null, not NaN
  });

  it('captured:0, current:50 -> delta:50, direction:"up", percentChange EXACTLY null (never Infinity)', () => {
    const result = computeDeviation({ capturedValue: 0, currentValue: 50 });

    expect(result.delta).toBe(50);
    expect(result.direction).toBe('up');
    expect(result.percentChange).toBeNull();
    expect(result.percentChange).not.toBe(Infinity);
    expect(Number.isFinite(result.percentChange)).toBe(false);
  });

  it('captured:0, current:-50 -> delta:-50, direction:"down", percentChange EXACTLY null (never -Infinity)', () => {
    const result = computeDeviation({ capturedValue: 0, currentValue: -50 });

    expect(result.delta).toBe(-50);
    expect(result.direction).toBe('down');
    expect(result.percentChange).toBeNull();
    expect(result.percentChange).not.toBe(-Infinity);
  });
});

describe('computeDeviation — negative capturedValue/currentValue inputs (a metric that can legitimately go negative)', () => {
  it('does not throw for negative inputs and computes a sensible delta/direction', () => {
    expect(() => computeDeviation({ capturedValue: -50, currentValue: -20 })).not.toThrow();
  });

  it('captured:-50, current:-20 -> delta:30 (increase, less negative), direction:"up", percentChange follows the same (current-captured)/captured*100 formula as the positive-value cases', () => {
    const result = computeDeviation({ capturedValue: -50, currentValue: -20 });

    expect(result.delta).toBe(30);
    expect(result.direction).toBe('up');
    expect(result.percentChange).toBe(-60);
  });

  it('captured:-20, current:-50 -> delta:-30 (decrease, more negative), direction:"down"', () => {
    const result = computeDeviation({ capturedValue: -20, currentValue: -50 });

    expect(result.delta).toBe(-30);
    expect(result.direction).toBe('down');
    expect(result.percentChange).toBe(150);
  });
});
