import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';

import { triggerSpecSchema } from '../automation/dto/create-trigger.schema.js';

import type { UsagePatternSummary } from './summarize-usage-patterns.js';

/**
 * `suggestTriggerTemplates` (ADR-0034 Karar (e)): the THIRD AI-call
 * orchestrator, mirroring `parseCommand`'s (`./parse-command.ts`) /
 * `extractMeetingActions`'s (`./extract-meeting-actions.ts`) exact
 * retry-once-then-sentinel shape -- the model responds with an ENVELOPE
 * object `{ suggestions: [...] }` (not a bare array), validated against a
 * zod schema built from `create-trigger.schema.ts`'s (now-exported)
 * `triggerSpecSchema` -- never re-written a third time.
 */
export interface SuggestTriggerTemplatesInput {
  provider: AIProvider;
  summary: UsagePatternSummary;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface TriggerTemplateCandidate {
  suggestionId: string;
  name: string;
  rationale: string;
  spec: z.infer<typeof triggerSpecSchema>;
}

export interface SuggestTriggerTemplatesResult {
  suggestions: TriggerTemplateCandidate[];
  parseError: boolean;
  message?: string;
}

const SUGGEST_EXHAUSTED_MESSAGE =
  'AI response could not be parsed into valid trigger template suggestions after retry';

const candidateSuggestionSchema = z
  .object({ name: z.string().min(1), rationale: z.string().min(1), spec: triggerSpecSchema })
  .strict();

const suggestTriggerTemplatesResponseSchema = z
  .object({ suggestions: z.array(candidateSuggestionSchema).max(5) })
  .strict();

function renderSuggestTriggerTemplatesPrompt(summary: UsagePatternSummary): string {
  const triggerLines =
    summary.activeTriggerSummaries.length > 0
      ? summary.activeTriggerSummaries.map((line) => `- ${line}`).join('\n')
      : '(none)';

  const groupLines =
    summary.groups.length > 0
      ? summary.groups
          .map((group) => {
            const examples = group.exampleCommands.map((command) => `"${command}"`).join(', ');
            return `- ${group.actionType} / ${group.outcome}: count=${String(group.count)}, examples: ${examples}`;
          })
          .join('\n')
      : '(none)';

  return [
    'You are suggesting new automation trigger templates based on a workspace usage-pattern summary.',
    '',
    'Currently active triggers:',
    triggerLines,
    '',
    'Recent decided command patterns (actionType / outcome, count, example commands):',
    groupLines,
    '',
    'Respond with ONLY a JSON object (no surrounding text, no markdown fences) of the exact shape:',
    '{"suggestions": [ { "name": string, "rationale": string, "spec": <TriggerSpec> }, ... ] }',
    '',
    'At most 5 suggestions. Each "spec" must be one of the following two shapes:',
    '- Scheduled: { "kind": "scheduled", "intervalMinutes": number, "actionTemplate": { "title": string } }',
    '- Condition: { "kind": "condition", "objectType": string, "fieldKey": string, "pattern": string, "flags": string, "actionTemplate": { "title": string } }',
    '',
    '"name" is a short human-readable trigger name, "rationale" briefly explains why this trigger template is suggested given the usage patterns above.',
  ].join('\n');
}

function tryParseSuggestions(text: string): TriggerTemplateCandidate[] | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  const result = suggestTriggerTemplatesResponseSchema.safeParse(parsed);

  if (!result.success) {
    return undefined;
  }

  return result.data.suggestions.map((suggestion) => ({
    ...suggestion,
    suggestionId: randomUUID(),
  }));
}

export async function suggestTriggerTemplates(
  input: SuggestTriggerTemplatesInput,
): Promise<SuggestTriggerTemplatesResult> {
  const prompt = renderSuggestTriggerTemplatesPrompt(input.summary);

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();
  const firstSuggestions = tryParseSuggestions(firstResponse);

  if (firstSuggestions !== undefined) {
    return { suggestions: firstSuggestions, parseError: false };
  }

  const retryResponse = await complete();
  const retrySuggestions = tryParseSuggestions(retryResponse);

  if (retrySuggestions !== undefined) {
    return { suggestions: retrySuggestions, parseError: false };
  }

  return { suggestions: [], parseError: true, message: SUGGEST_EXHAUSTED_MESSAGE };
}
