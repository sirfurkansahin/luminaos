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

  // F1-T15 PR3 (RED step) — widen `SelectAIModelInput['outputType']` to also
  // accept `'qa'` (the new RAG-style `answerQuestion` orchestration's output
  // type), routed to the SAME branch as `'text'`: answering a question from
  // retrieved passages is open-ended generation, not a constrained-choice
  // task, so it belongs on the default/stronger model (`CLAUDE_SONNET_5`).
  // This requires ZERO branching-logic change to `selectAIModel` itself --
  // `outputType !== 'select'` already falls through to `CLAUDE_SONNET_5` --
  // only the type union needs widening to `'text' | 'select' | 'qa'`.
  it("outputType: 'qa' routes to CLAUDE_SONNET_5 (RAG-style question-answering is open-ended generation, like 'text' -- not a constrained-choice task)", () => {
    // NOTE (intentional RED, not a typo): on `main`,
    // `SelectAIModelInput['outputType']` is only `'text' | 'select'`, so the
    // object literal below (`{ outputType: 'qa' }`) is a TypeScript compile
    // error -- "Argument of type '{ outputType: "qa"; }' is not assignable to
    // parameter of type 'SelectAIModelInput'" -- until `implementer` widens
    // the union. This repo's vitest config (`apps/server/vitest.config.ts`)
    // transforms tests via `unplugin-swc`, which strips types WITHOUT
    // type-checking them, so `pnpm --filter server test` alone will NOT
    // surface this failure -- only `pnpm typecheck` (`tsc`) will. Per
    // CLAUDE.md's Definition of Done, both `pnpm typecheck` and
    // `pnpm test:changed` must be green before this task is done, so this
    // compile error is a real, required RED signal, not a false negative.
    const model = selectAIModel({ outputType: 'qa' });

    expect(model).toBe(CLAUDE_SONNET_5);
  });

  // F1-T16 PR2 (RED step) — widen `SelectAIModelInput['outputType']` to also
  // accept `'command'` (the new `parseCommand` conversational-command
  // orchestration's output type, ADR-0015 §e), routed to the SAME branch as
  // `'text'`/`'qa'`: parsing a natural-language command into a set of
  // proposed actions is open-ended reasoning, not a constrained-choice task,
  // so it belongs on the default/stronger model (`CLAUDE_SONNET_5`). This
  // requires ZERO branching-logic change to `selectAIModel` itself --
  // `outputType !== 'select'` already falls through to `CLAUDE_SONNET_5` --
  // only the type union needs widening to
  // `'text' | 'select' | 'qa' | 'command'`.
  it("outputType: 'command' routes to CLAUDE_SONNET_5 (parsing a conversational command into proposed actions is open-ended reasoning, like 'text'/'qa' -- not a constrained-choice task)", () => {
    // NOTE (intentional RED, not a typo): on `main`,
    // `SelectAIModelInput['outputType']` is only `'text' | 'select' | 'qa'`,
    // so the object literal below (`{ outputType: 'command' }`) is a
    // TypeScript compile error -- "Argument of type '{ outputType: "command";
    // }' is not assignable to parameter of type 'SelectAIModelInput'" -- until
    // `implementer` widens the union. As established in F1-T15 PR3's RED step
    // above, this repo's vitest config (`apps/server/vitest.config.ts`)
    // transforms tests via `unplugin-swc`, which strips types WITHOUT
    // type-checking them, so `pnpm --filter server test` alone will NOT
    // surface this failure -- only `pnpm typecheck` (`tsc`) will. Per
    // CLAUDE.md's Definition of Done, both `pnpm typecheck` and
    // `pnpm test:changed` must be green before this task is done, so this
    // compile error is a real, required RED signal, not a false negative.
    const model = selectAIModel({ outputType: 'command' });

    expect(model).toBe(CLAUDE_SONNET_5);
  });

  // F2-T17 PR1 (RED step) — widen `SelectAIModelInput['outputType']` to also
  // accept `'triggerSuggestion'` (the new `suggestTriggerTemplates`
  // orchestration's output type, ADR-0034 Karar (e)), routed to the SAME
  // branch as `'text'`/`'qa'`/`'command'`: generating candidate trigger
  // templates from a usage-pattern summary is open-ended reasoning, not a
  // constrained-choice task, so it belongs on the default/stronger model
  // (`CLAUDE_SONNET_5`). This requires ZERO branching-logic change to
  // `selectAIModel` itself -- `outputType !== 'select'` already falls
  // through to `CLAUDE_SONNET_5` -- only the type union needs widening to
  // `'text' | 'select' | 'qa' | 'command' | 'triggerSuggestion'`.
  it("outputType: 'triggerSuggestion' routes to CLAUDE_SONNET_5 (generating trigger-template suggestions from a usage-pattern summary is open-ended reasoning, like 'text'/'qa'/'command' -- not a constrained-choice task)", () => {
    // NOTE (intentional RED, not a typo): on `main`,
    // `SelectAIModelInput['outputType']` is only `'text' | 'select' | 'qa' |
    // 'command'`, so the object literal below (`{ outputType:
    // 'triggerSuggestion' }`) is a TypeScript compile error -- "Argument of
    // type '{ outputType: "triggerSuggestion"; }' is not assignable to
    // parameter of type 'SelectAIModelInput'" -- until `implementer` widens
    // the union. As established above, this repo's vitest config
    // (`apps/server/vitest.config.ts`) transforms tests via `unplugin-swc`,
    // which strips types WITHOUT type-checking them, so
    // `pnpm --filter server test` alone will NOT surface this failure --
    // only `pnpm typecheck` (`tsc`) will. Per CLAUDE.md's Definition of Done,
    // both `pnpm typecheck` and `pnpm test:changed` must be green before this
    // task is done, so this compile error is a real, required RED signal,
    // not a false negative.
    const model = selectAIModel({ outputType: 'triggerSuggestion' });

    expect(model).toBe(CLAUDE_SONNET_5);
  });
});
