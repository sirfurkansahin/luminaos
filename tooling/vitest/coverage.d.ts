export interface CoverageConfig {
  provider: 'v8';
  reporter: string[];
  include: string[];
  exclude: string[];
  thresholds: { lines: number };
}

/**
 * Faz 1'de domain paketleri 95'e cekilecek; her paket kendi vitest.config.ts'inde
 * bu degeri override edebilir.
 */
export function coverageConfig(thresholdLines?: number): CoverageConfig;
