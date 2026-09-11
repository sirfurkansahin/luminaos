import { describe, expect, it, vi } from 'vitest';

import { MockProvider } from '@luminaos/ai-gateway';
import type { AICompletionRequest, AICompletionResult, AITokenUsage } from '@luminaos/ai-gateway';
import { renderArtifactHtml } from '@luminaos/artifacts';
import type { ArtifactContent } from '@luminaos/artifacts';

import { generateArtifact } from './generate-artifact.js';

import type { GenerateArtifactResult } from './generate-artifact.js';

/**
 * F3-T7 PR2 (RED step) — `generateArtifact`, a NEW, DB-free, pure "turn a
 * natural-language prompt into rendered artifact HTML" orchestrator: sibling
 * of `parseCommand` (`../ai/parse-command.ts`)/`resolveAIFieldValue`
 * (`../ai/resolve-ai-field-value.ts`) — provider/model/recordUsage all
 * injected, no Postgres/EventStore, exercised directly against `MockProvider`.
 * Per ADR-0041 Karar (c), the model NEVER produces raw HTML/CSS/JS — only
 * structured `ArtifactContent` (title + typed sections), validated by
 * `@luminaos/artifacts`'s `artifactContentSchema`, then wrapped by the REAL
 * `renderArtifactHtml` (imported here from the already-shipped, already-tested
 * `packages/artifacts`, F3-T7 PR1) into the final self-contained HTML string.
 *
 * Designed contract (must be matched exactly by `implementer` —
 * `./generate-artifact.ts` does not exist yet on this branch):
 *
 *   export interface GenerateArtifactInput {
 *     provider: AIProvider;
 *     prompt: string;
 *     artifactType: ArtifactType;
 *     themePreset: ThemePresetName;
 *     model?: string;
 *     recordUsage: (usage: AITokenUsage) => Promise<void> | void;
 *   }
 *
 *   export interface GenerateArtifactResult {
 *     htmlContent: string;
 *     parseError: boolean;   // true only on a failure path (double-parse-failure OR oversized render)
 *     message?: string;      // present only when parseError is true
 *   }
 *
 *   export async function generateArtifact(input: GenerateArtifactInput): Promise<GenerateArtifactResult>;
 *
 * Behavior pinned by the tests below:
 *
 *  a. Happy path (valid JSON matching `artifactContentSchema`, first
 *     attempt): `provider.complete` called exactly ONCE, `recordUsage`
 *     called exactly once with the provider's own usage, returns
 *     `{ htmlContent: <renderArtifactHtml(content, themePreset, artifactType)>,
 *     parseError: false }` with NO `message` key — `htmlContent` must be
 *     the REAL `renderArtifactHtml` output (this test computes the expected
 *     value the same way, off the same content/theme/artifactType, and
 *     asserts byte-for-byte equality), not some ad-hoc re-implementation.
 *  b. Retry-once on malformed (non-JSON) response, second attempt succeeds:
 *     `provider.complete` called exactly TWICE with an IDENTICAL `prompt`
 *     both times (mirrors `parse-command.test.ts`'s retry-assertion style)
 *     -- returns the successfully-parsed/rendered result from the SECOND
 *     attempt. `recordUsage` is called once PER `provider.complete` call
 *     (twice total here), mirroring `parseCommand`'s own unconditional
 *     per-attempt `recordUsage` convention.
 *  c. Retry-once on syntactically-valid-JSON-but-schema-invalid response
 *     (e.g. missing the required `title` field) -- same retry-then-succeed
 *     path as (b).
 *  d. Double failure (both attempts unparseable/schema-invalid): never
 *     throws. Returns `{ htmlContent: '', parseError: true, message:
 *     <string> }`. `provider.complete` called exactly twice (no third
 *     attempt); `recordUsage` called exactly twice.
 *  e. `MAX_ARTIFACT_HTML_LENGTH` (200_000 chars) exceeded: a FIRST-ATTEMPT
 *     response that parses successfully into valid `ArtifactContent` but
 *     whose rendered HTML exceeds the cap -- NO retry attempted (parsing
 *     itself succeeded; only the size check fails), `provider.complete`
 *     called exactly ONCE, `recordUsage` called exactly once, returns
 *     `{ htmlContent: '', parseError: true, message: 'Generated artifact
 *     exceeded the maximum allowed size' }`.
 *  f. Model forwarding: `model` forwarded into `provider.complete({ prompt,
 *     model })` unchanged when given; omitted entirely when not provided.
 *  g. No content logging: mirrors `parse-command.test.ts`'s "never logs"
 *     test style -- prompt/generated-content must never reach
 *     `console.log`/`console.error`/`console.warn` (ADR-0008 discipline).
 *
 * Nothing under test here exists yet: `./generate-artifact.ts` has not been
 * written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

function collectUsage(): {
  recordUsage: ReturnType<typeof vi.fn<(usage: AITokenUsage) => void>>;
} {
  return { recordUsage: vi.fn() };
}

/** A single, schema-valid `ArtifactContent` -- one heading + one paragraph. */
function validContentJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Q3 Onboarding Overview',
    sections: [
      { kind: 'heading', text: 'Welcome', level: 1 },
      { kind: 'paragraph', text: 'This artifact summarizes the Q3 onboarding checklist.' },
    ],
    ...overrides,
  };
}

/**
 * Schema-valid `ArtifactContent` whose rendered HTML is guaranteed to exceed
 * `MAX_ARTIFACT_HTML_LENGTH` (200_000 chars): a single `table` section at the
 * schema's own maximums (20 headers x 200 chars, 100 rows x 20 cells x 500
 * chars) renders well over 1,000,000 characters of cell markup alone --
 * comfortably over the cap while still passing `artifactContentSchema`
 * (`headers.max(20)`, `rows.max(100)` arrays each `.max(20)` cells of
 * `.max(500)` chars) unmodified.
 */
function oversizedContentJson(): ArtifactContent {
  const headers = Array.from({ length: 20 }, (_, index) =>
    `Column ${String(index)}`.padEnd(200, 'x'),
  );
  const rows = Array.from({ length: 100 }, () => Array.from({ length: 20 }, () => 'x'.repeat(500)));

  return {
    title: 'Oversized Report',
    sections: [{ kind: 'table', headers, rows }],
  };
}

describe('generateArtifact — happy path (valid content on the first attempt)', () => {
  it('calls provider.complete exactly once, records usage exactly once, and returns the REAL renderArtifactHtml output with parseError: false and no message key', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(validContentJson()),
        usage: { inputTokens: 50, outputTokens: 15 },
      };
    });
    const { recordUsage } = collectUsage();

    const result: GenerateArtifactResult = await generateArtifact({
      provider,
      prompt: 'Summarize our Q3 onboarding checklist',
      artifactType: 'report',
      themePreset: 'kurumsal',
      recordUsage,
    });

    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 50, outputTokens: 15 });

    expect(result.parseError).toBe(false);
    expect(result.message).toBeUndefined();

    const expectedContent = validContentJson() as unknown as ArtifactContent;
    const expectedHtml = renderArtifactHtml(expectedContent, 'kurumsal', 'report');
    expect(result.htmlContent).toBe(expectedHtml);

    // Sanity: this is a real, self-contained HTML document, not a stub.
    expect(result.htmlContent).toContain('<!DOCTYPE html>');
    expect(result.htmlContent).toContain('Q3 Onboarding Overview');
  });
});

describe('generateArtifact — retry-once on malformed/invalid responses', () => {
  it('retries with the IDENTICAL prompt exactly once when the first response is not valid JSON, and returns the successfully-parsed/rendered second attempt', async () => {
    const capturedRequests: AICompletionRequest[] = [];
    let callCount = 0;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequests.push(request);
      callCount += 1;
      return callCount === 1
        ? { text: 'not json at all', usage: { inputTokens: 30, outputTokens: 5 } }
        : { text: JSON.stringify(validContentJson()), usage: { inputTokens: 30, outputTokens: 8 } };
    });
    const { recordUsage } = collectUsage();

    const result = await generateArtifact({
      provider,
      prompt: 'Summarize our Q3 onboarding checklist',
      artifactType: 'report',
      themePreset: 'minimal',
      recordUsage,
    });

    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]?.prompt).toBe(capturedRequests[1]?.prompt);

    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, { inputTokens: 30, outputTokens: 5 });
    expect(recordUsage).toHaveBeenNthCalledWith(2, { inputTokens: 30, outputTokens: 8 });

    expect(result.parseError).toBe(false);
    expect(result.htmlContent).toContain('Q3 Onboarding Overview');
  });

  it('also retries when the first response is syntactically valid JSON but fails artifactContentSchema validation (e.g. missing the required "title" field)', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      if (callCount === 1) {
        const withoutTitle = Object.fromEntries(
          Object.entries(validContentJson()).filter(([key]) => key !== 'title'),
        );
        return { text: JSON.stringify(withoutTitle), usage: { inputTokens: 20, outputTokens: 4 } };
      }
      return {
        text: JSON.stringify(validContentJson()),
        usage: { inputTokens: 20, outputTokens: 6 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await generateArtifact({
      provider,
      prompt: 'Summarize our Q3 onboarding checklist',
      artifactType: 'page',
      themePreset: 'canli',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(result.parseError).toBe(false);
    expect(result.htmlContent.length).toBeGreaterThan(0);
  });
});

describe('generateArtifact — double failure (safe fallback, never throws)', () => {
  it('returns { htmlContent: "", parseError: true, message } when BOTH attempts are unparseable/schema-invalid, and never attempts a third call', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: `still not json (attempt ${String(callCount)})`,
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await generateArtifact({
      provider,
      prompt: 'Do something ambiguous',
      artifactType: 'dashboard',
      themePreset: 'kurumsal',
      recordUsage,
    });

    expect(callCount).toBe(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);

    expect(result.htmlContent).toBe('');
    expect(result.parseError).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message?.length).toBeGreaterThan(0);
  });
});

describe('generateArtifact — MAX_ARTIFACT_HTML_LENGTH (200_000 chars) enforcement', () => {
  it('returns the oversized-failure sentinel, with NO retry, when a schema-valid response renders to more than 200_000 characters of HTML', async () => {
    let callCount = 0;
    const provider = new MockProvider((): AICompletionResult => {
      callCount += 1;
      return {
        text: JSON.stringify(oversizedContentJson()),
        usage: { inputTokens: 500, outputTokens: 900 },
      };
    });
    const { recordUsage } = collectUsage();

    // Sanity check on this file's own fixture: the REAL renderArtifactHtml
    // (imported from the already-shipped `packages/artifacts`) really does
    // exceed the cap for this content, so this test is exercising the size
    // guard, not a parse failure.
    const sanityHtml = renderArtifactHtml(oversizedContentJson(), 'kurumsal', 'dashboard');
    expect(sanityHtml.length).toBeGreaterThan(200_000);

    const result = await generateArtifact({
      provider,
      prompt: 'Build a giant static dashboard snapshot',
      artifactType: 'dashboard',
      themePreset: 'kurumsal',
      recordUsage,
    });

    // Parsing succeeded on the FIRST attempt (it is schema-valid) -- only the
    // size check failed, so there must be no retry.
    expect(callCount).toBe(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);

    expect(result.htmlContent).toBe('');
    expect(result.parseError).toBe(true);
    expect(result.message).toBe('Generated artifact exceeded the maximum allowed size');
  });
});

describe('generateArtifact — model forwarding', () => {
  it('when the caller passes model, provider.complete(...) receives that exact model alongside the rendered prompt', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify(validContentJson()),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    await generateArtifact({
      provider,
      prompt: 'Summarize our Q3 onboarding checklist',
      artifactType: 'presentation',
      themePreset: 'minimal',
      model: 'claude-sonnet-5-20260101',
      recordUsage,
    });

    expect(capturedRequest?.model).toBe('claude-sonnet-5-20260101');
  });

  it('backward compatibility: omitting model still generates correctly and sends no model key (or an undefined one) to provider.complete', async () => {
    let capturedRequest: AICompletionRequest | undefined;
    const provider = new MockProvider((request: AICompletionRequest): AICompletionResult => {
      capturedRequest = request;
      return {
        text: JSON.stringify(validContentJson()),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const { recordUsage } = collectUsage();

    const result = await generateArtifact({
      provider,
      prompt: 'Summarize our Q3 onboarding checklist',
      artifactType: 'presentation',
      themePreset: 'minimal',
      recordUsage,
    });

    expect(result.parseError).toBe(false);
    expect(capturedRequest?.model).toBeUndefined();
  });
});

describe('generateArtifact — never logs prompt or generated content', () => {
  it('does not call console.log/console.error/console.warn while generating an artifact containing recognizable content', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = MockProvider.fixed({
      text: JSON.stringify(
        validContentJson({
          title: 'SECRET-TITLE-MARKER-11111',
          sections: [{ kind: 'paragraph', text: 'SECRET-BODY-MARKER-22222' }],
        }),
      ),
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const { recordUsage } = collectUsage();

    await generateArtifact({
      provider,
      prompt: 'SECRET-PROMPT-MARKER-33333',
      artifactType: 'report',
      themePreset: 'kurumsal',
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
