import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';
import type { DeviationExplanationContent, DeviationResult } from '@luminaos/artifacts';
import { deviationExplanationSchema } from '@luminaos/artifacts';
import type { AggregateFn, ObjectType } from '@luminaos/core-objects';

/**
 * The provider-facing, DB-free "explain a captured-vs-current metric
 * deviation" orchestrator (F3-T11 PR1, ADR-0045 Karar b/c): sibling of
 * `compileWidgetQuery` (`./compile-widget-query.ts`) -- provider/model/
 * recordUsage all injected, no Postgres/EventStore.
 *
 * Unlike `compileWidgetQuery`/`generateArtifact`, there is NO business-rule
 * allowlist layer here: the only "validation" is
 * `deviationExplanationSchema.safeParse`, since this orchestrator has zero
 * user-controllable free-text input beyond the documented aggregate/metadata
 * envelope (`objectType`/`aggregateFn`/`targetFieldKey`/`capturedValue`/
 * `currentValue`/`deviation`) -- there is no field-hallucination risk to
 * guard against (Human Decision 2, ADR-0045 Karar c/i).
 */
export interface ExplainDeviationInput {
  provider: AIProvider;
  objectType: ObjectType;
  aggregateFn: AggregateFn;
  targetFieldKey?: string;
  capturedValue: number;
  currentValue: number;
  deviation: DeviationResult;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface ExplainDeviationResult {
  content: DeviationExplanationContent | undefined;
  parseError: boolean;
  message?: string;
}

const EXPLAIN_EXHAUSTED_MESSAGE =
  'AI response could not be parsed into a valid deviation explanation after retry';

/** ADR-0045 Karar (c) — `percentChange === null` (baseline value was zero) is
 * rendered as this exact human-readable phrase, never as the literal string
 * "Infinity"/"NaN"/"null". */
function renderPercentChange(percentChange: number | null): string {
  return percentChange === null
    ? 'not computable (baseline value was zero)'
    : `${String(percentChange)}%`;
}

/**
 * Builds the prompt text from ONLY the documented aggregate/metadata inputs
 * (Human Decision 2, ADR-0045 Karar c/i) -- `objectType`/`aggregateFn`/
 * `targetFieldKey`/`capturedValue`/`currentValue`/`deviation.delta`/
 * `deviation.percentChange`/`deviation.direction` -- and nothing else.
 */
function renderExplainDeviationPrompt(input: {
  objectType: ObjectType;
  aggregateFn: AggregateFn;
  targetFieldKey?: string;
  capturedValue: number;
  currentValue: number;
  deviation: DeviationResult;
}): string {
  const { objectType, aggregateFn, targetFieldKey, capturedValue, currentValue, deviation } = input;

  return [
    'Explain the deviation between a captured baseline metric value and its current value.',
    'Respond with ONLY a JSON object (no surrounding text, no markdown fences) with exactly these fields:',
    '- summary: a short human-readable explanation string (1-2000 characters)',
    '- possibleCauses: an array of 1 to 5 short possible-cause strings (each 1-500 characters)',
    '',
    `Object type: ${objectType}`,
    `Aggregate function: ${aggregateFn}`,
    ...(targetFieldKey !== undefined ? [`Target field key: ${targetFieldKey}`] : []),
    `Captured (baseline) value: ${String(capturedValue)}`,
    `Current value: ${String(currentValue)}`,
    `Change (delta): ${String(deviation.delta)}`,
    `Percent change: ${renderPercentChange(deviation.percentChange)}`,
    `Direction: ${deviation.direction}`,
  ].join('\n');
}

function tryExplainDeviation(text: string): DeviationExplanationContent | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  const result = deviationExplanationSchema.safeParse(parsed);

  return result.success ? result.data : undefined;
}

export async function explainDeviation(
  input: ExplainDeviationInput,
): Promise<ExplainDeviationResult> {
  const prompt = renderExplainDeviationPrompt(input);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();
  const firstContent = tryExplainDeviation(firstResponse);

  if (firstContent !== undefined) {
    return { content: firstContent, parseError: false };
  }

  const retryResponse = await complete();
  const retryContent = tryExplainDeviation(retryResponse);

  if (retryContent !== undefined) {
    return { content: retryContent, parseError: false };
  }

  return { content: undefined, parseError: true, message: EXPLAIN_EXHAUSTED_MESSAGE };
}
