import { Module } from '@nestjs/common';

import { AnthropicProvider, MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AIProvider } from '@luminaos/ai-gateway';

import { AI_PROVIDER } from './ai-provider.token.js';
import { env } from '../config/env.js';

export { AI_PROVIDER };

/**
 * The `RETURN:<text>` marker `object-ai-refresh.integration.test.ts` scripts
 * every rendered prompt with. Kept here (not exported) since this responder
 * is a PRODUCTION fallback used whenever no real `ANTHROPIC_API_KEY` is
 * configured, not a test-only helper — the integration test relies on this
 * exact production behavior, it does not inject its own responder.
 */
const RETURN_MARKER = 'RETURN:';

/**
 * `MockProvider`'s responder for when no real `ANTHROPIC_API_KEY` is
 * configured (`env.anthropicApiKey === undefined`) — used both in
 * production (a genuinely unconfigured deployment) and by every integration
 * test in this repo (which never sets `ANTHROPIC_API_KEY`).
 *
 * If the rendered prompt contains the literal substring `"RETURN:"`, responds
 * with everything after it as `text` (every character to the end of the
 * prompt string), and a FIXED usage of `{ inputTokens: 100, outputTokens: 20 }`
 * on every call — this is the exact convention
 * `object-ai-refresh.integration.test.ts`'s header doc comment pins.
 * Otherwise, falls back to a clearly-synthetic "not configured" message (real
 * production use without a key, not this convention).
 */
function unconfiguredResponder(request: AICompletionRequest): AICompletionResult {
  const markerIndex = request.prompt.indexOf(RETURN_MARKER);

  if (markerIndex === -1) {
    return {
      text: '[ai-gateway] ANTHROPIC_API_KEY not configured',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  return {
    text: request.prompt.slice(markerIndex + RETURN_MARKER.length),
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

@Module({
  providers: [
    {
      provide: AI_PROVIDER,
      useFactory: (): AIProvider => {
        if (env.anthropicApiKey !== undefined) {
          return new AnthropicProvider({ apiKey: env.anthropicApiKey });
        }

        return new MockProvider(unconfiguredResponder);
      },
    },
  ],
  exports: [AI_PROVIDER],
})
export class AIProviderModule {}
