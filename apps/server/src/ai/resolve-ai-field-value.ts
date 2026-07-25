import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';
import type { AIFieldErrorValue, AIValue } from '@luminaos/core-objects';

import { renderAIPrompt } from './render-ai-prompt.js';

const RETRY_EXHAUSTED_MESSAGE = 'AI response was not a valid option after retry';

/**
 * The provider-facing, DB-free "resolve one ai field's value" decision
 * logic: render the prompt, call the provider, and (for `outputType:
 * 'select'`) retry once against the SAME rendered prompt if the first
 * response isn't one of `options`, producing an `AIFieldErrorValue` (never
 * throwing) if the retry also misses.
 *
 * Extracted out of `ObjectsService.refreshAIField` (F1-T5 PR-D) so this
 * exact decision logic can be exercised directly against `MockProvider`,
 * without Postgres/EventStore -- the seed for F1-T17's full eval
 * infrastructure (`docs/evals/ai-fields.md`, `ai-fields.eval.test.ts`).
 * `recordUsage` is injected so the caller decides how/where a call's
 * `AITokenUsage` is persisted (an `AIUsageRecorded` event, in
 * `ObjectsService`; nothing, in the eval suite) -- this function itself
 * never reads or writes any storage.
 */
export interface ResolveAIFieldValueInput {
  provider: AIProvider;
  promptTemplate: string;
  sourceFieldValues: Record<string, unknown>;
  outputType: 'text' | 'select';
  options?: string[];
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export async function resolveAIFieldValue(input: ResolveAIFieldValueInput): Promise<AIValue> {
  const prompt = renderAIPrompt(input.promptTemplate, input.sourceFieldValues);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({ prompt });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();

  if (input.outputType !== 'select') {
    return firstResponse;
  }

  const options = input.options ?? [];

  if (options.includes(firstResponse)) {
    return firstResponse;
  }

  const retryResponse = await complete();

  if (options.includes(retryResponse)) {
    return retryResponse;
  }

  const errorValue: AIFieldErrorValue = {
    aiFieldError: true,
    message: RETRY_EXHAUSTED_MESSAGE,
  };

  return errorValue;
}
