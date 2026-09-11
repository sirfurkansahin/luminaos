export type ThemePresetName = 'kurumsal' | 'canli' | 'minimal';

export interface ThemePreset {
  name: ThemePresetName;
  cssVariables: Record<string, string>;
}

export const THEME_PRESETS: Record<ThemePresetName, ThemePreset> = {
  kurumsal: {
    name: 'kurumsal',
    cssVariables: {
      '--artifact-bg': '#ffffff',
      '--artifact-fg': '#1f2937',
      '--artifact-accent': '#1d4ed8',
      '--artifact-font': 'Georgia, serif',
    },
  },
  canli: {
    name: 'canli',
    cssVariables: {
      '--artifact-bg': '#0f172a',
      '--artifact-fg': '#f8fafc',
      '--artifact-accent': '#f97316',
      '--artifact-font': '"Segoe UI", sans-serif',
    },
  },
  minimal: {
    name: 'minimal',
    cssVariables: {
      '--artifact-bg': '#ffffff',
      '--artifact-fg': '#111827',
      '--artifact-accent': '#111827',
      '--artifact-font': 'ui-sans-serif, system-ui',
    },
  },
};
