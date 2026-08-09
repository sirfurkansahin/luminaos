import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';

import { answerQuestion } from './answer-question.js';

import type { QAAnswer, QAPassage } from './answer-question.js';

/**
 * F1-T17 PR1 — "eval altyapısı": 40 golden scenarios pinning
 * `answerQuestion`'s deterministic RAG-orchestration behavior (prompt
 * construction, source fidelity, empty-passages short circuit, model
 * forwarding, usage recording, anti-hallucination instruction persistence,
 * logging discipline) against `MockProvider`, entirely DB-free -- sibling of
 * `ai-fields.eval.test.ts` (F1-T5 PR-D). `docs/evals/qa.md` documents these
 * same 40 scenarios in human-readable form; keep the two in sync.
 *
 * Runs under plain `pnpm test` (this repo's ordinary `vitest.config.ts`, no
 * Testcontainers) -- unlike an eventual integration test wiring the same
 * logic through real Postgres/HTTP, `answerQuestion` is a pure decision
 * function over an injected `AIProvider` + a `recordUsage` callback, so
 * these scenarios need neither.
 *
 * These scenarios are a golden-set CATALOG, not a re-test of
 * `answer-question.test.ts` -- different fixtures/framing are used
 * deliberately even where the underlying behavior category overlaps.
 */

/** The exact, pinned fixed-answer string for the empty-passages short circuit. */
const EMPTY_PASSAGES_ANSWER =
  'No relevant content was found in this workspace to answer this question.';

// ---------------------------------------------------------------------------
// Shared fixture passages (synthetic-only content)
// ---------------------------------------------------------------------------

const P_ONBOARD: QAPassage = {
  objectId: 'obj-onboard-1',
  title: 'Q3 Onboarding Runbook',
  snippet: 'New hires must complete security training within their first week.',
};

const P_REMOTE: QAPassage = {
  objectId: 'obj-remote-1',
  title: 'Remote Work Policy',
  snippet: 'Employees may work remotely up to three days per week with manager approval.',
};

const P_ROLLBACK: QAPassage = {
  objectId: 'obj-rollback-1',
  title: 'Rollback Playbook',
  snippet:
    'To roll back a deploy, revert the release tag and redeploy the previous artifact within 15 minutes.',
};

const P_DEPLOY: QAPassage = {
  objectId: 'obj-deploy-1',
  title: 'Deploy Checklist',
  snippet:
    'Before deploying, confirm migrations are backward compatible and feature flags are set.',
};

const P_SECURITY: QAPassage = {
  objectId: 'obj-security-1',
  title: 'Account Security Policy',
  snippet: 'Two-factor authentication is required for all workspace admin accounts.',
};

const P_REFUND: QAPassage = {
  objectId: 'obj-refund-1',
  title: 'Refund Policy',
  snippet:
    'Refunds are issued within 5 business days for orders cancelled within 30 days of purchase.',
};

const P_SHIPPING: QAPassage = {
  objectId: 'obj-shipping-1',
  title: 'Shipping Policy',
  snippet:
    'Standard shipping takes 3-7 business days; expedited shipping is available at checkout.',
};

const P_SPRINT: QAPassage = {
  objectId: 'obj-sprint-1',
  title: 'Sprint Planning Notes',
  snippet:
    'The team prioritized the checkout redesign over the search filter improvements this sprint.',
};

const P_MEETING_A: QAPassage = {
  objectId: 'obj-meeting-a',
  title: 'Meeting Notes',
  snippet: 'Q1 retro: velocity dropped 10%.',
};

const P_MEETING_B: QAPassage = {
  objectId: 'obj-meeting-b',
  title: 'Meeting Notes',
  snippet: 'Q2 retro: velocity recovered.',
};

const P_TURKISH: QAPassage = {
  objectId: 'obj-turkish-1',
  title: 'Uzaktan Çalışma Politikası',
  snippet: 'Çalışanlar yöneticilerinin onayıyla haftada üç güne kadar uzaktan çalışabilir.',
};

const P_BUDGET: QAPassage = {
  objectId: 'obj-budget-1',
  title: 'Q3 Marketing Budget',
  snippet: 'Q3 marketing budget: $42,000, allocated across three campaigns.',
};

const P_QUOTE: QAPassage = {
  objectId: 'obj-quote-1',
  title: 'Customer Feedback Log',
  snippet: 'One customer wrote: "the onboarding process was confusing at first."',
};

const P_WHITESPACE: QAPassage = {
  objectId: 'obj-ws-1',
  title: 'Draft Notes',
  snippet: '  leading and trailing whitespace preserved  ',
};

const P_LONG: QAPassage = {
  objectId: 'obj-long-1',
  title: 'Onboarding Deep Dive',
  snippet:
    'This document walks new hires through every stage of the first-week onboarding process, ' +
    'starting with account provisioning and badge access, continuing through mandatory security ' +
    'and compliance training modules, introducing the team structure and on-call rotation, and ' +
    'finishing with a checklist of tools to install before the first sprint planning meeting begins.',
};

const P_EMPTY_SNIPPET: QAPassage = {
  objectId: 'obj-empty-1',
  title: 'Placeholder Doc',
  snippet: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

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

describe('QA eval — 40 golden scenarios (MockProvider, DB-free)', () => {
  // ===========================================================================
  // Grup A — Temel pasaj işleme ve prompt oluşturma (1-6)
  // ===========================================================================
  describe('Grup A — Temel pasaj işleme ve prompt oluşturma', () => {
    // -------------------------------------------------------------------------
    // Scenario 1 — tek pasaj: prompt question+title+snippet içerir
    // -------------------------------------------------------------------------
    it('scenario 1: a single passage produces a prompt containing the question and that passage title+snippet, calls provider once, and returns sources=[passage]', async () => {
      const { provider, getCallCount, getLastRequest } = capturingProvider(() => ({
        text: 'Up to three days per week with manager approval.',
        usage: { inputTokens: 40, outputTokens: 12 },
      }));
      const { recordUsage } = collectUsage();
      const question = 'How many days per week can employees work remotely?';

      const result = await answerQuestion({
        provider,
        question,
        passages: [P_REMOTE],
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain(question);
      expect(getLastRequest()?.prompt).toContain(P_REMOTE.title);
      expect(getLastRequest()?.prompt).toContain(P_REMOTE.snippet);
      expect(getCallCount()).toBe(1);
      expect(result.sources).toEqual([P_REMOTE]);
      expect(result.answer).toBe('Up to three days per week with manager approval.');
    });

    // -------------------------------------------------------------------------
    // Scenario 2 — iki pasaj: prompt her iki başlık+parçayı içerir, sıra korunur
    // -------------------------------------------------------------------------
    it('scenario 2: two passages both appear in the prompt (title+snippet), and sources preserve input order with length 2', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'Revert the release tag and redeploy the previous artifact within 15 minutes.',
        usage: { inputTokens: 60, outputTokens: 20 },
      }));
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'What are the safe steps to roll back a deploy?',
        passages: [P_ROLLBACK, P_DEPLOY],
        recordUsage,
      });

      for (const passage of [P_ROLLBACK, P_DEPLOY]) {
        expect(getLastRequest()?.prompt).toContain(passage.title);
        expect(getLastRequest()?.prompt).toContain(passage.snippet);
      }
      expect(result.sources).toHaveLength(2);
      expect(result.sources).toEqual([P_ROLLBACK, P_DEPLOY]);
    });

    // -------------------------------------------------------------------------
    // Scenario 3 — üç pasaj: [1],[2],[3] numaralandırması girdi sırasıyla eşleşir
    // -------------------------------------------------------------------------
    it('scenario 3: three passages are numbered [1][2][3] in input order, each marker immediately followed by its own title', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'Enable two-factor authentication for admins.',
        usage: { inputTokens: 30, outputTokens: 8 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'What should we check before and after a deploy?',
        passages: [P_ROLLBACK, P_DEPLOY, P_SECURITY],
        recordUsage,
      });

      const prompt = getLastRequest()?.prompt ?? '';
      const idx1 = prompt.indexOf('[1]');
      const idx2 = prompt.indexOf('[2]');
      const idx3 = prompt.indexOf('[3]');
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx1).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx3);
      expect(prompt.slice(idx1, idx1 + 4 + P_ROLLBACK.title.length)).toBe(
        `[1] ${P_ROLLBACK.title}`,
      );
      expect(prompt.slice(idx2, idx2 + 4 + P_DEPLOY.title.length)).toBe(`[2] ${P_DEPLOY.title}`);
      expect(prompt.slice(idx3, idx3 + 4 + P_SECURITY.title.length)).toBe(
        `[3] ${P_SECURITY.title}`,
      );
    });

    // -------------------------------------------------------------------------
    // Scenario 4 — beş pasaj: tek çağrı, 5 kaynak
    // -------------------------------------------------------------------------
    it('scenario 4: five passages result in exactly one provider call and sources.length === 5', async () => {
      const { provider, getCallCount } = capturingProvider(() => ({
        text: 'Combined answer across five sources.',
        usage: { inputTokens: 90, outputTokens: 25 },
      }));
      const { recordUsage } = collectUsage();
      const passages = [P_ONBOARD, P_REMOTE, P_ROLLBACK, P_DEPLOY, P_SECURITY];

      const result = await answerQuestion({
        provider,
        question: 'Summarize onboarding, remote work, and deploy safety in one answer.',
        passages,
        recordUsage,
      });

      expect(getCallCount()).toBe(1);
      expect(result.sources).toHaveLength(5);
    });

    // -------------------------------------------------------------------------
    // Scenario 5 — sekiz pasaj: üst sınır dayatılmaz (TOP_K çağıranın işi)
    // -------------------------------------------------------------------------
    it('scenario 5: eight passages still result in exactly one provider call and sources.length === 8 -- answerQuestion enforces no upper bound; TOP_K=5 is QAService caller-side responsibility', async () => {
      const { provider, getCallCount } = capturingProvider(() => ({
        text: 'A broad synthesis across many topics.',
        usage: { inputTokens: 200, outputTokens: 50 },
      }));
      const { recordUsage } = collectUsage();
      const passages = [
        P_ONBOARD,
        P_REMOTE,
        P_ROLLBACK,
        P_DEPLOY,
        P_SECURITY,
        P_REFUND,
        P_SHIPPING,
        P_SPRINT,
      ];

      const result = await answerQuestion({
        provider,
        question: 'Give me a broad status update across all workspace areas.',
        passages,
        recordUsage,
      });

      expect(getCallCount()).toBe(1);
      expect(result.sources).toHaveLength(8);
    });

    // -------------------------------------------------------------------------
    // Scenario 6 — provider alakasız metin döndürse bile answer aynen aktarılır, retry yok
    // -------------------------------------------------------------------------
    it('scenario 6: an unrelated provider response ("I\'m not sure.") despite relevant passages is returned verbatim as answer, with NO retry (deliberate contrast with resolveAIFieldValue\'s select-retry logic -- answerQuestion has no output-validation/retry loop at all)', async () => {
      const { provider, getCallCount } = capturingProvider(() => ({
        text: "I'm not sure.",
        usage: { inputTokens: 15, outputTokens: 4 },
      }));
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'What is our refund window?',
        passages: [P_REFUND],
        recordUsage,
      });

      expect(result.answer).toBe("I'm not sure.");
      expect(getCallCount()).toBe(1);
    });
  });

  // ===========================================================================
  // Grup B — Sıfır-pasaj kısa devresi (7-9)
  // ===========================================================================
  describe('Grup B — Sıfır-pasaj kısa devresi', () => {
    // -------------------------------------------------------------------------
    // Scenario 7 — boş pasaj listesi, kısa soru: sabit cevap, provider/recordUsage hiç çağrılmaz
    // -------------------------------------------------------------------------
    it('scenario 7: passages=[] with a short question returns the fixed EMPTY_PASSAGES_ANSWER with empty sources; provider.complete and recordUsage are never called', async () => {
      const completeSpy = vi.fn();
      const provider = new MockProvider((): AICompletionResult => {
        completeSpy();
        throw new Error('must never be called');
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'What is our budget?',
        passages: [],
        recordUsage,
      });

      expect(result).toEqual<QAAnswer>({ answer: EMPTY_PASSAGES_ANSWER, sources: [] });
      expect(completeSpy).not.toHaveBeenCalled();
      expect(recordUsage).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Scenario 8 — boş pasaj listesi, uzun/çok cümleli soru: aynı sabit sonuç
    // -------------------------------------------------------------------------
    it('scenario 8: passages=[] with a long, multi-sentence question resolves to the SAME fixed result as a short question (behavior is question-content-independent)', async () => {
      const provider = new MockProvider((): AICompletionResult => {
        throw new Error('must never be called');
      });
      const { recordUsage } = collectUsage();
      const longQuestion =
        'Given everything we know about our onboarding, remote work, and security policies, ' +
        'and considering that a new hire started this week in a fully remote role, what steps, ' +
        'if any, should their manager take within the first five business days, and are there ' +
        'any admin-account-specific security requirements that apply to them as well?';

      const result = await answerQuestion({
        provider,
        question: longQuestion,
        passages: [],
        recordUsage,
      });

      expect(result).toEqual<QAAnswer>({ answer: EMPTY_PASSAGES_ANSWER, sources: [] });
    });

    // -------------------------------------------------------------------------
    // Scenario 9 — boş pasaj listesi, Türkçe soru: aynı sabit İNGİLİZCE sonuç (yerelleştirme dalı yok)
    // -------------------------------------------------------------------------
    it('scenario 9: passages=[] with a Turkish question still resolves to the identical fixed ENGLISH result (there is no localization branch)', async () => {
      const provider = new MockProvider((): AICompletionResult => {
        throw new Error('must never be called');
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'Uzaktan çalışma politikamız nedir?',
        passages: [],
        recordUsage,
      });

      expect(result).toEqual<QAAnswer>({ answer: EMPTY_PASSAGES_ANSWER, sources: [] });
    });
  });

  // ===========================================================================
  // Grup C — Kaynak (source) sadakati (10-15)
  // ===========================================================================
  describe('Grup C — Kaynak (source) sadakati', () => {
    // -------------------------------------------------------------------------
    // Scenario 10 — tek pasaj: sources girdiyle tam eşleşir
    // -------------------------------------------------------------------------
    it('scenario 10: a single passage is returned in sources as a content-equal copy of the input passage', async () => {
      const provider = MockProvider.fixed({
        text: 'Two-factor authentication is required for all admin accounts.',
        usage: { inputTokens: 20, outputTokens: 8 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'Do admin accounts require 2FA?',
        passages: [P_SECURITY],
        recordUsage,
      });

      expect(result.sources).toEqual([P_SECURITY]);
    });

    // -------------------------------------------------------------------------
    // Scenario 11 — çoklu pasaj, alfabetik olmayan sıra: sources yeniden sıralanmaz
    // -------------------------------------------------------------------------
    it('scenario 11: multiple passages given in a deliberately non-alphabetical title order are returned in sources in that exact same order (never resorted)', async () => {
      const provider = MockProvider.fixed({
        text: 'Combined answer.',
        usage: { inputTokens: 30, outputTokens: 10 },
      });
      const { recordUsage } = collectUsage();
      const passages = [P_SPRINT, P_ONBOARD, P_DEPLOY];

      const result = await answerQuestion({
        provider,
        question: 'Give me a status update.',
        passages,
        recordUsage,
      });

      expect(result.sources).toEqual([P_SPRINT, P_ONBOARD, P_DEPLOY]);
    });

    // -------------------------------------------------------------------------
    // Scenario 12 — aynı başlıklı iki farklı pasaj: birleştirilmez/deduplicate edilmez
    // -------------------------------------------------------------------------
    it('scenario 12: two passages sharing the title "Meeting Notes" but with distinct objectIds are both kept in sources, not merged or deduplicated', async () => {
      const provider = MockProvider.fixed({
        text: 'Velocity dropped then recovered across two quarters.',
        usage: { inputTokens: 25, outputTokens: 9 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'How did velocity trend across quarters?',
        passages: [P_MEETING_A, P_MEETING_B],
        recordUsage,
      });

      expect(result.sources).toHaveLength(2);
      expect(result.sources.map((s) => s.objectId).sort()).toEqual([
        'obj-meeting-a',
        'obj-meeting-b',
      ]);
    });

    // -------------------------------------------------------------------------
    // Scenario 13 — dönen nesne tam olarak {answer, sources} şeklindedir
    // -------------------------------------------------------------------------
    it('scenario 13: the returned object has exactly the keys "answer" and "sources", nothing more or less', async () => {
      const provider = MockProvider.fixed({
        text: 'An answer.',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'Anything?',
        passages: [P_ONBOARD],
        recordUsage,
      });

      expect(Object.keys(result).sort()).toEqual(['answer', 'sources']);
    });

    // -------------------------------------------------------------------------
    // Scenario 14 — sources modelin metninden türetilmez: model tek pasajdan bahsetse bile hepsi döner
    // -------------------------------------------------------------------------
    it('scenario 14: sources are input-equal, never derived from the model text -- even when the model text names only one passage, sources still include ALL input passages', async () => {
      const provider = MockProvider.fixed({
        text: `Based on "${P_ROLLBACK.title}" alone, revert the release tag.`,
        usage: { inputTokens: 40, outputTokens: 15 },
      });
      const { recordUsage } = collectUsage();
      const passages = [P_ROLLBACK, P_DEPLOY, P_SECURITY];

      const result = await answerQuestion({
        provider,
        question: 'How do we roll back safely?',
        passages,
        recordUsage,
      });

      expect(result.sources).toEqual(passages);
    });

    // -------------------------------------------------------------------------
    // Scenario 15 — model metni HİÇBİR pasaj başlığından bahsetmese bile sources tam girdi kadar kalır
    // -------------------------------------------------------------------------
    it('scenario 15: even when the model text is fully generic and mentions no passage title at all, sources remain exactly as many as the input', async () => {
      const provider = MockProvider.fixed({
        text: 'Here is a general summary of the relevant policies.',
        usage: { inputTokens: 35, outputTokens: 12 },
      });
      const { recordUsage } = collectUsage();
      const passages = [P_REFUND, P_SHIPPING];

      const result = await answerQuestion({
        provider,
        question: 'Summarize our order-related policies.',
        passages,
        recordUsage,
      });

      expect(result.sources).toEqual(passages);
      expect(result.sources).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Grup D — İçerik çeşitliliği ve özel karakterler (16-24)
  // ===========================================================================
  describe('Grup D — İçerik çeşitliliği ve özel karakterler', () => {
    // -------------------------------------------------------------------------
    // Scenario 16 — boş snippet'li pasaj: hata fırlatmaz, başlık prompt'ta, source korunur
    // -------------------------------------------------------------------------
    it('scenario 16: a passage list that includes an empty-snippet passage does not throw, still includes the title in the prompt, and keeps the empty-snippet passage intact in sources', async () => {
      const provider = MockProvider.fixed({
        text: 'No content available for that item.',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const { recordUsage } = collectUsage();

      const resultPromise = answerQuestion({
        provider,
        question: 'What does the placeholder doc say?',
        passages: [P_EMPTY_SNIPPET],
        recordUsage,
      });

      await expect(resultPromise).resolves.toBeDefined();
      const result = await resultPromise;
      expect(result.sources).toEqual([P_EMPTY_SNIPPET]);
    });

    // -------------------------------------------------------------------------
    // Scenario 17 — uzun snippet: prompt'ta tam ve kesilmemiş olarak yer alır
    // -------------------------------------------------------------------------
    it('scenario 17: a long (300+ char) snippet appears verbatim, in full, in the prompt -- not truncated', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'Onboarding covers provisioning, training, team intro, and tooling.',
        usage: { inputTokens: 80, outputTokens: 20 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'What does onboarding cover?',
        passages: [P_LONG],
        recordUsage,
      });

      expect(P_LONG.snippet.length).toBeGreaterThan(300);
      expect(getLastRequest()?.prompt).toContain(P_LONG.snippet);
    });

    // -------------------------------------------------------------------------
    // Scenario 18 — özel karakterli çok satırlı soru: prompt'un son "Question: " satırı tam eşleşir
    // -------------------------------------------------------------------------
    it('scenario 18: a multi-line question containing braces and quotes appears verbatim in the prompt\'s "Question: " line', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'It means the task is blocked.',
        usage: { inputTokens: 20, outputTokens: 6 },
      }));
      const { recordUsage } = collectUsage();
      const question = 'What does "{status}" mean in our workflow?\nIs it urgent?';

      await answerQuestion({
        provider,
        question,
        passages: [P_SPRINT],
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain(`Question: ${question}`);
    });

    // -------------------------------------------------------------------------
    // Scenario 19 — markdown benzeri karakterli snippet: prompt'ta kaçışsız aynen yer alır
    // -------------------------------------------------------------------------
    it('scenario 19: a passage snippet containing markdown-like characters appears verbatim and unescaped in the prompt', async () => {
      const markdownPassage: QAPassage = {
        objectId: 'obj-markdown-1',
        title: 'Formatting Guide',
        snippet: 'Use *bold* or [links](url) and # headers.',
      };
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'You can use bold, links, and headers.',
        usage: { inputTokens: 15, outputTokens: 5 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'How do I format text?',
        passages: [markdownPassage],
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain('Use *bold* or [links](url) and # headers.');
    });

    // -------------------------------------------------------------------------
    // Scenario 20 — Türkçe pasaj: başlık ve snippet UTF-8 sadakatiyle aynen yer alır
    // -------------------------------------------------------------------------
    it('scenario 20: a Turkish-language passage title and snippet appear verbatim (UTF-8 fidelity) in the prompt', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'Haftada üç güne kadar uzaktan çalışabilirsiniz.',
        usage: { inputTokens: 25, outputTokens: 10 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'Uzaktan çalışma politikamız nedir?',
        passages: [P_TURKISH],
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain(P_TURKISH.title);
      expect(getLastRequest()?.prompt).toContain(P_TURKISH.snippet);
    });

    // -------------------------------------------------------------------------
    // Scenario 21 — para birimi biçimli snippet: '$42,000' yeniden biçimlendirilmeden aynen yer alır
    // -------------------------------------------------------------------------
    it('scenario 21: a currency-formatted snippet ("$42,000") appears verbatim in the prompt, not reformatted', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'The Q3 marketing budget is $42,000.',
        usage: { inputTokens: 20, outputTokens: 8 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'What is our Q3 marketing budget?',
        passages: [P_BUDGET],
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain('$42,000');
    });

    // -------------------------------------------------------------------------
    // Scenario 22 — alıntılı snippet: gömülü tırnaklı cümle aynen yer alır
    // -------------------------------------------------------------------------
    it('scenario 22: a passage snippet containing an embedded quoted sentence appears verbatim in the prompt', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'A customer found onboarding confusing at first.',
        usage: { inputTokens: 20, outputTokens: 8 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'What feedback have customers given about onboarding?',
        passages: [P_QUOTE],
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain(
        'One customer wrote: "the onboarding process was confusing at first."',
      );
    });

    // -------------------------------------------------------------------------
    // Scenario 23 — baştaki/sondaki boşluklu snippet: trim edilmeden aynen yer alır
    // -------------------------------------------------------------------------
    it('scenario 23: a snippet with leading/trailing whitespace appears in the prompt WITH those exact spaces intact (not trimmed)', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'Draft notes preserved as-is.',
        usage: { inputTokens: 10, outputTokens: 4 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'What do the draft notes say?',
        passages: [P_WHITESPACE],
        recordUsage,
      });

      expect(getLastRequest()?.prompt).toContain(P_WHITESPACE.snippet);
    });

    // -------------------------------------------------------------------------
    // Scenario 24 — pasaj başlığı sorunun kendisiyle aynı: iki ayrı satır olarak korunur
    // -------------------------------------------------------------------------
    it('scenario 24: a passage whose title equals the question string exactly still produces a distinct "Question: Status Update" line separate from the "[1] Status Update" passage line', async () => {
      const selfTitledPassage: QAPassage = {
        objectId: 'obj-status-1',
        title: 'Status Update',
        snippet: 'The rollout is on track for Friday.',
      };
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'The rollout is on track.',
        usage: { inputTokens: 15, outputTokens: 6 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'Status Update',
        passages: [selfTitledPassage],
        recordUsage,
      });

      const prompt = getLastRequest()?.prompt ?? '';
      expect(prompt).toContain('[1] Status Update');
      expect(prompt).toContain('Question: Status Update');

      const firstIdx = prompt.indexOf('Status Update');
      const secondIdx = prompt.indexOf('Status Update', firstIdx + 1);
      const thirdIdx = prompt.indexOf('Status Update', secondIdx + 1);
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);
      expect(thirdIdx).toBe(-1);
    });
  });

  // ===========================================================================
  // Grup E — Halüsinasyon karşıtı talimat kalıcılığı (25-27)
  // ===========================================================================
  describe('Grup E — Halüsinasyon karşıtı talimat kalıcılığı', () => {
    // -------------------------------------------------------------------------
    // Scenario 25 — tek pasajla: "only"/"yalnız" + "passage"/"pasaj" talimatı var
    // -------------------------------------------------------------------------
    it('scenario 25: with a single passage, the prompt matches both the "only"/"yalnız" and "passage"/"pasaj" anti-hallucination markers', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'An answer.',
        usage: { inputTokens: 10, outputTokens: 5 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'What is our security policy?',
        passages: [P_SECURITY],
        recordUsage,
      });

      const prompt = getLastRequest()?.prompt ?? '';
      expect(prompt).toMatch(/\bonly\b|\byalnız/i);
      expect(prompt).toMatch(/passage|pasaj/i);
    });

    // -------------------------------------------------------------------------
    // Scenario 26 — beş pasajla: aynı iki regex hâlâ geçerli (talimat sulanmıyor)
    // -------------------------------------------------------------------------
    it('scenario 26: with five passages, the same two anti-hallucination regexes still hold -- the guardrail does not get diluted or dropped as passage count grows', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'A broad answer.',
        usage: { inputTokens: 90, outputTokens: 25 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'Summarize everything relevant.',
        passages: [P_ONBOARD, P_REMOTE, P_ROLLBACK, P_DEPLOY, P_SECURITY],
        recordUsage,
      });

      const prompt = getLastRequest()?.prompt ?? '';
      expect(prompt).toMatch(/\bonly\b|\byalnız/i);
      expect(prompt).toMatch(/passage|pasaj/i);
    });

    // -------------------------------------------------------------------------
    // Scenario 27 — iki pasajla: talimat metni her zaman ilk pasajdan önce gelir
    // -------------------------------------------------------------------------
    it("scenario 27: with two passages, the instruction text always precedes the first passage's content in the prompt", async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'An answer.',
        usage: { inputTokens: 20, outputTokens: 8 },
      }));
      const { recordUsage } = collectUsage();
      const firstPassage = P_ROLLBACK;
      const passages = [firstPassage, P_DEPLOY];

      await answerQuestion({
        provider,
        question: 'How do we deploy and roll back safely?',
        passages,
        recordUsage,
      });

      const prompt = getLastRequest()?.prompt ?? '';
      const instructionIdx = prompt.search(/\bonly\b|\byalnız/i);
      const firstPassageIdx = prompt.indexOf(firstPassage.title);
      expect(instructionIdx).toBeGreaterThanOrEqual(0);
      expect(firstPassageIdx).toBeGreaterThan(instructionIdx);
    });
  });

  // ===========================================================================
  // Grup F — Model yönlendirme ve kullanım (usage) kaydı (28-33)
  // ===========================================================================
  describe('Grup F — Model yönlendirme ve kullanım (usage) kaydı', () => {
    // -------------------------------------------------------------------------
    // Scenario 28 — model verildiğinde provider isteğine aynen ulaşır
    // -------------------------------------------------------------------------
    it('scenario 28: when model is given, provider.complete receives that exact model string', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'Two-factor authentication is required.',
        usage: { inputTokens: 20, outputTokens: 8 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'Is 2FA required for admins?',
        passages: [P_SECURITY],
        model: 'claude-sonnet-5-20260101',
        recordUsage,
      });

      expect(getLastRequest()?.model).toBe('claude-sonnet-5-20260101');
    });

    // -------------------------------------------------------------------------
    // Scenario 29 — model verilmediğinde provider isteğinde model undefined kalır
    // -------------------------------------------------------------------------
    it('scenario 29: when model is omitted, provider.complete receives model === undefined', async () => {
      const { provider, getLastRequest } = capturingProvider(() => ({
        text: 'The team prioritized checkout.',
        usage: { inputTokens: 15, outputTokens: 6 },
      }));
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'What did the team prioritize this sprint?',
        passages: [P_SPRINT],
        recordUsage,
      });

      expect(getLastRequest()?.model).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // Scenario 30 — tek pasajlı senaryoda recordUsage tam olarak provider usage'ıyla bir kez çağrılır
    // -------------------------------------------------------------------------
    it('scenario 30: single-passage scenario -- recordUsage is called exactly once with exactly the provider-reported usage { inputTokens: 80, outputTokens: 15 }', async () => {
      const provider = MockProvider.fixed({
        text: 'Refunds take 5 business days.',
        usage: { inputTokens: 80, outputTokens: 15 },
      });
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'How long do refunds take?',
        passages: [P_REFUND],
        recordUsage,
      });

      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 80, outputTokens: 15 });
    });

    // -------------------------------------------------------------------------
    // Scenario 31 — beş pasajlı senaryoda recordUsage aynen provider'ın kendi sayılarını iletir
    // -------------------------------------------------------------------------
    it('scenario 31: five-passage scenario -- recordUsage is called exactly once with exactly the provider-reported usage { inputTokens: 400, outputTokens: 60 } (forwards provider numbers, does not compute its own)', async () => {
      const provider = MockProvider.fixed({
        text: 'A broad synthesis.',
        usage: { inputTokens: 400, outputTokens: 60 },
      });
      const { recordUsage } = collectUsage();

      await answerQuestion({
        provider,
        question: 'Summarize onboarding, remote work, rollback, deploy, and security.',
        passages: [P_ONBOARD, P_REMOTE, P_ROLLBACK, P_DEPLOY, P_SECURITY],
        recordUsage,
      });

      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 400, outputTokens: 60 });
    });

    // -------------------------------------------------------------------------
    // Scenario 32 — provider.complete throw ederse hata yukarı yayılır, recordUsage hiç çağrılmaz
    // -------------------------------------------------------------------------
    it('scenario 32: when provider.complete throws, the error propagates and recordUsage is never called', async () => {
      const provider = new MockProvider((): AICompletionResult => {
        throw new Error('rate limited');
      });
      const recordUsage = vi.fn();

      await expect(
        answerQuestion({
          provider,
          question: 'What is our shipping policy?',
          passages: [P_SHIPPING],
          recordUsage,
        }),
      ).rejects.toThrow('rate limited');

      expect(recordUsage).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Scenario 33 — recordUsage reddedilirse (rejects) hata sessizce yutulmaz, yukarı yayılır
    // -------------------------------------------------------------------------
    it('scenario 33: when recordUsage itself rejects, that rejection propagates and is NOT silently swallowed', async () => {
      const provider = MockProvider.fixed({
        text: 'Standard shipping takes 3-7 business days.',
        usage: { inputTokens: 15, outputTokens: 6 },
      });
      const recordUsage = vi.fn().mockRejectedValue(new Error('quota tracking failed'));

      await expect(
        answerQuestion({
          provider,
          question: 'How long does shipping take?',
          passages: [P_SHIPPING],
          recordUsage,
        }),
      ).rejects.toThrow('quota tracking failed');
    });
  });

  // ===========================================================================
  // Grup G — Loglama disiplini (34)
  // ===========================================================================
  describe('Grup G — Loglama disiplini', () => {
    // -------------------------------------------------------------------------
    // Scenario 34 — question/passage/provider yanıtı işaretli içerik taşısa bile console.* hiç çağrılmaz
    // -------------------------------------------------------------------------
    it('scenario 34: console.log/error/warn are never called while answering a question whose question, passage, and provider response all contain distinct marker strings', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const markedPassage: QAPassage = {
        objectId: 'obj-marker-1',
        title: 'MARKER-QA-TITLE-55555',
        snippet: 'MARKER-QA-SNIPPET-66666',
      };
      const provider = MockProvider.fixed({
        text: 'MARKER-QA-ANSWER-77777',
        usage: { inputTokens: 5, outputTokens: 5 },
      });
      const recordUsage = vi.fn();

      await answerQuestion({
        provider,
        question: 'MARKER-QA-QUESTION-88888',
        passages: [markedPassage],
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

  // ===========================================================================
  // Grup H — Gerçekçi uçtan uca senaryolar (35-40)
  // ===========================================================================
  describe('Grup H — Gerçekçi uçtan uca senaryolar', () => {
    // -------------------------------------------------------------------------
    // Scenario 35 — İK: tek pasaj, gerçekçi cevap
    // -------------------------------------------------------------------------
    it('scenario 35: HR scenario -- a single remote-work passage answers "Kaç gün uzaktan çalışabilirim?" realistically', async () => {
      const provider = MockProvider.fixed({
        text: 'Yöneticinizin onayıyla haftada üç güne kadar uzaktan çalışabilirsiniz.',
        usage: { inputTokens: 30, outputTokens: 12 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'Kaç gün uzaktan çalışabilirim?',
        passages: [P_REMOTE],
        recordUsage,
      });

      expect(result.answer).toBe(
        'Yöneticinizin onayıyla haftada üç güne kadar uzaktan çalışabilirsiniz.',
      );
      expect(result.sources).toEqual([P_REMOTE]);
    });

    // -------------------------------------------------------------------------
    // Scenario 36 — Mühendislik: iki pasaj, güvenli rollback sentezi
    // -------------------------------------------------------------------------
    it('scenario 36: engineering scenario -- rollback + deploy passages synthesize a safe-rollback answer, with both sources present', async () => {
      const provider = MockProvider.fixed({
        text: 'Confirm the migration is backward compatible, then revert the release tag and redeploy the previous artifact within 15 minutes.',
        usage: { inputTokens: 70, outputTokens: 25 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'What is the safe procedure to roll back a bad deploy?',
        passages: [P_ROLLBACK, P_DEPLOY],
        recordUsage,
      });

      expect(result.sources).toEqual([P_ROLLBACK, P_DEPLOY]);
      expect(result.answer).toContain('revert the release tag');
    });

    // -------------------------------------------------------------------------
    // Scenario 37 — Güvenlik: tek pasaj, hassas görünen ama pasaja bağlı cevap
    // -------------------------------------------------------------------------
    it('scenario 37: security scenario -- a single sensitive-sounding passage produces an answer strictly derived from that passage', async () => {
      const provider = MockProvider.fixed({
        text: 'Yes, two-factor authentication is required for all workspace admin accounts.',
        usage: { inputTokens: 25, outputTokens: 10 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'Is two-factor authentication required for admin accounts?',
        passages: [P_SECURITY],
        recordUsage,
      });

      expect(result.answer).toBe(
        'Yes, two-factor authentication is required for all workspace admin accounts.',
      );
      expect(result.sources).toEqual([P_SECURITY]);
    });

    // -------------------------------------------------------------------------
    // Scenario 38 — Müşteri destek: iki pasaj, iki politikayı kapsayan soru
    // -------------------------------------------------------------------------
    it('scenario 38: customer-support scenario -- a question spanning both refund and shipping policies keeps both sources, in order', async () => {
      const provider = MockProvider.fixed({
        text: 'Refunds are issued within 5 business days, and standard shipping takes 3-7 business days.',
        usage: { inputTokens: 55, outputTokens: 20 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'What are your refund and shipping timelines?',
        passages: [P_REFUND, P_SHIPPING],
        recordUsage,
      });

      expect(result.sources).toEqual([P_REFUND, P_SHIPPING]);
    });

    // -------------------------------------------------------------------------
    // Scenario 39 — Proje yönetimi: tek pasaj, sprint önceliği sorusu
    // -------------------------------------------------------------------------
    it('scenario 39: project-management scenario -- a single sprint-planning passage answers a sprint-priority question', async () => {
      const provider = MockProvider.fixed({
        text: 'The team prioritized the checkout redesign over the search filter improvements.',
        usage: { inputTokens: 20, outputTokens: 10 },
      });
      const { recordUsage } = collectUsage();

      const result = await answerQuestion({
        provider,
        question: 'What did the team prioritize this sprint?',
        passages: [P_SPRINT],
        recordUsage,
      });

      expect(result.answer).toBe(
        'The team prioritized the checkout redesign over the search filter improvements.',
      );
      expect(result.sources).toEqual([P_SPRINT]);
    });

    // -------------------------------------------------------------------------
    // Scenario 40 — Capstone: 5 pasaj (Türkçe+İngilizce karışık), model belirtilmiş,
    // her şeyi tek testte doğrular (ai-fields.eval.test.ts'in senaryo 10'una paralel)
    // -------------------------------------------------------------------------
    it("scenario 40: capstone -- five mixed Turkish/English passages with a specified model verify, in ONE test, provider called once, recordUsage called once with the provider's exact usage, sources equal to the 5 input passages in order, the anti-hallucination instruction present, and all 5 titles+snippets present in the prompt", async () => {
      const { provider, getCallCount, getLastRequest } = capturingProvider(() => ({
        text: 'A comprehensive, mixed-language summary across five workspace topics.',
        usage: { inputTokens: 500, outputTokens: 80 },
      }));
      const { recordUsage } = collectUsage();
      const passages = [P_TURKISH, P_REMOTE, P_ROLLBACK, P_SECURITY, P_SPRINT];

      const result = await answerQuestion({
        provider,
        question:
          'Uzaktan çalışma, rollback prosedürü, güvenlik ve sprint önceliklerini özetler misin?',
        passages,
        model: 'claude-sonnet-5-20260101',
        recordUsage,
      });

      expect(getCallCount()).toBe(1);
      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 500, outputTokens: 80 });
      expect(result.sources).toEqual(passages);

      const prompt = getLastRequest()?.prompt ?? '';
      expect(prompt).toMatch(/\bonly\b|\byalnız/i);
      expect(prompt).toMatch(/passage|pasaj/i);
      for (const passage of passages) {
        expect(prompt).toContain(passage.title);
        expect(prompt).toContain(passage.snippet);
      }
      expect(getLastRequest()?.model).toBe('claude-sonnet-5-20260101');
    });
  });
});
