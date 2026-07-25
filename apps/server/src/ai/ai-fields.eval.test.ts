import { describe, expect, it } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { resolveAIFieldValue } from './resolve-ai-field-value.js';

/**
 * F1-T5 PR-D — "eval başlangıcı": 10 golden scenarios pinning
 * `resolveAIFieldValue`'s deterministic behavior (template filling, select
 * validation, error path) against `MockProvider`, entirely DB-free -- the
 * seed for F1-T17's full eval infrastructure (`docs/evals/ai-fields.md`
 * documents these same 10 scenarios in human-readable form; keep the two in
 * sync).
 *
 * Runs under plain `pnpm test` (this repo's ordinary `vitest.config.ts`, no
 * Testcontainers) per the spec's own requirement ("Normal CI test
 * koşusunda... çalışır") -- unlike `object-ai-refresh.integration.test.ts`,
 * which proves the SAME logic wired through real Postgres/HTTP,
 * `resolveAIFieldValue` (extracted from `ObjectsService` in this same PR) is
 * a pure decision function over an injected `AIProvider` + a `recordUsage`
 * callback, so these scenarios need neither.
 */

function fixedUsageResponder(
  text: string,
  usage: AITokenUsage = { inputTokens: 10, outputTokens: 5 },
) {
  return (): AICompletionResult => ({ text, usage });
}

function collectUsage(): {
  recordUsage: (usage: AITokenUsage) => void;
  calls: AITokenUsage[];
} {
  const calls: AITokenUsage[] = [];
  return { recordUsage: (usage) => calls.push(usage), calls };
}

describe('AI Fields eval — 10 golden scenarios (MockProvider, DB-free)', () => {
  // -------------------------------------------------------------------------
  // Scenario 1 — template doldurma: tek kaynak alan
  // -------------------------------------------------------------------------
  it("scenario 1: a single {fieldKey} placeholder is replaced with that source field's string value", async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest) => {
      capturedPrompt = request.prompt;
      return { text: 'A short summary.', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const { recordUsage } = collectUsage();

    const value = await resolveAIFieldValue({
      provider,
      promptTemplate: 'Summarize: {description}',
      sourceFieldValues: { description: 'The server caught fire overnight.' },
      outputType: 'text',
      recordUsage,
    });

    expect(capturedPrompt).toBe('Summarize: The server caught fire overnight.');
    expect(value).toBe('A short summary.');
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — template doldurma: birden fazla kaynak alan
  // -------------------------------------------------------------------------
  it('scenario 2: multiple {fieldKey} placeholders in one template are each replaced independently', async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest) => {
      capturedPrompt = request.prompt;
      return { text: 'Fire in prod, urgent.', usage: { inputTokens: 12, outputTokens: 6 } };
    });
    const { recordUsage } = collectUsage();

    const value = await resolveAIFieldValue({
      provider,
      promptTemplate: 'Title: {title}\nDescription: {description}',
      sourceFieldValues: { title: 'Outage', description: 'server on fire' },
      outputType: 'text',
      recordUsage,
    });

    expect(capturedPrompt).toBe('Title: Outage\nDescription: server on fire');
    expect(value).toBe('Fire in prod, urgent.');
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — template doldurma: sayısal alan değeri stringify edilir
  // -------------------------------------------------------------------------
  it('scenario 3: a number-typed source field value is interpolated as its plain string form', async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest) => {
      capturedPrompt = request.prompt;
      return { text: 'high', usage: { inputTokens: 8, outputTokens: 2 } };
    });
    const { recordUsage } = collectUsage();

    await resolveAIFieldValue({
      provider,
      promptTemplate: 'Classify urgency for price {price}',
      sourceFieldValues: { price: 9999 },
      outputType: 'text',
      recordUsage,
    });

    expect(capturedPrompt).toBe('Classify urgency for price 9999');
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — template doldurma: alan tanımlı ama değeri undefined -> boş string
  // -------------------------------------------------------------------------
  it("scenario 4: a source field that IS present but whose value is undefined (never set) interpolates as an empty string, not the literal 'undefined'", async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest) => {
      capturedPrompt = request.prompt;
      return { text: 'n/a', usage: { inputTokens: 5, outputTokens: 1 } };
    });
    const { recordUsage } = collectUsage();

    await resolveAIFieldValue({
      provider,
      promptTemplate: 'Notes: [{notes}]',
      sourceFieldValues: { notes: undefined },
      outputType: 'text',
      recordUsage,
    });

    expect(capturedPrompt).toBe('Notes: []');
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — template doldurma: bilinmeyen yer tutucu olduğu gibi kalır
  // -------------------------------------------------------------------------
  it('scenario 5: a placeholder with no matching key in sourceFieldValues at all is left verbatim (defensive fallback)', async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest) => {
      capturedPrompt = request.prompt;
      return { text: 'ok', usage: { inputTokens: 5, outputTokens: 1 } };
    });
    const { recordUsage } = collectUsage();

    await resolveAIFieldValue({
      provider,
      promptTemplate: 'Value: {neverDefined}',
      sourceFieldValues: { somethingElse: 'x' },
      outputType: 'text',
      recordUsage,
    });

    expect(capturedPrompt).toBe('Value: {neverDefined}');
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — select doğrulama: ilk yanıt geçerli seçenek (retry yok)
  // -------------------------------------------------------------------------
  it('scenario 6: outputType "select" with a first response that IS a valid option resolves immediately, no retry call', async () => {
    let callCount = 0;
    const provider = new MockProvider(() => {
      callCount += 1;
      return { text: 'medium', usage: { inputTokens: 10, outputTokens: 3 } };
    });
    const { recordUsage, calls } = collectUsage();

    const value = await resolveAIFieldValue({
      provider,
      promptTemplate: 'Classify urgency: {description}',
      sourceFieldValues: { description: 'server is warm' },
      outputType: 'select',
      options: ['low', 'medium', 'high'],
      recordUsage,
    });

    expect(value).toBe('medium');
    expect(callCount).toBe(1);
    expect(calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — select doğrulama: ilk yanıt geçersiz, retry ile düzelir
  // -------------------------------------------------------------------------
  it('scenario 7: outputType "select" with an invalid first response retries ONCE against the same prompt and resolves to the retry\'s valid option', async () => {
    let callCount = 0;
    let firstPrompt = '';
    let secondPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest) => {
      callCount += 1;
      if (callCount === 1) {
        firstPrompt = request.prompt;
        return { text: 'not-an-option', usage: { inputTokens: 10, outputTokens: 3 } };
      }
      secondPrompt = request.prompt;
      return { text: 'high', usage: { inputTokens: 10, outputTokens: 3 } };
    });
    const { recordUsage, calls } = collectUsage();

    const value = await resolveAIFieldValue({
      provider,
      promptTemplate: 'Classify urgency: {description}',
      sourceFieldValues: { description: 'building is on fire' },
      outputType: 'select',
      options: ['low', 'medium', 'high'],
      recordUsage,
    });

    expect(value).toBe('high');
    expect(callCount).toBe(2);
    expect(firstPrompt).toBe(secondPrompt);
    expect(calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — hata yolu: her iki deneme de geçersiz -> AIFieldErrorValue
  // -------------------------------------------------------------------------
  it('scenario 8: outputType "select" with BOTH attempts invalid resolves to an AIFieldErrorValue, never throwing', async () => {
    const provider = new MockProvider(fixedUsageResponder('still-not-an-option'));
    const { recordUsage, calls } = collectUsage();

    const value = await resolveAIFieldValue({
      provider,
      promptTemplate: 'Classify: {description}',
      sourceFieldValues: { description: 'ambiguous' },
      outputType: 'select',
      options: ['low', 'medium', 'high'],
      recordUsage,
    });

    expect(value).toMatchObject({ aiFieldError: true });
    expect(typeof (value as { message: string }).message).toBe('string');
    expect(calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 9 — kullanım kaydı: her provider çağrısı recordUsage'ı doğru
  // usage değeriyle tetikler
  // -------------------------------------------------------------------------
  it("scenario 9: every real provider call invokes recordUsage with that exact call's token usage, in order", async () => {
    let callCount = 0;
    const provider = new MockProvider(() => {
      callCount += 1;
      return callCount === 1
        ? { text: 'wrong', usage: { inputTokens: 100, outputTokens: 20 } }
        : { text: 'low', usage: { inputTokens: 50, outputTokens: 10 } };
    });
    const { recordUsage, calls } = collectUsage();

    await resolveAIFieldValue({
      provider,
      promptTemplate: 'Classify: {description}',
      sourceFieldValues: { description: 'minor issue' },
      outputType: 'select',
      options: ['low', 'medium', 'high'],
      recordUsage,
    });

    expect(calls).toEqual([
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 50, outputTokens: 10 },
    ]);
  });

  // -------------------------------------------------------------------------
  // Scenario 10 — template doldurma + select doğrulama birlikte: gerçekçi
  // "kategori ataması" senaryosu (Amaç: "özet, kategori, öncelik önerisi")
  // -------------------------------------------------------------------------
  it('scenario 10: a realistic category-assignment field (multi-field template + select) resolves end-to-end from raw source values to a valid option', async () => {
    let capturedPrompt = '';
    const provider = new MockProvider((request: AICompletionRequest) => {
      capturedPrompt = request.prompt;
      return { text: 'bug', usage: { inputTokens: 20, outputTokens: 4 } };
    });
    const { recordUsage } = collectUsage();

    const value = await resolveAIFieldValue({
      provider,
      promptTemplate: 'Categorize "{title}": {description}',
      sourceFieldValues: { title: 'Login broken', description: 'users cannot sign in since 9am' },
      outputType: 'select',
      options: ['bug', 'feature-request', 'question'],
      recordUsage,
    });

    expect(capturedPrompt).toBe('Categorize "Login broken": users cannot sign in since 9am');
    expect(value).toBe('bug');
  });
});
