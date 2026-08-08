import { CLAUDE_HAIKU_4_5, CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';

/**
 * v1 model-routing heuristic (F1-T14 PR3): decides WHICH model
 * `performAIFieldRefresh` asks `resolveAIFieldValue` to use, before any
 * provider call happens. Deliberately simple -- not a rule engine -- and
 * based solely on the ai field's own `outputType`: a `'select'`-output field
 * is a constrained-choice task, cheap enough for the fast/cheap model
 * (`CLAUDE_HAIKU_4_5`); a `'text'`-output field is open-ended generation,
 * routed to the default/stronger model (`CLAUDE_SONNET_5`).
 */
export interface SelectAIModelInput {
  outputType: 'text' | 'select';
}

export function selectAIModel(input: SelectAIModelInput): string {
  return input.outputType === 'select' ? CLAUDE_HAIKU_4_5 : CLAUDE_SONNET_5;
}
