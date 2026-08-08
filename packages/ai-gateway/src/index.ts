export function aiGatewayPlaceholder(): string {
  return '@luminaos/ai-gateway placeholder';
}

export * from './provider.js';
export * from './mock-provider.js';
export * from './anthropic-provider.js';
export * from './retry.js';
export * from './embedding-provider.js';
export * from './mock-embedding-provider.js';
// `DEFAULT_ANTHROPIC_MODEL` is intentionally omitted here — it is already
// re-exported via `./anthropic-provider.js` above, and a second `export *`
// for the same binding would be an `import-x/export` duplicate-export error.
export {
  CLAUDE_OPUS_5,
  CLAUDE_SONNET_5,
  CLAUDE_HAIKU_4_5,
  CLAUDE_FABLE_5,
  MODEL_PRICING,
  calculateCostUsd,
} from './model-pricing.js';
export type { ModelPricing } from './model-pricing.js';
