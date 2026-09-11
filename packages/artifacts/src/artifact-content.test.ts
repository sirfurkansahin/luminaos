import { describe, expect, it } from 'vitest';

import { artifactContentSchema, artifactSectionSchema } from './artifact-content.js';

/**
 * F3-T7 PR1 (RED step), ADR-0041 Karar (c) — `packages/artifacts/src/artifact-content.ts`.
 *
 *   export interface ArtifactSection {
 *     kind: 'heading' | 'paragraph' | 'list' | 'table' | 'imagePlaceholder';
 *     text?: string; level?: 1 | 2 | 3; items?: string[];
 *     headers?: string[]; rows?: string[][]; caption?: string;
 *   }
 *   export interface ArtifactContent { title: string; sections: ArtifactSection[] }
 *
 *   export const artifactSectionSchema: ZodType<ArtifactSection>; // .strict()
 *     // text: max 2000, items: string[] max 500 chars each, max 50 entries
 *     // headers: string[] max 200 chars each, max 20 entries
 *     // rows: string[][] max 500 chars/cell, max 20 cells/row, max 100 rows
 *     // caption: max 300
 *   export const artifactContentSchema: ZodType<ArtifactContent>; // .strict()
 *     // title: min 1, max 300; sections: min 1, max 100
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/artifact-content.ts` — this module does not exist
 * yet at all, so this import fails with "Cannot find module".
 */

function buildContent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    title: 'Q3 Sonuçları',
    sections: [{ kind: 'heading', text: 'Giriş', level: 1 }],
    ...overrides,
  };
}

describe('artifactSectionSchema', () => {
  it('accepts a minimal valid "heading" section', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'heading', text: 'Başlık', level: 2 }).success,
    ).toBe(true);
  });

  it('accepts a minimal valid "paragraph" section', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'paragraph', text: 'Gövde metni' }).success,
    ).toBe(true);
  });

  it('accepts a minimal valid "list" section', () => {
    expect(artifactSectionSchema.safeParse({ kind: 'list', items: ['Bir', 'İki'] }).success).toBe(
      true,
    );
  });

  it('accepts a minimal valid "table" section', () => {
    expect(
      artifactSectionSchema.safeParse({
        kind: 'table',
        headers: ['Ad', 'Değer'],
        rows: [['A', '1']],
      }).success,
    ).toBe(true);
  });

  it('accepts a minimal valid "imagePlaceholder" section', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'imagePlaceholder', caption: 'Grafik' }).success,
    ).toBe(true);
  });

  it('rejects an unrecognized "kind" value', () => {
    expect(artifactSectionSchema.safeParse({ kind: 'video', text: 'x' }).success).toBe(false);
  });

  it('rejects "text" longer than 2000 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'paragraph', text: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('accepts "text" of exactly 2000 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'paragraph', text: 'x'.repeat(2000) }).success,
    ).toBe(true);
  });

  it('rejects "items" with more than 50 entries', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'list', items: Array(51).fill('x') }).success,
    ).toBe(false);
  });

  it('accepts "items" with exactly 50 entries', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'list', items: Array(50).fill('x') }).success,
    ).toBe(true);
  });

  it('rejects an "items" entry longer than 500 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'list', items: ['x'.repeat(501)] }).success,
    ).toBe(false);
  });

  it('accepts an "items" entry of exactly 500 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'list', items: ['x'.repeat(500)] }).success,
    ).toBe(true);
  });

  it('rejects "headers" with more than 20 entries', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', headers: Array(21).fill('h') }).success,
    ).toBe(false);
  });

  it('accepts "headers" with exactly 20 entries', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', headers: Array(20).fill('h') }).success,
    ).toBe(true);
  });

  it('rejects a "headers" entry longer than 200 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', headers: ['h'.repeat(201)] }).success,
    ).toBe(false);
  });

  it('rejects "rows" with more than 100 entries', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', rows: Array(101).fill(['a']) }).success,
    ).toBe(false);
  });

  it('accepts "rows" with exactly 100 entries', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', rows: Array(100).fill(['a']) }).success,
    ).toBe(true);
  });

  it('rejects a "rows" entry (a single row) with more than 20 cells', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', rows: [Array(21).fill('c')] }).success,
    ).toBe(false);
  });

  it('accepts a "rows" entry (a single row) with exactly 20 cells', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', rows: [Array(20).fill('c')] }).success,
    ).toBe(true);
  });

  it('rejects a "rows" cell longer than 500 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'table', rows: [['x'.repeat(501)]] }).success,
    ).toBe(false);
  });

  it('rejects a "caption" longer than 300 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'imagePlaceholder', caption: 'x'.repeat(301) })
        .success,
    ).toBe(false);
  });

  it('accepts a "caption" of exactly 300 characters', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'imagePlaceholder', caption: 'x'.repeat(300) })
        .success,
    ).toBe(true);
  });

  it('rejects a payload with an unknown extra top-level key (.strict())', () => {
    expect(
      artifactSectionSchema.safeParse({ kind: 'heading', text: 'x', extra: 'nope' }).success,
    ).toBe(false);
  });
});

describe('artifactContentSchema', () => {
  it('accepts a minimal valid ArtifactContent with a "heading" section', () => {
    expect(
      artifactContentSchema.safeParse(
        buildContent({ sections: [{ kind: 'heading', text: 'Başlık', level: 1 }] }),
      ).success,
    ).toBe(true);
  });

  it('accepts a minimal valid ArtifactContent with a "paragraph" section', () => {
    expect(
      artifactContentSchema.safeParse(
        buildContent({ sections: [{ kind: 'paragraph', text: 'Gövde metni' }] }),
      ).success,
    ).toBe(true);
  });

  it('accepts a minimal valid ArtifactContent with a "list" section', () => {
    expect(
      artifactContentSchema.safeParse(
        buildContent({ sections: [{ kind: 'list', items: ['Bir', 'İki'] }] }),
      ).success,
    ).toBe(true);
  });

  it('accepts a minimal valid ArtifactContent with a "table" section', () => {
    expect(
      artifactContentSchema.safeParse(
        buildContent({
          sections: [{ kind: 'table', headers: ['Ad'], rows: [['A']] }],
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts a minimal valid ArtifactContent with an "imagePlaceholder" section', () => {
    expect(
      artifactContentSchema.safeParse(
        buildContent({ sections: [{ kind: 'imagePlaceholder', caption: 'Grafik' }] }),
      ).success,
    ).toBe(true);
  });

  it('rejects an empty "sections" array', () => {
    expect(artifactContentSchema.safeParse(buildContent({ sections: [] })).success).toBe(false);
  });

  it('accepts "sections" with exactly 100 entries', () => {
    expect(
      artifactContentSchema.safeParse(
        buildContent({
          sections: Array(100).fill({ kind: 'paragraph', text: 'x' }),
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects "sections" with more than 100 entries', () => {
    expect(
      artifactContentSchema.safeParse(
        buildContent({
          sections: Array(101).fill({ kind: 'paragraph', text: 'x' }),
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a missing "title"', () => {
    const content = buildContent();
    delete content.title;

    expect(artifactContentSchema.safeParse(content).success).toBe(false);
  });

  it('rejects an empty-string "title"', () => {
    expect(artifactContentSchema.safeParse(buildContent({ title: '' })).success).toBe(false);
  });

  it('rejects a "title" longer than 300 characters', () => {
    expect(artifactContentSchema.safeParse(buildContent({ title: 'x'.repeat(301) })).success).toBe(
      false,
    );
  });

  it('accepts a "title" of exactly 300 characters', () => {
    expect(artifactContentSchema.safeParse(buildContent({ title: 'x'.repeat(300) })).success).toBe(
      true,
    );
  });

  it('rejects a section with an unrecognized "kind" value nested inside sections', () => {
    expect(
      artifactContentSchema.safeParse(buildContent({ sections: [{ kind: 'video', text: 'x' }] }))
        .success,
    ).toBe(false);
  });

  it('rejects a payload with an unknown extra top-level key (.strict())', () => {
    expect(artifactContentSchema.safeParse(buildContent({ extra: 'nope' })).success).toBe(false);
  });
});
