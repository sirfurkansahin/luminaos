import { describe, expect, it } from 'vitest';

import { CLAUDE_HAIKU_4_5, CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';

import { selectAIModel } from './select-ai-model.js';

/**
 * F1-T14 PR3 (RED step) — `selectAIModel`, the pure v1 model-routing
 * heuristic that decides WHICH model `performAIFieldRefresh` asks
 * `resolveAIFieldValue` to use, before any provider call happens.
 *
 * v1 heuristic (per this task's spec, deliberately simple — not a rule
 * engine): a `'select'`-output field is a constrained-choice task, cheap
 * enough for the fast/cheap model (`CLAUDE_HAIKU_4_5`); a `'text'`-output
 * field is open-ended generation, routed to the default/stronger model
 * (`CLAUDE_SONNET_5`).
 *
 * Nothing under test exists yet: `./select-ai-model.ts` (and its exported
 * `selectAIModel`/`SelectAIModelInput`) has not been written -- every
 * assertion below is expected to fail with a module-not-found error until
 * `implementer` adds it.
 */
describe('selectAIModel', () => {
  it("outputType: 'select' routes to CLAUDE_HAIKU_4_5 (constrained-choice tasks are cheap enough for the fast model)", () => {
    const model = selectAIModel({ outputType: 'select' });

    expect(model).toBe(CLAUDE_HAIKU_4_5);
  });

  it("outputType: 'text' routes to CLAUDE_SONNET_5 (open-ended generation gets the default/stronger model)", () => {
    const model = selectAIModel({ outputType: 'text' });

    expect(model).toBe(CLAUDE_SONNET_5);
  });
});
