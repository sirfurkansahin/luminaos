import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { answerQuestion } from './answer-question.js';

import type { QAAnswer, QAPassage } from './answer-question.js';

/**
 * F1-T15 PR3 (RED step) — `answerQuestion`, a NEW, DB-free, pure RAG-style
 * completion orchestrator: sibling of `resolveAIFieldValue`
 * (`./resolve-ai-field-value.ts`), following the exact same shape --
 * provider/model/recordUsage all injected, no Postgres/EventStore, exercised
 * directly against `MockProvider`.
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./answer-question.ts` does not exist yet on this branch):
 *
 *   export interface QAPassage {
 *     objectId: string;
 *     title: string;
 *     snippet: string;
 *   }
 *
 *   export interface AnswerQuestionInput {
 *     provider: AIProvider;
 *     question: string;
 *     passages: QAPassage[];
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface QAAnswer {
 *     answer: string;
 *     sources: QAPassage[];
 *   }
 *
 *   export function answerQuestion(input: AnswerQuestionInput): Promise<QAAnswer>;
 *
 * Behavior pinned by the tests below:
 *
 *  1. Normal case (>=1 passage): render ONE prompt containing the question
 *     AND every passage's title+snippet verbatim, call
 *     `provider.complete({ prompt, model? })` exactly once, forward
 *     `result.usage` to `recordUsage` exactly once, and return
 *     `{ answer: result.text, sources: input.passages }` -- `sources` must be
 *     EXACTLY the passages that were passed in, never re-derived from the
 *     model's own response (RBAC-filtered retrieval already guarantees these
 *     are the only safe references to cite -- the model must not be able to
 *     invent or alter which sources are cited).
 *
 *  2. THE critical safety behavior -- empty passages, no hallucination: when
 *     `passages` is `[]`, `answerQuestion` must NEVER call
 *     `provider.complete(...)` and must NEVER call `recordUsage` (a question
 *     that structurally cannot be answered must cost nothing and must never
 *     reach the model), and must instead resolve, synchronously in effect, to
 *     the FIXED `QAAnswer` below -- implementer must match this EXACT string:
 *
 *       answer: "No relevant content was found in this workspace to answer this question."
 *       sources: []
 *
 *  3. Model forwarding: mirrors `resolve-ai-field-value.test.ts`'s
 *     "model forwarding" tests exactly -- when `model` is given it reaches
 *     `provider.complete` unchanged; when omitted, no `model` key reaches the
 *     provider (or it is `undefined`).
 *
 *  4. No content logging: mirrors `anthropic-provider.test.ts`'s "never logs
 *     prompt or completion text" test -- `answerQuestion` must never call
 *     `console.log`/`console.error`/`console.warn`, per ADR-0008's structural
 *     discipline (question/passage/answer content must never be logged).
 *
 * Nothing under test here exists yet: `./answer-question.ts` has not been
 * written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

/** The exact, pinned fixed-answer string for the empty-passages short circuit. */
const EMPTY_PASSAGES_ANSWER =
  'No relevant content was found in this workspace to answer this question.';

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

function buildPassages(): QAPassage[] {
  return [
    {
      objectId: 'obj-1',
      title: 'Q3 Onboarding Runbook',
      snippet: 'New hires must complete security training within their first week.',
    },
    {
      objectId: 'obj-2',
      title: 'Remote Work Policy',
      snippet: 'Employees may work remotely up to three days per week with manager approval.',
    },
  ];
}

describe('answerQuestion — normal case (>=1 passage)', () => {
  it('calls provider.complete exactly once with a prompt containing the question and every passage title+snippet, forwards result.usage to recordUsage exactly once, and returns { answer: result.text, sources: passages }', async () => {
    const passages = buildPassages();
    const question = 'How many days per week can employees work remotely?';
    let capturedRequest: AICompletionRequest | undefined;
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      callCount += 1;
      return {
        text: 'Employees may work remotely up to three days per week with manager approval.',
        usage: { inputTokens: 120, outputTokens: 18 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await answerQuestion({
      provider,
      question,
      passages,
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(capturedRequest?.prompt).toContain(question);
    for (const passage of passages) {
      expect(capturedRequest?.prompt).toContain(passage.title);
      expect(capturedRequest?.prompt).toContain(passage.snippet);
    }
    // The prompt must explicitly instruct the model to answer ONLY from the
    // given passages and not fabricate/invent beyond them -- verifiable
    // regardless of whether the implementer's actual wording is English or
    // Turkish.
    expect(capturedRequest?.prompt).toMatch(/\bonly\b|\byalnız/i);
    expect(capturedRequest?.prompt).toMatch(/passage|pasaj/i);

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 120, outputTokens: 18 });

    const expected: QAAnswer = {
      answer: 'Employees may work remotely up to three days per week with manager approval.',
      sources: passages,
    };
    expect(result).toEqual(expected);
  });

  it('sources are EXACTLY the passages that were passed in, never re-derived from the model response, even when the model text does not mention every passage', async () => {
    const passages = buildPassages();
    const provider = MockProvider.fixed({
      text: 'Only the first passage seems relevant.',
      usage: { inputTokens: 50, outputTokens: 10 },
    });
    const { recordUsage } = collectUsage();

    const result = await answerQuestion({
      provider,
      question: 'What is the onboarding requirement?',
      passages,
      recordUsage,
    });

    expect(result.sources).toEqual(passages);
    expect(result.sources).toHaveLength(2);
  });
});

describe('answerQuestion — empty-passages short circuit (no hallucination)', () => {
  it('when passages is [], NEVER calls provider.complete, NEVER calls recordUsage, and resolves to the fixed "no relevant content" answer with empty sources', async () => {
    const provider = new MockProvider((): AICompletionResult => {
      throw new Error('provider.complete must never be called when there are no passages');
    });
    const completeSpy = vi.spyOn(provider, 'complete');
    const { recordUsage } = collectUsage();

    const result = await answerQuestion({
      provider,
      question: 'What is our remote work policy?',
      passages: [],
      recordUsage,
    });

    expect(completeSpy).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();

    const expected: QAAnswer = {
      answer: EMPTY_PASSAGES_ANSWER,
      sources: [],
    };
    expect(result).toEqual(expected);
  });
});

describe('answerQuestion — model forwarding', () => {
  it('when the caller passes model, provider.complete(...) receives that exact model alongside the rendered prompt', async () => {
    const passages = buildPassages();
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return { text: 'an answer', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const { recordUsage } = collectUsage();

    await answerQuestion({
      provider,
      question: 'Some question',
      passages,
      model: 'claude-sonnet-5-20260101',
      recordUsage,
    });

    expect(capturedRequest?.model).toBe('claude-sonnet-5-20260101');
  });

  it('backward compatibility: omitting model still resolves the answer correctly and sends no model key (or an undefined one) to provider.complete', async () => {
    const passages = buildPassages();
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return { text: 'a plain answer', usage: { inputTokens: 8, outputTokens: 2 } };
    });
    const { recordUsage } = collectUsage();

    const result = await answerQuestion({
      provider,
      question: 'Some other question',
      passages,
      recordUsage,
    });

    expect(result.answer).toBe('a plain answer');
    expect(capturedRequest?.model).toBeUndefined();
  });
});

describe('answerQuestion — never logs prompt, passage, or completion content', () => {
  it('does not call console.log/console.error/console.warn while answering a question containing recognizable content', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const passages: QAPassage[] = [
      {
        objectId: 'obj-secret',
        title: 'SECRET-TITLE-MARKER-11111',
        snippet: 'SECRET-SNIPPET-MARKER-22222',
      },
    ];
    const provider = MockProvider.fixed({
      text: 'SECRET-COMPLETION-MARKER-33333',
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { recordUsage } = collectUsage();

    await answerQuestion({
      provider,
      question: 'SECRET-QUESTION-MARKER-44444',
      passages,
      recordUsage,
    });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();

    consoleLog.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});
