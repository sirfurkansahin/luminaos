import { describe, expect, it } from 'vitest';

import { THEME_PRESETS } from './theme-preset.js';

/**
 * F3-T7 PR1 (RED step), ADR-0041 Karar (e) — `packages/artifacts/src/theme-preset.ts`.
 *
 *   export type ThemePresetName = 'kurumsal' | 'canli' | 'minimal';
 *   export interface ThemePreset { name: ThemePresetName; cssVariables: Record<string, string> }
 *   export const THEME_PRESETS: Record<ThemePresetName, ThemePreset>
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/theme-preset.ts` — this module does not exist yet
 * at all, so this import fails with "Cannot find module".
 */

describe('THEME_PRESETS', () => {
  it('has exactly the 3 expected preset keys, no more no less', () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual(['canli', 'kurumsal', 'minimal'].sort());
  });

  describe('kurumsal preset', () => {
    it('has name "kurumsal" and the exact 4 CSS variables from ADR-0041 Karar (e)', () => {
      expect(THEME_PRESETS.kurumsal.name).toBe('kurumsal');
      expect(THEME_PRESETS.kurumsal.cssVariables).toEqual({
        '--artifact-bg': '#ffffff',
        '--artifact-fg': '#1f2937',
        '--artifact-accent': '#1d4ed8',
        '--artifact-font': 'Georgia, serif',
      });
    });
  });

  describe('canli preset', () => {
    it('has name "canli" and the exact 4 CSS variables from ADR-0041 Karar (e)', () => {
      expect(THEME_PRESETS.canli.name).toBe('canli');
      expect(THEME_PRESETS.canli.cssVariables).toEqual({
        '--artifact-bg': '#0f172a',
        '--artifact-fg': '#f8fafc',
        '--artifact-accent': '#f97316',
        '--artifact-font': '"Segoe UI", sans-serif',
      });
    });
  });

  describe('minimal preset', () => {
    it('has name "minimal" and the exact 4 CSS variables from ADR-0041 Karar (e)', () => {
      expect(THEME_PRESETS.minimal.name).toBe('minimal');
      expect(THEME_PRESETS.minimal.cssVariables).toEqual({
        '--artifact-bg': '#ffffff',
        '--artifact-fg': '#111827',
        '--artifact-accent': '#111827',
        '--artifact-font': 'ui-sans-serif, system-ui',
      });
    });
  });

  it('every preset has exactly 4 CSS variable keys, no more no less', () => {
    for (const presetName of ['kurumsal', 'canli', 'minimal'] as const) {
      expect(Object.keys(THEME_PRESETS[presetName].cssVariables).sort()).toEqual(
        ['--artifact-accent', '--artifact-bg', '--artifact-font', '--artifact-fg'].sort(),
      );
    }
  });
});
