import { describe, expect, it } from 'vitest';

import { deviationExplanationSchema } from './deviation-explanation.js';

/**
 * F3-T11 PR1 (RED step), ADR-0045 Karar (b) — `packages/artifacts/src/deviation-explanation.ts`.
 *
 *   export const deviationExplanationSchema = z.object({
 *     summary: z.string().min(1).max(2000),
 *     possibleCauses: z.array(z.string().min(1).max(500)).min(1).max(5),
 *   }).strict();
 *   export type DeviationExplanationContent = z.infer<typeof deviationExplanationSchema>;
 *
 * Mirrors `artifact-content.test.ts`'s exact schema-boundary-testing
 * convention (safeParse().success assertions, one behavior per `it`).
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/deviation-explanation.ts` -- this module does not
 * exist yet at all, so this import fails with "Cannot find module".
 */

function buildContent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    summary: 'some text',
    possibleCauses: ['cause 1', 'cause 2'],
    ...overrides,
  };
}

describe('deviationExplanationSchema', () => {
  it('accepts a minimal valid { summary, possibleCauses } object', () => {
    expect(deviationExplanationSchema.safeParse(buildContent()).success).toBe(true);
  });

  it('rejects an empty-string "summary"', () => {
    expect(deviationExplanationSchema.safeParse(buildContent({ summary: '' })).success).toBe(false);
  });

  it('rejects a "summary" longer than 2000 characters', () => {
    expect(
      deviationExplanationSchema.safeParse(buildContent({ summary: 'x'.repeat(2001) })).success,
    ).toBe(false);
  });

  it('accepts a "summary" of exactly 2000 characters', () => {
    expect(
      deviationExplanationSchema.safeParse(buildContent({ summary: 'x'.repeat(2000) })).success,
    ).toBe(true);
  });

  it('rejects an empty "possibleCauses" array (min 1)', () => {
    expect(deviationExplanationSchema.safeParse(buildContent({ possibleCauses: [] })).success).toBe(
      false,
    );
  });

  it('accepts "possibleCauses" with exactly 5 entries (max 5)', () => {
    expect(
      deviationExplanationSchema.safeParse(
        buildContent({ possibleCauses: ['a', 'b', 'c', 'd', 'e'] }),
      ).success,
    ).toBe(true);
  });

  it('rejects "possibleCauses" with 6 entries (over max 5)', () => {
    expect(
      deviationExplanationSchema.safeParse(
        buildContent({ possibleCauses: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      ).success,
    ).toBe(false);
  });

  it('rejects a "possibleCauses" entry that is an empty string', () => {
    expect(
      deviationExplanationSchema.safeParse(buildContent({ possibleCauses: [''] })).success,
    ).toBe(false);
  });

  it('rejects a "possibleCauses" entry longer than 500 characters', () => {
    expect(
      deviationExplanationSchema.safeParse(buildContent({ possibleCauses: ['x'.repeat(501)] }))
        .success,
    ).toBe(false);
  });

  it('accepts a "possibleCauses" entry of exactly 500 characters', () => {
    expect(
      deviationExplanationSchema.safeParse(buildContent({ possibleCauses: ['x'.repeat(500)] }))
        .success,
    ).toBe(true);
  });

  it('rejects a payload with an unknown extra top-level key (.strict())', () => {
    expect(deviationExplanationSchema.safeParse(buildContent({ extra: 'nope' })).success).toBe(
      false,
    );
  });
});
