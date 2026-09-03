import { CLAUDE_HAIKU_4_5, CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';

/**
 * v1 model-routing heuristic (F1-T14 PR3): decides WHICH model
 * `performAIFieldRefresh` asks `resolveAIFieldValue` to use, before any
 * provider call happens. Deliberately simple -- not a rule engine -- and
 * based solely on the ai field's own `outputType`: a `'select'`-output field
 * is a constrained-choice task, cheap enough for the fast/cheap model
 * (`CLAUDE_HAIKU_4_5`); a `'text'`-output field is open-ended generation,
 * routed to the default/stronger model (`CLAUDE_SONNET_5`).
 *
 * `'qa'` (F1-T15 PR3, `answerQuestion`'s RAG-style question-answering output)
 * routes the same way as `'text'`: answering a question from retrieved
 * passages is open-ended generation, not a constrained-choice task, so it
 * belongs on the default/stronger model too.
 *
 * `'command'` (F1-T16 PR2, `parseCommand`'s conversational-command output,
 * ADR-0015 §e) routes the same way as `'text'`/`'qa'`: parsing a
 * natural-language command into a set of proposed actions is open-ended
 * reasoning, not a constrained-choice task, so it belongs on the
 * default/stronger model too.
 *
 * `'triggerSuggestion'` (F2-T17 PR1, `suggestTriggerTemplates`'s output,
 * ADR-0034 Karar (e)) routes the same way as `'text'`/`'qa'`/`'command'`:
 * generating candidate trigger templates from a usage-pattern summary is
 * open-ended reasoning, not a constrained-choice task, so it belongs on the
 * default/stronger model too.
 */
export interface SelectAIModelInput {
  outputType: 'text' | 'select' | 'qa' | 'command' | 'triggerSuggestion';
}

export function selectAIModel(input: SelectAIModelInput): string {
  return input.outputType === 'select' ? CLAUDE_HAIKU_4_5 : CLAUDE_SONNET_5;
}
