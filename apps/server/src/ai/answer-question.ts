import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';

/**
 * A single retrieved, RBAC-filtered passage of workspace content that
 * `answerQuestion` is allowed to cite as a source.
 */
export interface QAPassage {
  objectId: string;
  title: string;
  snippet: string;
}

/**
 * The provider-facing, DB-free "answer a question from retrieved passages"
 * orchestrator: sibling of `resolveAIFieldValue` (`./resolve-ai-field-value.ts`),
 * same shape -- provider/model/recordUsage all injected, no Postgres/EventStore.
 *
 * When `passages` is empty, this function never calls the provider at all: a
 * question that structurally cannot be answered (no retrieved content) must
 * cost nothing and must never reach the model, so it short-circuits to a
 * fixed "no relevant content" answer instead of risking hallucination.
 */
export interface AnswerQuestionInput {
  provider: AIProvider;
  question: string;
  passages: QAPassage[];
  /**
   * Which model the caller (via `selectAIModel({ outputType: 'qa' })`)
   * already decided to use -- forwarded as-is into `provider.complete(...)`.
   * Omitting it preserves the same "no model key sent" behavior as
   * `resolveAIFieldValue`.
   */
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface QAAnswer {
  answer: string;
  sources: QAPassage[];
}

const EMPTY_PASSAGES_ANSWER =
  'No relevant content was found in this workspace to answer this question.';

export async function answerQuestion(input: AnswerQuestionInput): Promise<QAAnswer> {
  if (input.passages.length === 0) {
    return { answer: EMPTY_PASSAGES_ANSWER, sources: [] };
  }

  const prompt = renderQAPrompt(input.question, input.passages);

  const result = await input.provider.complete({
    prompt,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  await input.recordUsage(result.usage);

  return { answer: result.text, sources: input.passages };
}

function renderQAPrompt(question: string, passages: QAPassage[]): string {
  const renderedPassages = passages
    .map((passage, index) => `[${String(index + 1)}] ${passage.title}\n${passage.snippet}`)
    .join('\n\n');

  return [
    'Answer the question below using only the information contained in the given passages.',
    'Do not invent or add information that is not present in the passages.',
    '',
    'Passages:',
    renderedPassages,
    '',
    `Question: ${question}`,
  ].join('\n');
}
