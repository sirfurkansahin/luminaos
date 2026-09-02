import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { parseCommand, proposedActionSchema } from './parse-command.js';

import type { ParseCommandResult, ProposedAction } from './parse-command.js';

/**
 * F1-T16 PR2 (RED step) — `parseCommand`, a NEW, DB-free, pure "turn a
 * natural-language command into a validated array of proposed actions"
 * orchestrator: sibling of `resolveAIFieldValue`
 * (`./resolve-ai-field-value.ts`) and `answerQuestion` (`./answer-question.ts`)
 * -- provider/model/recordUsage all injected, no Postgres/EventStore,
 * exercised directly against `MockProvider`. Per ADR-0015 §e, the structured
 * output is obtained via JSON-prompt + zod validation, NOT a new
 * `AIProvider` mode -- `AIProvider.complete()`'s contract is untouched.
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./parse-command.ts` does not exist yet on this branch):
 *
 *   export interface ProposedAction {
 *     actionId: string;
 *     type: 'createTask' | 'generateSubtasks' | 'assignPeople';
 *     intent: string;
 *     rationale: string;
 *     resources: string[];
 *     rollbackNote: string;
 *     params: Record<string, unknown>;
 *   }
 *
 *   export interface ParseCommandInput {
 *     provider: AIProvider;
 *     command: string;
 *     sourceObjectId?: string;
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface ParseCommandResult {
 *     actions: ProposedAction[];
 *     parseError: boolean;   // true only on the double-failure fallback path
 *     message?: string;      // present only when parseError is true
 *   }
 *
 *   export function parseCommand(input: ParseCommandInput): Promise<ParseCommandResult>;
 *
 * Response-shape design decision (pinned by the tests below, since ADR-0015
 * §a only fixes the EVENT payload's `actions` shape, not the raw model
 * response format): the model is prompted to reply with a JSON ARRAY of
 * action objects directly (`[{ type, intent, rationale, resources, params,
 * rollbackNote }, ...]`) -- NOT wrapped in an envelope object -- mirroring
 * how `resolveAIFieldValue`'s `outputType: 'select'` expects the model's
 * entire response text to BE the value, not a wrapper around it.
 *
 * `actionId` design decision (point e of this PR's task, no existing
 * precedent in `answerQuestion`/`resolveAIFieldValue` -- neither generates
 * ids, both are pure orchestration with no id concerns): `parseCommand`
 * itself assigns a fresh `actionId` via `crypto.randomUUID()` to every
 * successfully-validated action AFTER parsing, rather than trusting the
 * model to supply a collision-free id. Rationale: `actionId` must be a
 * stable, unique handle a future `decide` call (ADR-0015 §f, a later PR's
 * concern) can reference -- a model-supplied id could collide across
 * actions/proposals or simply be absent, and validating cross-action
 * uniqueness of a model-supplied string is strictly more failure-prone than
 * the orchestrator minting its own. The JSON schema therefore does NOT
 * require (or even accept as meaningful) an `actionId` field from the model
 * at all; the retry-vs-fallback validation below only ever inspects
 * `type`/`intent`/`rationale`/`resources`/`rollbackNote`/`params`.
 *
 * Behavior pinned by the tests below:
 *
 *  a. Happy path (valid JSON, first attempt): `provider.complete` called
 *     exactly ONCE, `recordUsage` called exactly once, returns
 *     `{ actions: [...], parseError: false }` with NO `message` key.
 *  b. Retry-once on malformed/invalid JSON, second attempt succeeds:
 *     `provider.complete` called exactly TWICE with an IDENTICAL `prompt`
 *     both times (mirroring `resolve-ai-field-value.test.ts`'s select-retry
 *     assertion style) -- returns the successfully-parsed result from the
 *     SECOND attempt. `recordUsage` is called once PER `provider.complete`
 *     call (i.e. twice total here) -- mirroring `resolveAIFieldValue`'s own
 *     `complete()` closure, which calls `input.recordUsage(result.usage)`
 *     unconditionally on every provider call, success or content-validation
 *     failure alike (`resolve-ai-field-value.ts` lines 45-52, invoked once
 *     for the first attempt and again for the retry) -- NOT only once for
 *     the eventually-successful attempt.
 *  c. Double failure -- safe fallback: BOTH attempts unparseable/invalid.
 *     Never throws. Returns `{ actions: [], parseError: true, message:
 *     <string> }`. `provider.complete` called exactly twice (no third
 *     attempt). `recordUsage` called exactly twice (once per attempt, same
 *     convention as (b)).
 *  d. Closed-union violation (`type: 'deleteEverything'`, outside the fixed
 *     ADR-0015 3-action-type set) is a VALIDATION failure enforced by zod,
 *     triggering the SAME retry-once-then-fallback path as malformed JSON --
 *     not silently accepted.
 *  e. `actionId` generation: every returned action has a non-empty,
 *     UUID-shaped `actionId` even when the model's JSON supplied none.
 *  f. Model forwarding: `model` forwarded into `provider.complete({ prompt,
 *     model })` unchanged when given; omitted entirely when not provided.
 *  g. No content logging: mirrors `answer-question.test.ts`'s "never logs"
 *     test style -- command text/parsed-action content must never reach
 *     `console.log`/`console.error`/`console.warn` (ADR-0008 discipline).
 *
 * Nothing under test here exists yet: `./parse-command.ts` has not been
 * written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

/** A single, schema-valid `createTask` action, WITHOUT an `actionId` field --
 * per this file's design decision, the model is never expected to supply one. */
function validActionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'createTask',
    intent: 'Create a follow-up task for the onboarding checklist',
    rationale: 'The command explicitly asked for a new task to track this work',
    resources: ['obj-123'],
    rollbackNote: 'Delete the created task if this was a mistake',
    params: { title: 'Follow up on onboarding checklist' },
    ...overrides,
  };
}

describe('parseCommand — happy path (valid JSON on the first attempt)', () => {
  it('calls provider.complete exactly once, records usage exactly once, and returns { actions: [...], parseError: false } with no message key', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 40, outputTokens: 12 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await parseCommand({
      provider,
      command: 'Create a follow-up task for the onboarding checklist',
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 12 });

    expect(result.parseError).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.actions).toHaveLength(1);

    const [action] = result.actions;
    expect(action?.type).toBe('createTask');
    expect(action?.intent).toBe('Create a follow-up task for the onboarding checklist');
    expect(action?.rationale).toBe(
      'The command explicitly asked for a new task to track this work',
    );
    expect(action?.resources).toEqual(['obj-123']);
    expect(action?.rollbackNote).toBe('Delete the created task if this was a mistake');
    expect(action?.params).toEqual({ title: 'Follow up on onboarding checklist' });
  });
});

describe('parseCommand — retry-once on malformed/invalid JSON', () => {
  it('retries with the IDENTICAL prompt exactly once when the first response is not valid JSON, and returns the successfully-parsed second attempt', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not json at all', usage: { inputTokens: 30, outputTokens: 5 } }
        : {
            text: JSON.stringify([validActionJson()]),
            usage: { inputTokens: 30, outputTokens: 8 },
          };
    });
    const { recordUsage } = collectUsage();

    const result = await parseCommand({
      provider,
      command: 'Create a follow-up task for the onboarding checklist',
      recordUsage,
    });

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.prompt).toBe(capturedRequests[1]?.prompt);

    // `recordUsage` is called once PER provider.complete call (the failed
    // first attempt AND the successful retry), mirroring
    // `resolveAIFieldValue`'s existing select-retry convention exactly --
    // never only once for the eventually-successful attempt.
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 30, outputTokens: 5 });
    expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 30, outputTokens: 8 });

    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe('createTask');
  });

  it('also retries when the first response is syntactically valid JSON but fails schema validation (e.g. missing the required "intent" field)', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        const withoutIntent = Object.fromEntries(
          Object.entries(validActionJson()).filter(([key]) => key !== 'intent'),
        );
        return {
          text: JSON.stringify([withoutIntent]),
          usage: { inputTokens: 20, outputTokens: 4 },
        };
      }
      return {
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 20, outputTokens: 6 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await parseCommand({
      provider,
      command: 'Create a follow-up task',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.actions).toHaveLength(1);
  });
});

describe('parseCommand — double failure (safe fallback, no fabricated actions)', () => {
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

    const result: ParseCommandResult = await parseCommand({
      provider,
      command: 'Do something ambiguous',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);

    expect(result.actions).toEqual([]);
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });
});

describe('parseCommand — closed action-type union is enforced by zod, not just prompt wording', () => {
  it('treats a `type` value outside the fixed set (createTask|generateSubtasks|assignPeople) as a validation failure, triggering the retry-once-then-fallback path', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify([validActionJson({ type: 'deleteEverything' })]),
        usage: { inputTokens: 15, outputTokens: 3 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await parseCommand({
      provider,
      command: 'Delete everything in this workspace',
      recordUsage,
    });

    // Both attempts returned the SAME out-of-union `type`, so both fail
    // validation identically -- this must land on the double-failure
    // fallback, exactly like two malformed-JSON responses would.
    expect(callCount).toBe(2);
    expect(result.actions).toEqual([]);
    expect(result.parseError).toBe(true);
  });
});

describe('proposedActionSchema — closed union widened for F2-T14 PR3 (ADR-0031 §e)', () => {
  it('ACCEPTS a `createTaskFromMeeting`-typed action object — the mirror image of the `deleteEverything`-is-REJECTED test above: the union now has a 4th member, added so the new sibling `extractMeetingActions` (./extract-meeting-actions.ts) can produce actions this same schema validates. `renderCommandPrompt`/`parseCommand` itself never asks the model for this type (unchanged, ADR-0031 §e) — this test only proves the SCHEMA accepts it structurally, not that parseCommand would ever request or produce it.', () => {
    const result = proposedActionSchema.safeParse([
      validActionJson({ type: 'createTaskFromMeeting' }),
    ]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.type).toBe('createTaskFromMeeting');
    }
  });
});

describe('proposedActionSchema — closed union widened again for F2-T15 PR3 (ADR-0032 Karar (f))', () => {
  it('ACCEPTS a `createTaskFromTrigger`-typed action object — the union now has a 5th member, added so a future (PR5) trigger-engine caller can hand `CommandsService.proposeFromTrigger` fully-formed actions of this type. Same reasoning as the `createTaskFromMeeting` widening test above: this only proves the SCHEMA accepts the type structurally, not that `parseCommand`/`renderCommandPrompt` itself ever asks the model for it — `parseCommand` never produces this type, ADR-0032 Karar (f).', () => {
    const result = proposedActionSchema.safeParse([
      validActionJson({ type: 'createTaskFromTrigger' }),
    ]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.type).toBe('createTaskFromTrigger');
    }
  });
});

describe('parseCommand — actionId generation', () => {
  it("assigns a fresh, non-empty, UUID-shaped actionId to every successfully-validated action, even when the model's JSON included no actionId field at all", async () => {
    const provider = MockProvider.fixed({
      text: JSON.stringify([
        validActionJson({ type: 'generateSubtasks', params: { count: 3 } }),
        validActionJson({ type: 'assignPeople', params: { userIds: ['user-1'] } }),
      ]),
      usage: { inputTokens: 25, outputTokens: 9 },
    });
    const { recordUsage } = collectUsage();

    const result = await parseCommand({
      provider,
      command: 'Generate 3 subtasks and assign them to user-1',
      recordUsage,
    });

    expect(result.actions).toHaveLength(2);
    for (const action of result.actions) {
      expect(action.actionId).toEqual(expect.any(String));
      expect(action.actionId.length).toBeGreaterThan(0);
      expect(action.actionId).toMatch(UUID_SHAPE);
    }
    // Every action gets its OWN distinct id -- never a shared/reused value.
    const ids = result.actions.map((action: ProposedAction) => action.actionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parseCommand — model forwarding', () => {
  it('when the caller passes model, provider.complete(...) receives that exact model alongside the rendered prompt', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    await parseCommand({
      provider,
      command: 'Create a follow-up task',
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
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await parseCommand({
      provider,
      command: 'Create a follow-up task',
      recordUsage,
    });

    expect(result.parseError).toBe(false);
    expect(capturedRequest?.model).toBeUndefined();
  });
});

describe('parseCommand — never logs command or parsed-action content', () => {
  it('does not call console.log/console.error/console.warn while parsing a command containing recognizable content', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = MockProvider.fixed({
      text: JSON.stringify([
        validActionJson({
          intent: 'SECRET-INTENT-MARKER-11111',
          rationale: 'SECRET-RATIONALE-MARKER-22222',
        }),
      ]),
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { recordUsage } = collectUsage();

    await parseCommand({
      provider,
      command: 'SECRET-COMMAND-MARKER-33333',
      sourceObjectId: 'SECRET-OBJECT-ID-MARKER-44444',
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
