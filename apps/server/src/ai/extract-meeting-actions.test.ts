import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { extractMeetingActions } from './extract-meeting-actions.js';

import type { ExtractMeetingActionsResult, ProposedAction } from './extract-meeting-actions.js';

/**
 * F2-T14 PR3 (RED step) — `extractMeetingActions`, a NEW, DB-free,
 * provider-injected sibling of `parseCommand` (`./parse-command.ts`), per
 * ADR-0031 §e. Mirrors `parse-command.test.ts`'s structure/`MockProvider`
 * usage almost verbatim; the only functional differences are (1) its own
 * prompt template, requesting exactly ONE action type instead of three, and
 * (2) the extra type-strictness rule documented below.
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./extract-meeting-actions.ts` does not exist yet on this branch):
 *
 *   export interface ExtractMeetingActionsInput {
 *     provider: AIProvider;
 *     transcriptText: string;
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface ExtractMeetingActionsResult {
 *     actions: ProposedAction[];
 *     parseError: boolean;   // true only on the double-failure fallback path
 *     message?: string;      // present only when parseError is true
 *   }
 *
 *   export function extractMeetingActions(
 *     input: ExtractMeetingActionsInput,
 *   ): Promise<ExtractMeetingActionsResult>;
 *
 * `ProposedAction`/`proposedActionSchema` are the SAME ones exported by
 * `./parse-command.ts` (ADR-0031 §e — the union stays in one place, widened
 * to include `'createTaskFromMeeting'`; not duplicated/moved to a shared
 * package). This file re-exports `ProposedAction` as a type-only import from
 * `./extract-meeting-actions.ts` for symmetry with `parse-command.test.ts`'s
 * own import style — `implementer` may either re-export the type from
 * `parse-command.ts` or re-declare an identical alias; either satisfies
 * these tests, since only shape is asserted, never identity.
 *
 * ---
 *
 * ## Type-strictness design decision (this file's own contribution, no
 * direct precedent in `parse-command.test.ts` — REQUIRED reading for
 * `implementer` before writing the retry loop)
 *
 * `proposedActionSchema` (widened per ADR-0031 §e) now structurally accepts
 * FOUR types: `'createTask' | 'generateSubtasks' | 'assignPeople' |
 * 'createTaskFromMeeting'`. That widening was done in ONE shared place
 * deliberately (ADR-0031 §e's own words: "aynı zod şemasının iki farklı
 * üretim kod yolu tarafından paylaşılmasının ... hiçbir çapraz-kirlenme
 * riski taşımadığını gösterir" — sharing the schema across two production
 * code paths is harmless BECAUSE each path is expected to additionally
 * enforce, at the APPLICATION level, that it only ever emits the one type
 * its OWN prompt actually requested).
 *
 * Decision: **`extractMeetingActions` MUST additionally reject (as a
 * validation failure, not silently accept or silently filter out) any
 * returned action whose `type` is not EXACTLY `'createTaskFromMeeting'`,
 * even though such a `type` value is perfectly valid per the shared,
 * 4-member `proposedActionSchema`.** A same-shaped-but-wrong-type action
 * (e.g. the model echoing `'createTask'` in response to THIS function's own
 * prompt, which never mentions any other type) triggers the SAME
 * retry-once-then-fallback path that malformed JSON and schema-invalid JSON
 * already trigger in `parseCommand` -- it is never returned as-is, and it is
 * never dropped from the array while keeping the rest (an all-or-nothing
 * per-attempt validation, mirroring how `parseCommand`'s existing
 * closed-union test treats one out-of-union element as invalidating the
 * WHOLE array for that attempt, not a per-element filter).
 *
 * Rationale:
 *   1. Symmetry with `parseCommand`'s own existing discipline: `parseCommand`
 *      already treats an out-of-(3-type)-union `type` as a validation
 *      failure enforced "not just by prompt wording" (see
 *      `parse-command.test.ts`'s "closed action-type union is enforced by
 *      zod, not just prompt wording" describe block). Since the union was
 *      widened to 4 members specifically so a SECOND, narrower producer
 *      could exist, that second producer needs its OWN, narrower
 *      enforcement layer on top of the shared (now looser) schema -- the
 *      schema no longer fully captures "this is valid FOR THIS CALLER",
 *      only "this is valid for SOME caller in this codebase".
 *   2. Downstream correctness: PR4's `CommandsService.executeDecidedAction`
 *      switches on `action.type`, with `createTaskFromMeeting` routed to a
 *      dedicated, ISOLATED branch (`executeCreateTaskFromMeeting`, ADR-0031
 *      §h) that reads meeting-specific `params` (`title`/`assigneeHint`/
 *      `dueDateHint`). If `extractMeetingActions` silently let through a
 *      `createTask`-typed action (whose `params` shape/semantics were never
 *      validated against the meeting-extraction prompt's contract), that
 *      action would either be mis-routed or silently mishandled several
 *      layers downstream, in a module (`commands`) this PR does not touch
 *      and cannot re-validate. Fail-closed at the extraction boundary itself
 *      is strictly safer than trusting every downstream consumer to
 *      re-check `type` before touching `params`.
 *   3. Audit-trail integrity: `ProposedAction.type` is written verbatim into
 *      the `ActionsProposed` event `params` (ADR-0031 §h's
 *      `MEETING_ACTION_EXTRACTOR_ACTOR`) -- an event log entry attributed to
 *      "the meeting-action-extractor" that actually contains a `createTask`
 *      action would misrepresent, in an IMMUTABLE audit record, which
 *      pipeline actually decided to propose it.
 *
 * This is a REASONED CHOICE, not a schema-level given (ADR-0031's own text
 * says explicitly it does not pin this exact validation-strictness detail).
 * `implementer` must implement it exactly as described above -- an
 * additional post-schema-validation check inside this file's own
 * `tryParseActions`-equivalent, not a change to the shared
 * `proposedActionSchema` itself (which correctly stays permissive, per
 * ADR-0031 §e).
 *
 * ---
 *
 * Behavior pinned by the tests below:
 *
 *  a. Happy path (valid JSON, `createTaskFromMeeting`-typed, first attempt):
 *     `provider.complete` called exactly ONCE, `recordUsage` called exactly
 *     once, returns `{ actions: [...], parseError: false }` with NO
 *     `message` key. The valid action's `params` includes `title`,
 *     `assigneeHint`, AND `dueDateHint` -- proving all three round-trip
 *     through `params` as an opaque object (this function does NOT
 *     interpret/validate hint content -- that is `CommandsService`'s job,
 *     PR4).
 *  b. Retry-once on malformed JSON, second attempt succeeds: IDENTICAL
 *     prompt both times, `recordUsage` called twice.
 *  c. Retry-once on schema-invalid JSON (missing `intent`), second attempt
 *     succeeds.
 *  d. Retry-once when the first attempt is syntactically valid AND
 *     schema-valid per the SHARED schema, but has the WRONG (non
 *     `createTaskFromMeeting`) type -- this function's own extra
 *     type-strictness rule (see design decision above) -- second attempt
 *     (correct type) succeeds.
 *  e. Double failure -- both attempts have the wrong (but schema-valid)
 *     type: safe fallback, never throws, `{ actions: [], parseError: true,
 *     message }`, exactly 2 provider calls, exactly 2 `recordUsage` calls.
 *  f. Double failure -- both attempts unparseable JSON: same safe-fallback
 *     shape, exactly 2 provider calls.
 *  g. `actionId` generation: every returned action gets a fresh, non-empty,
 *     UUID-shaped, distinct `actionId`, even when the model supplied none.
 *  h. `model` forwarding: present in `provider.complete({ prompt, model })`
 *     when given; omitted entirely when not provided.
 *  i. No content logging: transcript text / parsed-action content must
 *     never reach `console.log`/`console.error`/`console.warn`.
 *
 * Nothing under test here exists yet: `./extract-meeting-actions.ts` has not
 * been written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

/** A single, schema-valid `createTaskFromMeeting` action, WITHOUT an
 * `actionId` field -- per this file's design decision (mirroring
 * `parse-command.test.ts`), the model is never expected to supply one.
 * `params` carries all three meeting-specific hint fields so the happy-path
 * test can prove they round-trip opaquely. */
function validMeetingActionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'createTaskFromMeeting',
    intent: 'Create a task to follow up on the Q3 roadmap review action item',
    rationale: 'The transcript explicitly assigned this follow-up during the meeting',
    resources: ['meeting-obj-456'],
    rollbackNote: 'Delete the created task if this was extracted in error',
    params: {
      title: 'Follow up on Q3 roadmap review',
      assigneeHint: 'jane@example.com',
      dueDateHint: '2026-09-15',
    },
    ...overrides,
  };
}

describe('extractMeetingActions — happy path (valid JSON on the first attempt)', () => {
  it('calls provider.complete exactly once, records usage exactly once, and returns { actions: [...], parseError: false } with no message key; params round-trips title/assigneeHint/dueDateHint opaquely', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify([validMeetingActionJson()]),
        usage: { inputTokens: 60, outputTokens: 18 },
      };
    });
    const { recordUsage } = collectUsage();

    const result: ExtractMeetingActionsResult = await extractMeetingActions({
      provider,
      transcriptText: 'Jane: I will follow up on the Q3 roadmap review by next Tuesday.',
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 60, outputTokens: 18 });

    expect(result.parseError).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.actions).toHaveLength(1);

    const [action] = result.actions;
    expect(action?.type).toBe('createTaskFromMeeting');
    expect(action?.intent).toBe('Create a task to follow up on the Q3 roadmap review action item');
    expect(action?.rationale).toBe(
      'The transcript explicitly assigned this follow-up during the meeting',
    );
    expect(action?.resources).toEqual(['meeting-obj-456']);
    expect(action?.rollbackNote).toBe('Delete the created task if this was extracted in error');
    expect(action?.params).toEqual({
      title: 'Follow up on Q3 roadmap review',
      assigneeHint: 'jane@example.com',
      dueDateHint: '2026-09-15',
    });
  });
});

describe('extractMeetingActions — retry-once on malformed/invalid JSON', () => {
  it('retries with the IDENTICAL prompt exactly once when the first response is not valid JSON, and returns the successfully-parsed second attempt', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not json at all', usage: { inputTokens: 30, outputTokens: 5 } }
        : {
            text: JSON.stringify([validMeetingActionJson()]),
            usage: { inputTokens: 30, outputTokens: 8 },
          };
    });
    const { recordUsage } = collectUsage();

    const result = await extractMeetingActions({
      provider,
      transcriptText: 'Some transcript text about follow-up actions.',
      recordUsage,
    });

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.prompt).toBe(capturedRequests[1]?.prompt);

    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 30, outputTokens: 5 });
    expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 30, outputTokens: 8 });

    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe('createTaskFromMeeting');
  });

  it('also retries when the first response is syntactically valid JSON but fails schema validation (e.g. missing the required "intent" field)', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        const withoutIntent = Object.fromEntries(
          Object.entries(validMeetingActionJson()).filter(([key]) => key !== 'intent'),
        );
        return {
          text: JSON.stringify([withoutIntent]),
          usage: { inputTokens: 20, outputTokens: 4 },
        };
      }
      return {
        text: JSON.stringify([validMeetingActionJson()]),
        usage: { inputTokens: 20, outputTokens: 6 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractMeetingActions({
      provider,
      transcriptText: 'Some transcript text about follow-up actions.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
  });

  it("retries when the first response is schema-valid per the SHARED 4-type union but has the WRONG type for this function (e.g. the model echoes 'createTask' instead of 'createTaskFromMeeting') -- this function's own extra type-strictness rule, not a schema violation", async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify([validMeetingActionJson({ type: 'createTask' })]),
          usage: { inputTokens: 18, outputTokens: 3 },
        };
      }
      return {
        text: JSON.stringify([validMeetingActionJson()]),
        usage: { inputTokens: 18, outputTokens: 7 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractMeetingActions({
      provider,
      transcriptText: 'Some transcript text about follow-up actions.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe('createTaskFromMeeting');
  });
});

describe('extractMeetingActions — double failure (safe fallback, no fabricated actions)', () => {
  it('never throws; returns { actions: [], parseError: true, message } when BOTH attempts are unparseable/invalid, and never attempts a third call', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: `still not json (attempt ${String(callCount)})`,
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const { recordUsage } = collectUsage();

    const result: ExtractMeetingActionsResult = await extractMeetingActions({
      provider,
      transcriptText: 'Ambiguous transcript with no clear action items.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);

    expect(result.actions).toEqual([]);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });

  it('never throws; falls back to { actions: [], parseError: true, message } when BOTH attempts are schema-valid per the shared union but have the WRONG type for this function', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify([validMeetingActionJson({ type: 'assignPeople' })]),
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractMeetingActions({
      provider,
      transcriptText: 'Ambiguous transcript with no clear action items.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.actions).toEqual([]);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
  });
});

describe('extractMeetingActions — actionId generation', () => {
  it("assigns a fresh, non-empty, UUID-shaped actionId to every returned action, even when the model's JSON included no actionId field at all", async () => {
    const provider = MockProvider.fixed({
      text: JSON.stringify([
        validMeetingActionJson({ resources: ['meeting-obj-1'] }),
        validMeetingActionJson({ resources: ['meeting-obj-1'], params: { title: 'Second task' } }),
      ]),
      usage: { inputTokens: 25, outputTokens: 9 },
    });
    const { recordUsage } = collectUsage();

    const result = await extractMeetingActions({
      provider,
      transcriptText: 'A transcript with two distinct follow-up items.',
      recordUsage,
    });

    expect(result.actions).toHaveLength(2);
    for (const action of result.actions) {
      expect(action.actionId).toEqual(expect.any(String));
      expect(action.actionId.length).toBeGreaterThan(0);
      expect(action.actionId).toMatch(UUID_SHAPE);
    }
    const ids = result.actions.map((action: ProposedAction) => action.actionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('extractMeetingActions — model forwarding', () => {
  it('when the caller passes model, provider.complete(...) receives that exact model alongside the rendered prompt', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify([validMeetingActionJson()]),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    await extractMeetingActions({
      provider,
      transcriptText: 'A transcript with one follow-up item.',
      model: 'claude-sonnet-5-20260101',
      recordUsage,
    });

    expect(capturedRequest?.model).toBe('claude-sonnet-5-20260101');
  });

  it('backward compatibility: omitting model still parses correctly and sends no model key (or an undefined one) to provider.complete', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify([validMeetingActionJson()]),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractMeetingActions({
      provider,
      transcriptText: 'A transcript with one follow-up item.',
      recordUsage,
    });

    expect(result.parseError).toBe(false);
    expect(capturedRequest?.model).toBeUndefined();
  });
});

describe('extractMeetingActions — never logs transcript or parsed-action content', () => {
  it('does not call console.log/console.error/console.warn while extracting actions from a transcript containing recognizable content', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = MockProvider.fixed({
      text: JSON.stringify([
        validMeetingActionJson({
          intent: 'SECRET-INTENT-MARKER-11111',
          rationale: 'SECRET-RATIONALE-MARKER-22222',
        }),
      ]),
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { recordUsage } = collectUsage();

    await extractMeetingActions({
      provider,
      transcriptText: 'SECRET-TRANSCRIPT-MARKER-33333',
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
