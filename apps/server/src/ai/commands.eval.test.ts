import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { parseCommand } from './parse-command.js';

import type { ParseCommandResult, ProposedAction } from './parse-command.js';

/**
 * F1-T17 PR2 — "eval altyapısı": 50 golden scenarios pinning
 * `parseCommand`'s deterministic JSON-parse-and-validate orchestration
 * behavior (happy path, retry-once, double-failure fallback,
 * `actionId` minting, model/sourceObjectId forwarding, usage recording,
 * logging discipline) against `MockProvider`, entirely DB-free -- sibling of
 * `ai-fields.eval.test.ts` (F1-T5 PR-D) and `qa.eval.test.ts` (F1-T17 PR1).
 * `docs/evals/komut-ayristirma.md` documents these same 50 scenarios in
 * human-readable form; keep the two in sync.
 *
 * Runs under plain `pnpm test` (this repo's ordinary `vitest.config.ts`, no
 * Testcontainers) -- `parseCommand` is a pure decision function over an
 * injected `AIProvider` + a `recordUsage` callback, so these scenarios need
 * neither Postgres nor HTTP.
 *
 * These scenarios are a golden-set CATALOG, not a re-test of
 * `parse-command.test.ts` -- different fixtures/framing are used
 * deliberately even where the underlying behavior category overlaps.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A single, schema-valid `createTask` action, WITHOUT an `actionId` field --
 * per `parse-command.ts`'s design, the model is never expected to supply one. */
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

/** Returns a shallow copy of `json` with `key` removed entirely (used to
 * simulate a model response missing a required field). */
function withoutKey(json: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(json).filter(([entryKey]) => entryKey !== key));
}

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

/** A provider that captures every request and returns `responder`'s result
 * for every call (used for single-call and identical-response scenarios). */
function capturingProvider(responder: (request: AICompletionRequest) => AICompletionResult): {
  provider: MockProvider;
  getCallCount: () => number;
  getLastRequest: () => AICompletionRequest | undefined;
} {
  let callCount = 0;
  let lastRequest: AICompletionRequest | undefined;
  const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
    callCount += 1;
    lastRequest = request;
    return responder(request);
  });
  return { provider, getCallCount: () => callCount, getLastRequest: () => lastRequest };
}

/** A provider that returns `first` on the first call and `second` on every
 * subsequent call -- used for retry-once scenarios (Grup B/C/D). */
function twoAttemptProvider(
  first: AICompletionResult,
  second: AICompletionResult,
): {
  provider: MockProvider;
  getCallCount: () => number;
  getRequests: () => AICompletionRequest[];
} {
  let callCount = 0;
  const requests: AICompletionRequest[] = [];
  const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
    requests.push(request);
    callCount += 1;
    return callCount === 1 ? first : second;
  });
  return { provider, getCallCount: () => callCount, getRequests: () => requests };
}

describe('parseCommand eval — 50 golden scenarios (MockProvider, DB-free)', () => {
  // ===========================================================================
  // Grup A — Temel JSON ayrıştırma ve happy path (1-8)
  // ===========================================================================
  describe('Grup A — Temel JSON ayrıştırma ve happy path', () => {
    // -------------------------------------------------------------------------
    // Scenario 1 — tek createTask aksiyonu: ilk denemede geçerli JSON
    // -------------------------------------------------------------------------
    it('scenario 1: a single createTask action parses correctly on the first attempt, calling provider.complete exactly once', async () => {
      const json = validActionJson();
      let callCount = 0;
      const provider = new MockProvider((): AICompletionResult => {
        callCount += 1;
        return { text: JSON.stringify([json]), usage: { inputTokens: 20, outputTokens: 6 } };
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a task to review the pending PRs',
        recordUsage,
      });

      expect(callCount).toBe(1);
      expect(result.actions).toHaveLength(1);
      const [action] = result.actions;
      expect(action?.type).toBe('createTask');
      expect(action?.intent).toBe(json.intent);
      expect(action?.rationale).toBe(json.rationale);
      expect(action?.resources).toEqual(json.resources);
      expect(action?.rollbackNote).toBe(json.rollbackNote);
      expect(action?.params).toEqual(json.params);
    });

    // -------------------------------------------------------------------------
    // Scenario 2 — tek generateSubtasks aksiyonu: count + titles params
    // -------------------------------------------------------------------------
    it('scenario 2: a single generateSubtasks action correctly parses its type and params (count + titles array)', async () => {
      const json = validActionJson({
        type: 'generateSubtasks',
        intent: 'Break the epic into concrete subtasks',
        params: { count: 3, titles: ['Design', 'Implement', 'Test'] },
      });
      const provider = MockProvider.fixed({
        text: JSON.stringify([json]),
        usage: { inputTokens: 25, outputTokens: 8 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Break this epic down into three subtasks',
        recordUsage,
      });

      const [action] = result.actions;
      expect(action?.type).toBe('generateSubtasks');
      expect(action?.params).toEqual({ count: 3, titles: ['Design', 'Implement', 'Test'] });
    });

    // -------------------------------------------------------------------------
    // Scenario 3 — tek assignPeople aksiyonu: userIds params
    // -------------------------------------------------------------------------
    it('scenario 3: a single assignPeople action correctly parses its type and params (userIds array)', async () => {
      const json = validActionJson({
        type: 'assignPeople',
        intent: 'Assign the task to the on-call engineers',
        params: { userIds: ['user-1', 'user-2'] },
      });
      const provider = MockProvider.fixed({
        text: JSON.stringify([json]),
        usage: { inputTokens: 18, outputTokens: 5 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Assign this task to user-1 and user-2',
        recordUsage,
      });

      const [action] = result.actions;
      expect(action?.type).toBe('assignPeople');
      expect(action?.params).toEqual({ userIds: ['user-1', 'user-2'] });
    });

    // -------------------------------------------------------------------------
    // Scenario 4 — iki aksiyon (createTask, assignPeople): sıra korunur
    // -------------------------------------------------------------------------
    it('scenario 4: two actions (createTask then assignPeople) in one response are both parsed, preserving input order', async () => {
      const first = validActionJson({ type: 'createTask', intent: 'Create the onboarding task' });
      const second = validActionJson({
        type: 'assignPeople',
        intent: "Assign the onboarding task to the new hire's buddy",
        params: { userIds: ['user-9'] },
      });
      const provider = MockProvider.fixed({
        text: JSON.stringify([first, second]),
        usage: { inputTokens: 30, outputTokens: 10 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create an onboarding task and assign it to the buddy',
        recordUsage,
      });

      expect(result.actions).toHaveLength(2);
      expect(result.actions[0]?.type).toBe('createTask');
      expect(result.actions[1]?.type).toBe('assignPeople');
    });

    // -------------------------------------------------------------------------
    // Scenario 5 — üç aksiyon (createTask, generateSubtasks, assignPeople): sıra korunur
    // -------------------------------------------------------------------------
    it('scenario 5: three actions (createTask, generateSubtasks, assignPeople, in that order) are all parsed in the same order', async () => {
      const actions = [
        validActionJson({ type: 'createTask', intent: 'Create the migration task' }),
        validActionJson({
          type: 'generateSubtasks',
          intent: 'Split the migration into steps',
          params: { count: 2 },
        }),
        validActionJson({
          type: 'assignPeople',
          intent: 'Assign the migration to the infra team',
          params: { userIds: ['user-infra'] },
        }),
      ];
      const provider = MockProvider.fixed({
        text: JSON.stringify(actions),
        usage: { inputTokens: 40, outputTokens: 15 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Plan the database migration end to end',
        recordUsage,
      });

      expect(result.actions).toHaveLength(3);
      expect(result.actions[0]?.type).toBe('createTask');
      expect(result.actions[1]?.type).toBe('generateSubtasks');
      expect(result.actions[2]?.type).toBe('assignPeople');
    });

    // -------------------------------------------------------------------------
    // Scenario 6 — resources: [] geçerlidir
    // -------------------------------------------------------------------------
    it('scenario 6: an action with resources: [] (an empty array) is valid and preserved as an empty array', async () => {
      const json = validActionJson({ resources: [] });
      const provider = MockProvider.fixed({
        text: JSON.stringify([json]),
        usage: { inputTokens: 10, outputTokens: 4 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a standalone task with no linked resources',
        recordUsage,
      });

      expect(result.actions[0]?.resources).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // Scenario 7 — resources: ['obj-1','obj-2','obj-3'] sırayla korunur
    // -------------------------------------------------------------------------
    it('scenario 7: an action with resources: [obj-1, obj-2, obj-3] preserves all three entries in order', async () => {
      const json = validActionJson({ resources: ['obj-1', 'obj-2', 'obj-3'] });
      const provider = MockProvider.fixed({
        text: JSON.stringify([json]),
        usage: { inputTokens: 10, outputTokens: 4 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a task touching three related objects',
        recordUsage,
      });

      expect(result.actions[0]?.resources).toEqual(['obj-1', 'obj-2', 'obj-3']);
    });

    // -------------------------------------------------------------------------
    // Scenario 8 — params: {} geçerlidir
    // -------------------------------------------------------------------------
    it('scenario 8: an action with params: {} (an empty object) is valid and preserved as an empty object', async () => {
      const json = validActionJson({ params: {} });
      const provider = MockProvider.fixed({
        text: JSON.stringify([json]),
        usage: { inputTokens: 10, outputTokens: 4 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a bare task with no extra parameters',
        recordUsage,
      });

      expect(result.actions[0]?.params).toEqual({});
    });
  });

  // ===========================================================================
  // Grup B — Retry-once: bozuk JSON çeşitleri (9-16)
  // ===========================================================================
  describe('Grup B — Retry-once: bozuk JSON çeşitleri', () => {
    // -------------------------------------------------------------------------
    // Scenario 9 — düz metin (hiç JSON değil): retry tetiklenir
    // -------------------------------------------------------------------------
    it('scenario 9: a plain-text first response ("Sure, here is what I would do.") that is not JSON at all triggers a retry, and the valid second response succeeds', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: 'Sure, here is what I would do.', usage: { inputTokens: 10, outputTokens: 3 } },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
      expect(result.actions).toHaveLength(1);
    });

    // -------------------------------------------------------------------------
    // Scenario 10 — JSON nesne zarfı (dizi değil): şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 10: a first response that is a JSON OBJECT envelope ({ actions: [...] }) instead of a bare array fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify({ actions: [validActionJson()] }),
          usage: { inputTokens: 12, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 12, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 11 — boş string: JSON.parse patlar, retry
    // -------------------------------------------------------------------------
    it('scenario 11: a first response that is an empty string fails JSON.parse and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: '', usage: { inputTokens: 5, outputTokens: 1 } },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 5, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 12 — sondaki virgülle bozuk JSON: retry
    // -------------------------------------------------------------------------
    it('scenario 12: a first response with malformed JSON (a trailing comma) fails JSON.parse and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: '[{"type":"createTask"},]', usage: { inputTokens: 8, outputTokens: 2 } },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 8, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 13 — markdown kod bloğu içine sarılmış geçerli JSON: fence bozar, retry
    // -------------------------------------------------------------------------
    it('scenario 13: a first response that wraps valid JSON in a markdown code fence fails JSON.parse (the function never strips fences) and triggers a retry', async () => {
      const fenced = '```json\n' + JSON.stringify([validActionJson()]) + '\n```';
      const { provider, getCallCount } = twoAttemptProvider(
        { text: fenced, usage: { inputTokens: 15, outputTokens: 4 } },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 15, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 14 — kesilmiş/eksik JSON: retry
    // -------------------------------------------------------------------------
    it('scenario 14: a first response with truncated/incomplete JSON fails JSON.parse and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: '[{"type":"createTask","intent":"foo"',
          usage: { inputTokens: 8, outputTokens: 2 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 8, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 15 — çıplak sayısal JSON literal '42': dizi değil, şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 15: a first response that is the bare JSON number literal "42" parses but fails schema validation (not an array) and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: '42', usage: { inputTokens: 4, outputTokens: 1 } },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 4, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 16 — 'null' literal: dizi değil, şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 16: a first response that is the bare JSON literal "null" parses but fails schema validation (not an array) and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: 'null', usage: { inputTokens: 4, outputTokens: 1 } },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 4, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });
  });

  // ===========================================================================
  // Grup C — Retry-once: şema doğrulama hataları (17-24)
  // ===========================================================================
  describe('Grup C — Retry-once: şema doğrulama hataları', () => {
    // -------------------------------------------------------------------------
    // Scenario 17 — 'type' alanı tamamen eksik: şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 17: a first response whose single action is missing the required "type" field entirely fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([withoutKey(validActionJson(), 'type')]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 18 — intent: '' (min(1) ihlali): şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 18: a first response with intent: "" (an empty string, violating the min(1) constraint) fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([validActionJson({ intent: '' })]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 19 — 'rationale' alanı eksik: şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 19: a first response missing the required "rationale" field fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([withoutKey(validActionJson(), 'rationale')]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 20 — resources: 'obj-1' (dizi değil, çıplak string): şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 20: a first response with resources: "obj-1" (a bare string, not an array) fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([validActionJson({ resources: 'obj-1' })]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 21 — resources: [123] (dizi elemanı string değil): şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 21: a first response with resources: [123] (a numeric element, not a string) fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([validActionJson({ resources: [123] })]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 22 — 'rollbackNote' alanı eksik: şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 22: a first response missing the required "rollbackNote" field fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([withoutKey(validActionJson(), 'rollbackNote')]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 23 — params: [] (dizi, obje/record değil): şema reddeder, retry
    // -------------------------------------------------------------------------
    it('scenario 23: a first response with params: [] (an array instead of an object/record) fails schema validation and triggers a retry', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([validActionJson({ params: [] })]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 24 — iki aksiyon, biri geçersiz: TÜM dizi reddedilir (all-or-nothing), retry
    // -------------------------------------------------------------------------
    it('scenario 24: a first response with TWO actions where one is valid and one is missing "intent" fails validation as a WHOLE (zod .array() rejects if any element fails), triggering a retry that succeeds with a single valid action', async () => {
      const validOne = validActionJson({ type: 'createTask', intent: 'Create the task' });
      const invalidOne = withoutKey(
        validActionJson({ type: 'assignPeople', params: { userIds: ['user-1'] } }),
        'intent',
      );
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([validOne, invalidOne]),
          usage: { inputTokens: 20, outputTokens: 6 },
        },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 20, outputTokens: 8 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a task and assign someone',
        recordUsage,
      });

      expect(getCallCount()).toBe(2);
      expect(result.parseError).toBe(false);
      expect(result.actions).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Grup D — Çift başarısızlık: hata-sentinel VE önemli bir istisna (25-29)
  // ===========================================================================
  describe('Grup D — Çift başarısızlık: hata-sentinel VE önemli bir istisna', () => {
    // -------------------------------------------------------------------------
    // Scenario 25 — her iki deneme de alakasız düz metin: sentinel'e düşer
    // -------------------------------------------------------------------------
    it('scenario 25: both attempts return unrelated plain text (different text each time) -> the safe fallback { actions: [], parseError: true, message } is returned, with recordUsage called exactly twice', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: 'I am not sure what you mean.', usage: { inputTokens: 8, outputTokens: 2 } },
        { text: 'Could you clarify?', usage: { inputTokens: 8, outputTokens: 2 } },
      );
      const { recordUsage } = collectUsage();

      const result: ParseCommandResult = await parseCommand({
        provider,
        command: 'Do the thing',
        recordUsage,
      });

      expect(result.actions).toEqual([]);
      expect(result.parseError).toBe(true);
      expect(typeof result.message).toBe('string');
      expect(result.message?.length).toBeGreaterThan(0);
      expect(getCallCount()).toBe(2);
      expect(recordUsage).toHaveBeenCalledTimes(2);
    });

    // -------------------------------------------------------------------------
    // Scenario 26 — her iki deneme de kapalı birlik dışı 'type': sentinel'e düşer
    // -------------------------------------------------------------------------
    it('scenario 26: both attempts return an action with type: "deleteEverything" (outside the closed union) -> lands on the same double-failure fallback', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: JSON.stringify([validActionJson({ type: 'deleteEverything' })]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
        {
          text: JSON.stringify([validActionJson({ type: 'deleteEverything' })]),
          usage: { inputTokens: 10, outputTokens: 3 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Wipe the entire workspace',
        recordUsage,
      });

      expect(result.actions).toEqual([]);
      expect(result.parseError).toBe(true);
      expect(getCallCount()).toBe(2);
    });

    // -------------------------------------------------------------------------
    // Scenario 27 — ilk deneme bozuk JSON, ikinci deneme şema-geçersiz: yine sentinel
    // -------------------------------------------------------------------------
    it('scenario 27: a first attempt with malformed JSON combined with a second attempt that is schema-invalid (different failure kinds) still lands on the fallback', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: '[{"type":"createTask",]', usage: { inputTokens: 6, outputTokens: 2 } },
        {
          text: JSON.stringify([withoutKey(validActionJson(), 'rationale')]),
          usage: { inputTokens: 6, outputTokens: 2 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Do something ambiguous',
        recordUsage,
      });

      expect(result.actions).toEqual([]);
      expect(result.parseError).toBe(true);
      expect(getCallCount()).toBe(2);
    });

    // -------------------------------------------------------------------------
    // Scenario 28 — KRİTİK AYRIM: geçerli boş dizi '[]' BAŞARIdır, retry yok (senaryo 25 ile tezat)
    // -------------------------------------------------------------------------
    it('scenario 28 (critical distinction): a syntactically and schema-valid EMPTY array ("[]") succeeds on the FIRST attempt already (no retry needed), returning actions: [] with parseError: false and no "message" key -- NOT the scenario-25 fallback', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: '[]', usage: { inputTokens: 5, outputTokens: 1 } },
        { text: '[]', usage: { inputTokens: 5, outputTokens: 1 } },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'What is the meaning of life?',
        recordUsage,
      });

      expect(result.actions).toEqual([]);
      expect(result.parseError).toBe(false);
      expect(result).not.toHaveProperty('message');
      expect(getCallCount()).toBe(1);
    });

    // -------------------------------------------------------------------------
    // Scenario 29 — her iki deneme de hata-mesajı biçimli düz metin: sentinel'e düşer
    // -------------------------------------------------------------------------
    it('scenario 29: both attempts return an error-message-shaped plain string ("Error: rate limited, please try again later.") -> not JSON -> fallback', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: 'Error: rate limited, please try again later.',
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        {
          text: 'Error: rate limited, please try again later.',
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a task',
        recordUsage,
      });

      expect(result.actions).toEqual([]);
      expect(result.parseError).toBe(true);
      expect(getCallCount()).toBe(2);
    });
  });

  // ===========================================================================
  // Grup E — actionId üretimi ve tekillik (30-33)
  // ===========================================================================
  describe('Grup E — actionId üretimi ve tekillik', () => {
    // -------------------------------------------------------------------------
    // Scenario 30 — tek aksiyon: UUID biçimli, boş olmayan actionId
    // -------------------------------------------------------------------------
    it('scenario 30: a single action gets a non-empty, UUID-shaped actionId', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 10, outputTokens: 4 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      const [action] = result.actions;
      expect(action?.actionId.length).toBeGreaterThan(0);
      expect(action?.actionId).toMatch(UUID_SHAPE);
    });

    // -------------------------------------------------------------------------
    // Scenario 31 — üç aksiyon: hepsi farklı actionId alır
    // -------------------------------------------------------------------------
    it('scenario 31: three actions in one response all receive distinct actionIds', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([
          validActionJson({ type: 'createTask' }),
          validActionJson({ type: 'generateSubtasks', params: { count: 2 } }),
          validActionJson({ type: 'assignPeople', params: { userIds: ['user-1'] } }),
        ]),
        usage: { inputTokens: 20, outputTokens: 8 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create, split, and assign this work',
        recordUsage,
      });

      const ids = result.actions.map((action: ProposedAction) => action.actionId);
      expect(new Set(ids).size).toBe(3);
    });

    // -------------------------------------------------------------------------
    // Scenario 32 — retry sonrası: iki final aksiyon da geçerli/farklı actionId alır
    // -------------------------------------------------------------------------
    it('scenario 32: after a retry (first attempt malformed, second valid with 2 actions), both final actions have distinct, valid actionIds with no leakage from the failed first attempt', async () => {
      const { provider } = twoAttemptProvider(
        { text: 'not json', usage: { inputTokens: 5, outputTokens: 1 } },
        {
          text: JSON.stringify([
            validActionJson({ type: 'createTask' }),
            validActionJson({ type: 'assignPeople', params: { userIds: ['user-2'] } }),
          ]),
          usage: { inputTokens: 15, outputTokens: 6 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a task and assign it',
        recordUsage,
      });

      expect(result.actions).toHaveLength(2);
      for (const action of result.actions) {
        expect(action.actionId).toMatch(UUID_SHAPE);
      }
      const ids = result.actions.map((action: ProposedAction) => action.actionId);
      expect(new Set(ids).size).toBe(2);
    });

    // -------------------------------------------------------------------------
    // Scenario 33 — modelden gelen sahte actionId göz ardı edilir
    // -------------------------------------------------------------------------
    it('scenario 33: a spurious model-supplied actionId field on the action object is ignored -- the real actionId is UUID-shaped and never equals the model-supplied value', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([validActionJson({ actionId: 'model-supplied-fake-id' })]),
        usage: { inputTokens: 10, outputTokens: 4 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      const [action] = result.actions;
      expect(action?.actionId).toMatch(UUID_SHAPE);
      expect(action?.actionId).not.toBe('model-supplied-fake-id');
    });
  });

  // ===========================================================================
  // Grup F — Model yönlendirme, sourceObjectId ve usage kaydı (34-39)
  // ===========================================================================
  describe('Grup F — Model yönlendirme, sourceObjectId ve usage kaydı', () => {
    // -------------------------------------------------------------------------
    // Scenario 34 — model verildiğinde provider isteğine aynen ulaşır
    // -------------------------------------------------------------------------
    it('scenario 34: a model string passed to parseCommand reaches provider.complete unchanged', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 10, outputTokens: 4 },
      }));
      const { recordUsage } = collectUsage();

      await parseCommand({
        provider,
        command: 'Create a follow-up task',
        model: 'claude-sonnet-5-20260101',
        recordUsage,
      });

      expect(getLastRequest()?.model).toBe('claude-sonnet-5-20260101');
    });

    // -------------------------------------------------------------------------
    // Scenario 35 — model verilmediğinde provider isteğinde model undefined kalır
    // -------------------------------------------------------------------------
    it('scenario 35: when model is omitted, provider.complete receives model === undefined', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 10, outputTokens: 4 },
      }));
      const { recordUsage } = collectUsage();

      await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getLastRequest()?.model).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // Scenario 36 — sourceObjectId verildiğinde prompt "Source object id: ..." satırını içerir
    // -------------------------------------------------------------------------
    it('scenario 36: a sourceObjectId passed to parseCommand appears in the prompt as "Source object id: <id>"', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 10, outputTokens: 4 },
      }));
      const { recordUsage } = collectUsage();

      await parseCommand({
        provider,
        command: 'Create a follow-up task',
        sourceObjectId: 'obj-source-42',
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain('Source object id: obj-source-42');
    });

    // -------------------------------------------------------------------------
    // Scenario 37 — sourceObjectId verilmediğinde prompt bu satırı hiç içermez
    // -------------------------------------------------------------------------
    it('scenario 37: when sourceObjectId is omitted, the prompt does not contain the "Source object id:" substring at all', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 10, outputTokens: 4 },
      }));
      const { recordUsage } = collectUsage();

      await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(getLastRequest()?.prompt).not.toContain('Source object id:');
    });

    // -------------------------------------------------------------------------
    // Scenario 38 — tek denemede başarı: recordUsage tam olarak provider usage'ıyla bir kez çağrılır
    // -------------------------------------------------------------------------
    it('scenario 38: a single-attempt success with usage { inputTokens: 40, outputTokens: 12 } calls recordUsage exactly once with exactly that object', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 40, outputTokens: 12 },
      });
      const recordUsage = vi.fn();

      await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 12 });
    });

    // -------------------------------------------------------------------------
    // Scenario 39 — retry senaryosunda recordUsage sırayla, her çağrının kendi usage'ıyla iki kez çağrılır
    // -------------------------------------------------------------------------
    it("scenario 39: a retry scenario records usage twice, in order, each with that call's exact usage ({30,5} then {30,8})", async () => {
      const { provider } = twoAttemptProvider(
        { text: 'not json', usage: { inputTokens: 30, outputTokens: 5 } },
        {
          text: JSON.stringify([validActionJson()]),
          usage: { inputTokens: 30, outputTokens: 8 },
        },
      );
      const recordUsage = vi.fn();

      await parseCommand({
        provider,
        command: 'Create a follow-up task',
        recordUsage,
      });

      expect(recordUsage).toHaveBeenCalledTimes(2);
      expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 30, outputTokens: 5 });
      expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 30, outputTokens: 8 });
    });
  });

  // ===========================================================================
  // Grup G — Loglama disiplini (40-41)
  // ===========================================================================
  describe('Grup G — Loglama disiplini', () => {
    // -------------------------------------------------------------------------
    // Scenario 40 — happy path, işaretli içerik: console.log/error/warn hiç çağrılmaz
    // -------------------------------------------------------------------------
    it('scenario 40: a happy-path parse of marker-tagged command/sourceObjectId/action content never calls console.log/error/warn', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const provider = MockProvider.fixed({
        text: JSON.stringify([
          validActionJson({
            intent: 'MARKER-INTENT-11111',
            rationale: 'MARKER-RATIONALE-22222',
          }),
        ]),
        usage: { inputTokens: 5, outputTokens: 5 },
      });
      const { recordUsage } = collectUsage();

      await parseCommand({
        provider,
        command: 'MARKER-CMD-77777',
        sourceObjectId: 'MARKER-OBJ-88888',
        recordUsage,
      });

      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();

      consoleLog.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    });

    // -------------------------------------------------------------------------
    // Scenario 41 — sentinel yolu, işaretli içerik: console.log/error/warn hiç çağrılmaz
    // -------------------------------------------------------------------------
    it('scenario 41: a double-failure fallback path with marker-tagged non-JSON responses never calls console.log/error/warn', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const provider = MockProvider.fixed({
        text: 'MARKER-BADRESPONSE-99999',
        usage: { inputTokens: 5, outputTokens: 5 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'MARKER-CMD-99999',
        recordUsage,
      });

      expect(result.parseError).toBe(true);
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();

      consoleLog.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    });
  });

  // ===========================================================================
  // Grup H — Gerçekçi ve belirsiz komut senaryoları (42-50)
  // ===========================================================================
  describe('Grup H — Gerçekçi ve belirsiz komut senaryoları', () => {
    // -------------------------------------------------------------------------
    // Scenario 42 — Gerçekçi createTask komutu
    // -------------------------------------------------------------------------
    it('scenario 42: a realistic createTask command ("Create a task to fix the broken login page") with a matching valid response parses with correct type/intent/rationale', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([
          validActionJson({
            intent: 'Create a task to fix the broken login page',
            rationale: 'The user explicitly asked to track this bug as a task',
          }),
        ]),
        usage: { inputTokens: 20, outputTokens: 8 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a task to fix the broken login page',
        recordUsage,
      });

      const [action] = result.actions;
      expect(action?.type).toBe('createTask');
      expect(action?.intent).toBe('Create a task to fix the broken login page');
      expect(action?.rationale).toBe('The user explicitly asked to track this bug as a task');
    });

    // -------------------------------------------------------------------------
    // Scenario 43 — Gerçekçi generateSubtasks komutu
    // -------------------------------------------------------------------------
    it('scenario 43: a realistic generateSubtasks command ("Break this epic down into subtasks") parses with correct type/params', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([
          validActionJson({
            type: 'generateSubtasks',
            intent: 'Break the epic into concrete implementation subtasks',
            params: {
              count: 4,
              titles: ['Design API', 'Implement backend', 'Implement UI', 'Write tests'],
            },
          }),
        ]),
        usage: { inputTokens: 25, outputTokens: 10 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Break this epic down into subtasks',
        recordUsage,
      });

      const [action] = result.actions;
      expect(action?.type).toBe('generateSubtasks');
      expect(action?.params).toEqual({
        count: 4,
        titles: ['Design API', 'Implement backend', 'Implement UI', 'Write tests'],
      });
    });

    // -------------------------------------------------------------------------
    // Scenario 44 — Gerçekçi assignPeople komutu
    // -------------------------------------------------------------------------
    it('scenario 44: a realistic assignPeople command ("Assign this task to a teammate") parses with correct type/params.userIds', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([
          validActionJson({
            type: 'assignPeople',
            intent: 'Assign this task to the requested teammate',
            params: { userIds: ['user-teammate-1'] },
          }),
        ]),
        usage: { inputTokens: 15, outputTokens: 6 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Assign this task to a teammate',
        recordUsage,
      });

      const [action] = result.actions;
      expect(action?.type).toBe('assignPeople');
      expect(action?.params).toEqual({ userIds: ['user-teammate-1'] });
    });

    // -------------------------------------------------------------------------
    // Scenario 45 — Çok adımlı gerçekçi komut: createTask + assignPeople birlikte
    // -------------------------------------------------------------------------
    it('scenario 45: a multi-step command ("Create a task for the onboarding fix and assign it to the on-call engineer") whose response has two actions (createTask then assignPeople) parses both correctly in order', async () => {
      const provider = MockProvider.fixed({
        text: JSON.stringify([
          validActionJson({ type: 'createTask', intent: 'Create a task for the onboarding fix' }),
          validActionJson({
            type: 'assignPeople',
            intent: 'Assign the onboarding fix task to the on-call engineer',
            params: { userIds: ['user-oncall'] },
          }),
        ]),
        usage: { inputTokens: 35, outputTokens: 14 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Create a task for the onboarding fix and assign it to the on-call engineer',
        recordUsage,
      });

      expect(result.actions).toHaveLength(2);
      expect(result.actions[0]?.type).toBe('createTask');
      expect(result.actions[1]?.type).toBe('assignPeople');
    });

    // -------------------------------------------------------------------------
    // Scenario 46 — Belirsiz/eylemsiz komut: geçerli boş dizi -> başarı, retry yok (senaryo 28'le tutarlı)
    // -------------------------------------------------------------------------
    it('scenario 46: an ambiguous/non-actionable command ("What\'s the weather like today?") whose response is a valid empty array [] resolves with actions: [] and parseError: false, on the first attempt (consistent with scenario 28)', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        { text: '[]', usage: { inputTokens: 5, outputTokens: 1 } },
        { text: '[]', usage: { inputTokens: 5, outputTokens: 1 } },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: "What's the weather like today?",
        recordUsage,
      });

      expect(result.actions).toEqual([]);
      expect(result.parseError).toBe(false);
      expect(getCallCount()).toBe(1);
    });

    // -------------------------------------------------------------------------
    // Scenario 47 — Eylemsiz komut, model JSON talimatını yok sayar: sentinel'e düşer
    // -------------------------------------------------------------------------
    it('scenario 47: a non-actionable command whose model reply ignores the JSON-only instruction on both attempts ("I cannot determine an action from this request.") lands on the fallback', async () => {
      const { provider, getCallCount } = twoAttemptProvider(
        {
          text: 'I cannot determine an action from this request.',
          usage: { inputTokens: 10, outputTokens: 4 },
        },
        {
          text: 'I cannot determine an action from this request.',
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      );
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: 'Tell me a joke',
        recordUsage,
      });

      expect(result.parseError).toBe(true);
      expect(result.actions).toEqual([]);
      expect(getCallCount()).toBe(2);
    });

    // -------------------------------------------------------------------------
    // Scenario 48 — Uzun, karmaşık komut + sourceObjectId: ilk denemede geçerli JSON
    // -------------------------------------------------------------------------
    it('scenario 48: a long, multi-sentence, complex natural-language command combined with a sourceObjectId still parses correctly on the first attempt', async () => {
      const longCommand =
        'Given the recent spike in login failures reported by customer support, please create a ' +
        'task to investigate the root cause, and make sure the rationale references the incident ' +
        'timeline so whoever picks it up has enough context to start immediately.';
      const provider = MockProvider.fixed({
        text: JSON.stringify([validActionJson({ intent: 'Investigate the login-failure spike' })]),
        usage: { inputTokens: 60, outputTokens: 20 },
      });
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: longCommand,
        sourceObjectId: 'obj-incident-1',
        recordUsage,
      });

      expect(result.parseError).toBe(false);
      expect(result.actions).toHaveLength(1);
    });

    // -------------------------------------------------------------------------
    // Scenario 49 — Türkçe komut metni: dil-bağımsız ayrıştırma, prompt'ta aynen yer alır
    // -------------------------------------------------------------------------
    it('scenario 49: a Turkish-language command ("Bu görevi tamamlandı olarak işaretle ve ekibe bildir") is included verbatim in the prompt, and parsing still succeeds given a valid JSON response (parsing is language-agnostic)', async () => {
      const turkishCommand = 'Bu görevi tamamlandı olarak işaretle ve ekibe bildir';
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: JSON.stringify([validActionJson()]),
        usage: { inputTokens: 20, outputTokens: 8 },
      }));
      const { recordUsage } = collectUsage();

      const result = await parseCommand({
        provider,
        command: turkishCommand,
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain(turkishCommand);
      expect(result.parseError).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Scenario 50 — Capstone: sourceObjectId + model + üç aksiyon + usage, hepsi tek testte
    // -------------------------------------------------------------------------
    it('scenario 50 (capstone): sourceObjectId + model + three actions (one of each type) in a single valid response + usage {60,20} -- verifies provider called once, recordUsage called once with that usage, all 3 actions present with correct types in order, all 3 actionIds distinct and UUID-shaped, and the prompt contains both the command text and the Source object id line verbatim', async () => {
      const command =
        'Create the migration task, split it into subtasks, and assign it to the infra team';
      const { provider, getCallCount, getLastRequest } = capturingProvider(() => ({
        text: JSON.stringify([
          validActionJson({ type: 'createTask', intent: 'Create the migration task' }),
          validActionJson({
            type: 'generateSubtasks',
            intent: 'Split the migration into steps',
            params: { count: 3 },
          }),
          validActionJson({
            type: 'assignPeople',
            intent: 'Assign the migration to the infra team',
            params: { userIds: ['user-infra'] },
          }),
        ]),
        usage: { inputTokens: 60, outputTokens: 20 },
      }));
      const recordUsage = vi.fn();

      const result = await parseCommand({
        provider,
        command,
        sourceObjectId: 'obj-migration-1',
        model: 'claude-sonnet-5-20260101',
        recordUsage,
      });

      expect(getCallCount()).toBe(1);
      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 60, outputTokens: 20 });

      expect(result.actions).toHaveLength(3);
      expect(result.actions[0]?.type).toBe('createTask');
      expect(result.actions[1]?.type).toBe('generateSubtasks');
      expect(result.actions[2]?.type).toBe('assignPeople');

      const ids = result.actions.map((action: ProposedAction) => action.actionId);
      for (const id of ids) {
        expect(id).toMatch(UUID_SHAPE);
      }
      expect(new Set(ids).size).toBe(3);

      const prompt = getLastRequest()?.prompt ?? '';
      expect(prompt).toContain(command);
      expect(prompt).toContain('Source object id: obj-migration-1');
      expect(getLastRequest()?.model).toBe('claude-sonnet-5-20260101');
    });
  });
});
