import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { extractDirectMessageReconfiguration } from './extract-direct-message-reconfiguration.js';

import type {
  ExtractDirectMessageReconfigurationResult,
  ProposedAction,
} from './extract-direct-message-reconfiguration.js';

/**
 * F3-T3 PR4 (RED step), ADR-0037 §4 — `extractDirectMessageReconfiguration`, a
 * NEW, DB-free, provider-injected sibling of `parseCommand`
 * (`./parse-command.ts`) and `extractMeetingActions`
 * (`./extract-meeting-actions.ts`). Mirrors `extract-meeting-actions.test.ts`'s
 * structure/`MockProvider` usage almost verbatim; the functional differences
 * from `extractMeetingActions` are: (1) its own prompt template, requesting
 * exactly ONE action of type `'reconfigureAgentPermissions'` (never zero,
 * never multiple), and (2) an EXTRA "exactly one" cardinality check layered
 * on top of the same per-type type-strictness check `extractMeetingActions`
 * already established.
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./extract-direct-message-reconfiguration.ts` does not exist yet on this
 * branch):
 *
 *   export interface ExtractDirectMessageReconfigurationInput {
 *     provider: AIProvider;
 *     dmMessageText: string;
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface ExtractDirectMessageReconfigurationResult {
 *     actions: ProposedAction[];
 *     parseError: boolean;   // true only on the double-failure fallback path
 *     message?: string;      // present only when parseError is true
 *   }
 *
 *   export function extractDirectMessageReconfiguration(
 *     input: ExtractDirectMessageReconfigurationInput,
 *   ): Promise<ExtractDirectMessageReconfigurationResult>;
 *
 * `ProposedAction`/`proposedActionSchema` are the SAME ones exported by
 * `./parse-command.ts` (ADR-0037 §4 -- the union stays in one place, widened
 * to a 6th member `'reconfigureAgentPermissions'`, per `./parse-command.test.ts`'s
 * own widening tests). This file re-exports `ProposedAction` as a type-only
 * import from `./extract-direct-message-reconfiguration.ts` for symmetry with
 * `extract-meeting-actions.test.ts`'s own import style -- `implementer` may
 * either re-export the type from `parse-command.ts` or re-declare an
 * identical alias; either satisfies these tests, since only shape is
 * asserted, never identity.
 *
 * `params` shape (opaque to this function -- it does NOT interpret/validate
 * `operation`/`dataScope`/`actionTypes`/`timeWindow` content, that is
 * `CommandsService.executeReconfigureAgentPermissions`'s job, PR4's OTHER
 * addition):
 *   { agentIdentifier: string, operation: 'grant' | 'revoke',
 *     dataScope?: { objectTypes: string[] | 'all' }, actionTypes?: string[],
 *     timeWindow?: { startsAt: string | null, expiresAt: string | null } }
 * (ISO-8601 strings for the date fields -- real `Date` parsing happens later,
 * at execute-time, never here.)
 *
 * ---
 *
 * ## Design decision: TWO independent post-schema-validation checks (this
 * file's own contribution, layered ON TOP of `extractMeetingActions`'s
 * existing single "wrong type" check -- REQUIRED reading for `implementer`)
 *
 * `proposedActionSchema` (widened to 6 members per ADR-0037 §4) structurally
 * accepts an ARRAY of any length whose elements may be any of the 6 types.
 * This function's own prompt asks for EXACTLY ONE element, always typed
 * `'reconfigureAgentPermissions'` -- a DM proposes exactly one reconfiguration
 * per message, never zero, never multiple (ADR-0037 §4's own text: "bir DM
 * tam olarak bir yeniden-yapılandırma önerir").
 *
 * Decision: after `proposedActionSchema.safeParse` succeeds, this function
 * MUST additionally reject (as a validation failure, triggering the SAME
 * retry-once-then-fallback path as malformed/schema-invalid JSON) a response
 * that violates EITHER of:
 *   (a) `result.data.length === 1` (not 0, not 2+), AND
 *   (b) `result.data.every((a) => a.type === 'reconfigureAgentPermissions')`
 * Both are enforced together -- an array of exactly 1 element but the WRONG
 * type fails just as much as an array of 2 elements both of the right type.
 *
 * Rationale mirrors `extract-meeting-actions.test.ts`'s own design-decision
 * comment (symmetry with `parseCommand`'s closed-union discipline, downstream
 * correctness of `executeReconfigureAgentPermissions`'s single-action
 * dispatch, audit-trail integrity of the `ActionsProposed` event) -- not
 * repeated verbatim here for brevity, see that file's header comment for the
 * full reasoning; the only NEW element is the cardinality check.
 *
 * ---
 *
 * Behavior pinned by the tests below:
 *
 *  a. Happy path (valid JSON, single `reconfigureAgentPermissions` action,
 *     first attempt): `provider.complete` called exactly ONCE, `recordUsage`
 *     called exactly once, returns `{ actions: [...], parseError: false }`
 *     with NO `message` key, exactly 1 action, `params` round-trips
 *     `agentIdentifier`/`operation`/`dataScope`/`actionTypes`/`timeWindow`
 *     opaquely.
 *  b. Retry-once on malformed JSON, second attempt succeeds.
 *  c. Retry-once on schema-invalid JSON (missing `intent`), second attempt
 *     succeeds.
 *  d. Retry-once when the first attempt is schema-valid per the SHARED
 *     6-type union but has the WRONG type (e.g. echoes `'createTask'`) --
 *     this function's own type-strictness rule -- second attempt succeeds.
 *  e. Retry-once when the first attempt is schema-valid, all-correct-type,
 *     but returns TWO actions instead of exactly one -- this function's own
 *     EXTRA cardinality rule (no precedent in `extractMeetingActions`, which
 *     allows any positive count) -- second attempt (exactly one) succeeds.
 *  f. Double failure -- both attempts have the wrong (but schema-valid) type:
 *     safe fallback, never throws, `{ actions: [], parseError: true,
 *     message }`, exactly 2 provider calls.
 *  g. Double failure -- both attempts return 2 correctly-typed actions:
 *     same safe-fallback shape.
 *  h. Double failure -- both attempts unparseable JSON: same safe-fallback
 *     shape.
 *  i. `actionId` generation: the single returned action gets a fresh,
 *     non-empty, UUID-shaped `actionId`, even when the model supplied none.
 *  j. `model` forwarding: present in `provider.complete({ prompt, model })`
 *     when given; omitted entirely when not provided.
 *  k. No content logging: DM message text / parsed-action content must never
 *     reach `console.log`/`console.error`/`console.warn`.
 *
 * Nothing under test here exists yet: `./extract-direct-message-reconfiguration.ts`
 * has not been written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

/** A single, schema-valid `reconfigureAgentPermissions` action, WITHOUT an
 * `actionId` field -- per this file's design decision, the model is never
 * expected to supply one. `params` carries the full grant-shaped payload so
 * the happy-path test can prove it round-trips opaquely. */
function validReconfigurationActionJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'reconfigureAgentPermissions',
    intent: 'Grant the answer-question skill to agent triage-bot',
    rationale: 'The user explicitly asked, via DM, to let triage-bot answer questions',
    resources: ['triage-bot'],
    rollbackNote: 'Revoke the manifest for triage-bot if this was a mistake',
    params: {
      agentIdentifier: 'triage-bot',
      operation: 'grant',
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    },
    ...overrides,
  };
}

describe('extractDirectMessageReconfiguration — happy path (valid JSON on the first attempt)', () => {
  it('calls provider.complete exactly once, records usage exactly once, and returns { actions: [...], parseError: false } with no message key; params round-trips agentIdentifier/operation/dataScope/actionTypes/timeWindow opaquely', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify([validReconfigurationActionJson()]),
        usage: { inputTokens: 45, outputTokens: 14 },
      };
    });
    const { recordUsage } = collectUsage();

    const result: ExtractDirectMessageReconfigurationResult =
      await extractDirectMessageReconfiguration({
        provider,
        dmMessageText: 'Please let triage-bot answer questions in this workspace.',
        recordUsage,
      });

    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 45, outputTokens: 14 });

    expect(result.parseError).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.actions).toHaveLength(1);

    const [action] = result.actions;
    expect(action?.type).toBe('reconfigureAgentPermissions');
    expect(action?.intent).toBe('Grant the answer-question skill to agent triage-bot');
    expect(action?.rationale).toBe(
      'The user explicitly asked, via DM, to let triage-bot answer questions',
    );
    expect(action?.resources).toEqual(['triage-bot']);
    expect(action?.rollbackNote).toBe('Revoke the manifest for triage-bot if this was a mistake');
    expect(action?.params).toEqual({
      agentIdentifier: 'triage-bot',
      operation: 'grant',
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    });
  });
});

describe('extractDirectMessageReconfiguration — retry-once on malformed/invalid JSON', () => {
  it('retries with the IDENTICAL prompt exactly once when the first response is not valid JSON, and returns the successfully-parsed second attempt', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not json at all', usage: { inputTokens: 30, outputTokens: 5 } }
        : {
            text: JSON.stringify([validReconfigurationActionJson()]),
            usage: { inputTokens: 30, outputTokens: 8 },
          };
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Please reconfigure the agent.',
      recordUsage,
    });

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.prompt).toBe(capturedRequests[1]?.prompt);

    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 30, outputTokens: 5 });
    expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 30, outputTokens: 8 });

    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe('reconfigureAgentPermissions');
  });

  it('also retries when the first response is syntactically valid JSON but fails schema validation (e.g. missing the required "intent" field)', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        const withoutIntent = Object.fromEntries(
          Object.entries(validReconfigurationActionJson()).filter(([key]) => key !== 'intent'),
        );
        return {
          text: JSON.stringify([withoutIntent]),
          usage: { inputTokens: 20, outputTokens: 4 },
        };
      }
      return {
        text: JSON.stringify([validReconfigurationActionJson()]),
        usage: { inputTokens: 20, outputTokens: 6 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Please reconfigure the agent.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
  });

  it("retries when the first response is schema-valid per the SHARED 6-type union but has the WRONG type for this function (e.g. the model echoes 'createTask' instead of 'reconfigureAgentPermissions') -- this function's own type-strictness rule, not a schema violation", async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify([validReconfigurationActionJson({ type: 'createTask' })]),
          usage: { inputTokens: 18, outputTokens: 3 },
        };
      }
      return {
        text: JSON.stringify([validReconfigurationActionJson()]),
        usage: { inputTokens: 18, outputTokens: 7 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Please reconfigure the agent.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe('reconfigureAgentPermissions');
  });

  it('retries when the first response is schema-valid and correctly-typed but returns TWO actions instead of exactly one -- this function’s own EXTRA cardinality rule (a DM proposes exactly one reconfiguration, never multiple)', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify([
            validReconfigurationActionJson(),
            validReconfigurationActionJson({ params: { agentIdentifier: 'second-bot' } }),
          ]),
          usage: { inputTokens: 22, outputTokens: 9 },
        };
      }
      return {
        text: JSON.stringify([validReconfigurationActionJson()]),
        usage: { inputTokens: 22, outputTokens: 6 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Please reconfigure the agent.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
  });
});

describe('extractDirectMessageReconfiguration — double failure (safe fallback, no fabricated actions)', () => {
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

    const result: ExtractDirectMessageReconfigurationResult =
      await extractDirectMessageReconfiguration({
        provider,
        dmMessageText: 'Ambiguous DM with no clear reconfiguration request.',
        recordUsage,
      });

    expect(callCount).toBe(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);

    expect(result.actions).toEqual([]);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });

  it('never throws; falls back to { actions: [], parseError: true, message } when BOTH attempts are schema-valid per the shared union but have the WRONG type', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify([validReconfigurationActionJson({ type: 'assignPeople' })]),
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Ambiguous DM with no clear reconfiguration request.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.actions).toEqual([]);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
  });

  it('never throws; falls back to { actions: [], parseError: true, message } when BOTH attempts return two correctly-typed actions instead of exactly one', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify([
          validReconfigurationActionJson(),
          validReconfigurationActionJson({ params: { agentIdentifier: 'second-bot' } }),
        ]),
        usage: { inputTokens: 14, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Ambiguous DM with no clear reconfiguration request.',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.actions).toEqual([]);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
  });
});

describe('extractDirectMessageReconfiguration — actionId generation', () => {
  it("assigns a fresh, non-empty, UUID-shaped actionId to the single returned action, even when the model's JSON included no actionId field at all", async () => {
    const provider = MockProvider.fixed({
      text: JSON.stringify([validReconfigurationActionJson()]),
      usage: { inputTokens: 25, outputTokens: 9 },
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Please reconfigure the agent.',
      recordUsage,
    });

    expect(result.actions).toHaveLength(1);
    const [action] = result.actions;
    expect(action?.actionId).toEqual(expect.any(String));
    expect(action?.actionId.length).toBeGreaterThan(0);
    expect(action?.actionId).toMatch(UUID_SHAPE);
  });
});

describe('extractDirectMessageReconfiguration — model forwarding', () => {
  it('when the caller passes model, provider.complete(...) receives that exact model alongside the rendered prompt', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify([validReconfigurationActionJson()]),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Please reconfigure the agent.',
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
        text: JSON.stringify([validReconfigurationActionJson()]),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'Please reconfigure the agent.',
      recordUsage,
    });

    expect(result.parseError).toBe(false);
    expect(capturedRequest?.model).toBeUndefined();
  });
});

describe('extractDirectMessageReconfiguration — never logs DM message or parsed-action content', () => {
  it('does not call console.log/console.error/console.warn while extracting a reconfiguration from a DM containing recognizable content', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = MockProvider.fixed({
      text: JSON.stringify([
        validReconfigurationActionJson({
          intent: 'SECRET-INTENT-MARKER-11111',
          rationale: 'SECRET-RATIONALE-MARKER-22222',
        }),
      ]),
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { recordUsage } = collectUsage();

    await extractDirectMessageReconfiguration({
      provider,
      dmMessageText: 'SECRET-DM-MARKER-33333',
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

/** Re-exported purely so this file type-checks against `ProposedAction`
 * without an unused-import lint error -- mirrors `extract-meeting-actions.test.ts`'s
 * identical `ProposedAction` type-only import usage pattern. */
void (null as unknown as ProposedAction);
