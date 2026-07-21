/**
 * @param {number} [thresholdLines] - Faz 1'de domain paketleri 95'e cekilecek; her paket kendi vitest.config.ts'inde bu degeri override edebilir.
 */
export function coverageConfig(thresholdLines = 85) {
  return {
    provider: 'v8',
    reporter: ['text', 'lcov'],
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts'],
    thresholds: {
      lines: thresholdLines,
    },
  };
}
