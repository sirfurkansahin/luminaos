import { describe, expect, it } from 'vitest';

import { extractMentionCandidates } from './object-comments.service.js';

/**
 * F3-T3 PR6 (ADR-0037 hardening pass): pinned regression tests for
 * `extractMentionCandidates`'s underlying `MENTION_REGEX` (`@([A-Za-z0-9_-]
 * {2,32})\b`, `object-comments.service.ts`) — a BOUNDED quantifier with no
 * nested quantifiers, which is inherently linear-time regardless of input
 * length (no catastrophic-backtracking shape is even possible here). These
 * tests pin that bound BEHAVIORALLY (through the extraction function's own
 * observable output), rather than depend on the raw regex source being
 * exported, per this task's own guidance to prefer testing the real code
 * path `CommentsService.create` actually calls.
 *
 * `MAX_COMMENT_BODY_LENGTH = 2000` (`dto/create-comment.schema.ts`, F3-T3
 * PR2's own security fix) is the PRIMARY defense against a pathologically
 * large comment body ever reaching this function in the first place — these
 * tests are defense-in-depth for any OTHER caller that might not go through
 * that DTO (e.g. a future direct-call site, or a crafted event payload).
 */
describe('extractMentionCandidates -- ReDoS-safety / bounded-quantifier pinning (F3-T3 PR6)', () => {
  it('captures a handle of exactly 32 characters (the upper bound) in full', () => {
    const handle = 'a'.repeat(32);
    const result = extractMentionCandidates(`Hey @${handle} please look.`);
    expect(result).toEqual([handle]);
  });

  it('captures NOTHING for a run of 33+ word characters after "@" -- the bound is a hard ceiling, not a truncation: no length between 2 and 32 satisfies the trailing \\b inside an unbroken word-character run', () => {
    const tooLong = 'a'.repeat(33);
    const result = extractMentionCandidates(`Hey @${tooLong} please look.`);
    expect(result).toEqual([]);
  });

  it('captures nothing for a 1-character candidate (below the {2,32} lower bound)', () => {
    const result = extractMentionCandidates('Hey @x please look.');
    expect(result).toEqual([]);
  });

  it('completes in well under a generous safety bound for a single pathologically long unbroken word-character run (10,000 chars, no spaces) -- no catastrophic-backtracking blowup', () => {
    const pathological = `@${'a'.repeat(10_000)}`;

    const start = performance.now();
    const result = extractMentionCandidates(pathological);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(200);
    // The whole 10,000-char run never satisfies the trailing \b at any
    // length 2..32 (it's all word characters, no boundary until the string
    // ends past position 32) -- consistent with the "hard ceiling" test
    // above, so nothing is captured here either.
    expect(result).toEqual([]);
  });

  it('completes in well under a generous safety bound for MANY separate mention candidates in one large body (2,000 occurrences)', () => {
    const manyMentions = Array.from({ length: 2000 }, (_, index) => `@handle${String(index)}`).join(
      ' ',
    );

    const start = performance.now();
    const result = extractMentionCandidates(manyMentions);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(200);
    expect(result).toHaveLength(2000);
  });

  it('a body that is entirely "@" characters with no trailing valid handle characters captures nothing', () => {
    const allAtSigns = '@'.repeat(5000);

    const start = performance.now();
    const result = extractMentionCandidates(allAtSigns);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(200);
    expect(result).toEqual([]);
  });
});
