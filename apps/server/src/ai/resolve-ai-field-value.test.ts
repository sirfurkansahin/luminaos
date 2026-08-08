import { describe, expect, it } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { resolveAIFieldValue } from './resolve-ai-field-value.js';

/**
 * F1-T14 PR3 (RED step) — `resolveAIFieldValue`'s NEW optional `model` input
 * field: a pure pass-through/forwarding contract, exercised directly against
 * `MockProvider` (no DB, no HTTP), separate from `ai-fields.eval.test.ts`'s
 * existing 10 golden scenarios (which never pass `model` at all, and must
 * keep passing unmodified -- see this task's required-reading note 4).
 *
 * `resolveAIFieldValue` itself stays DB-free/LuminaOS-agnostic: it does NOT
 * decide which model to use (that's `selectAIModel` + `objects.service.ts`'s
 * job) and does NOT compute cost (that's `calculateCostUsd`, applied by the
 * caller) -- it only forwards whatever `model` the caller already decided
 * into `provider.complete({ prompt, model })`, and otherwise behaves exactly
 * as before.
 *
 * Nothing under test here exists yet: `ResolveAIFieldValueInput` has no
 * `model` field on `main`, and `resolveAIFieldValue`'s `complete` closure
 * only ever calls `input.provider.complete({ prompt })` (never forwarding a
 * model) -- every assertion below on the CAPTURED request's `model` is
 * expected to fail until `implementer` adds the field and forwards it.
 */

function collectUsage(): {
  recordUsage: (usage: AITokenUsage) => void;
  calls: AITokenUsage[];
} {
  const calls: AITokenUsage[] = [];
  return { recordUsage: (usage) => calls.push(usage), calls };
}

describe('resolveAIFieldValue — model forwarding (F1-T14 PR3)', () => {
  it('when the caller passes model, the underlying provider.complete(...) request carries that exact model alongside the rendered prompt', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return { text: 'a response', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const { recordUsage } = collectUsage();

    await resolveAIFieldValue({
      provider,
      promptTemplate: 'Summarize: {description}',
      sourceFieldValues: { description: 'some raw notes' },
      outputType: 'text',
      model: 'some-model-id',
      recordUsage,
    });

    expect(capturedRequest).toEqual({
      prompt: 'Summarize: some raw notes',
      model: 'some-model-id',
    });
  });

  it('a select-output field forwards the SAME model on both the first attempt and the retry, when the first response is not a valid option', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not-an-option', usage: { inputTokens: 10, outputTokens: 3 } }
        : { text: 'high', usage: { inputTokens: 10, outputTokens: 3 } };
    });
    const { recordUsage } = collectUsage();

    await resolveAIFieldValue({
      provider,
      promptTemplate: 'Classify urgency: {description}',
      sourceFieldValues: { description: 'building is on fire' },
      outputType: 'select',
      options: ['low', 'medium', 'high'],
      model: 'claude-haiku-4-5-20251001',
      recordUsage,
    });

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.model).toBe('claude-haiku-4-5-20251001');
    expect(capturedRequests[1]?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('backward compatibility: calling resolveAIFieldValue WITHOUT a model field still resolves the value correctly and sends no model key (or an undefined one) to provider.complete', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return { text: 'a plain response', usage: { inputTokens: 8, outputTokens: 2 } };
    });
    const { recordUsage } = collectUsage();

    const value = await resolveAIFieldValue({
      provider,
      promptTemplate: 'Summarize: {description}',
      sourceFieldValues: { description: 'no model specified here' },
      outputType: 'text',
      recordUsage,
    });

    expect(value).toBe('a plain response');
    expect(capturedRequest?.model).toBeUndefined();
  });

  it('recordUsage still receives exactly result.usage, unchanged by the model field — resolveAIFieldValue itself never touches pricing/cost', async () => {
    const provider = new MockProvider((): AICompletionResult => ({
      text: 'a response',
      usage: { inputTokens: 42, outputTokens: 7 },
    }));
    const { recordUsage, calls } = collectUsage();

    await resolveAIFieldValue({
      provider,
      promptTemplate: 'Summarize: {description}',
      sourceFieldValues: { description: 'notes' },
      outputType: 'text',
      model: 'claude-sonnet-5',
      recordUsage,
    });

    expect(calls).toEqual([{ inputTokens: 42, outputTokens: 7 }]);
  });
});
