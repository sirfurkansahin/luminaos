import { describe, expect, it } from 'vitest';

import { parseImportInput } from './parseImportInput.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/lib/parseImportInput.ts to satisfy these tests. That's the
 * expected TDD red state.):
 *
 *   export function parseImportInput(raw: string): string[];
 *
 * Per ADR-0023 §(a) (docs/adr/ADR-0023-ice-disa-aktarim-json-ld.md), tries
 * three input shapes IN ORDER, returning as soon as one matches:
 *
 *   1. `raw` is valid JSON and parses to an array where EVERY element is an
 *      object carrying a `schema:text` string field (LuminaOS's own
 *      JSON-LD export round-trip shape, per the ADR's prose) -> returns the
 *      array of `schema:text` values, in order.
 *   2. `raw` is valid JSON and parses to an array where EVERY element is an
 *      object carrying a `content` string field (`{content: string}[]`,
 *      generic/format-agnostic "external" shape) -> returns the array of
 *      `content` values, in order.
 *   3. Otherwise (invalid JSON, JSON that isn't an array, or a JSON array
 *      that doesn't uniformly match shape 1 or 2): treat `raw` as plain
 *      text — split on newlines, trim each line, drop empty lines.
 *
 * *** Discrepancy flagged for implementer/orchestrator — see this
 * subagent's final report for the full write-up and recommendation ***
 *
 * ADR-0023 §(a) labels shape 1 (elements with a `schema:text` field) as
 * "LuminaOS's OWN JSON-LD export shape" — i.e. the round-trip case where a
 * user re-imports a file they just fetched from
 * `GET .../memory/export?format=json-ld`. But
 * `packages/memory/src/memory-record-json-ld.ts`'s ACTUAL
 * `toMemoryRecordJsonLd()` emits objects with a LITERAL `content: string`
 * key — `MEMORY_RECORD_JSON_LD_CONTEXT` maps the SEMANTIC term `content` to
 * the compact IRI string `'schema:text'`, but no emitted object property is
 * ever literally NAMED `schema:text`. A real LuminaOS export fed back into
 * `parseImportInput` therefore never matches shape 1 as literally
 * described (checking for a `schema:text` key) — it matches shape 2
 * instead, since every element already carries a `content` key, producing
 * the SAME correct result but via the "generic external" branch rather
 * than the "own round-trip" branch the ADR names it after.
 *
 * This suite pins shape 1's check to the LITERAL key `'schema:text'`, per
 * ADR-0023's prose verbatim, and separately verifies that a real
 * `MemoryRecordJsonLd[]`-shaped export fixture round-trips correctly via
 * shape 2 instead. Under this interpretation shapes 1 and 2 are
 * functionally redundant for every real LuminaOS export produced today;
 * shape 1 only has a distinct effect for a hypothetical/foreign JSON-LD
 * producer that emits literal `schema:text` keys (e.g. a fully-expanded
 * JSON-LD serialization). This is a doc-vs-code inconsistency to
 * reconcile, not a new product-behavior ambiguity requiring a fresh human
 * decision.
 */

describe('parseImportInput', () => {
  it('returns [] for an empty string', () => {
    expect(parseImportInput('')).toEqual([]);
  });

  it('returns [] for a whitespace-only string', () => {
    expect(parseImportInput('   \n\n  \t \n')).toEqual([]);
  });

  it('returns [] for an empty JSON array (shape 1/2 checks are vacuously true, both yield [])', () => {
    expect(parseImportInput('[]')).toEqual([]);
  });

  describe('shape 1 — JSON array of objects with a literal "schema:text" key', () => {
    it('extracts the schema:text value from each element, in order', () => {
      const raw = JSON.stringify([
        { 'schema:text': 'Birinci not' },
        { 'schema:text': 'İkinci not' },
      ]);

      expect(parseImportInput(raw)).toEqual(['Birinci not', 'İkinci not']);
    });

    it('ignores extra fields on each element beyond schema:text', () => {
      const raw = JSON.stringify([
        { '@type': 'schema:Note', '@id': 'urn:x:1', 'schema:text': 'Not içeriği' },
      ]);

      expect(parseImportInput(raw)).toEqual(['Not içeriği']);
    });

    it('is tried before shape 2 — an element with BOTH schema:text and content uses schema:text', () => {
      const raw = JSON.stringify([{ 'schema:text': 'Doğru değer', content: 'Yanlış değer' }]);

      expect(parseImportInput(raw)).toEqual(['Doğru değer']);
    });
  });

  describe('shape 2 — JSON array of objects with a literal "content" key', () => {
    it('extracts the content value from each element, in order', () => {
      const raw = JSON.stringify([{ content: 'Birinci' }, { content: 'İkinci' }]);

      expect(parseImportInput(raw)).toEqual(['Birinci', 'İkinci']);
    });

    it('ignores extra fields on each element beyond content', () => {
      const raw = JSON.stringify([{ id: 'x-1', content: 'Sadece içerik önemli' }]);

      expect(parseImportInput(raw)).toEqual(['Sadece içerik önemli']);
    });

    it('round-trips a REAL MemoryRecordJsonLd[]-shaped export fixture via THIS shape — see the discrepancy note above: real exports carry a literal "content" key, never a literal "schema:text" key', () => {
      const exported = [
        {
          '@context': {
            schema: 'https://schema.org/',
            luminaos: 'https://luminaos.dev/vocab#',
            content: 'schema:text',
            createdAt: 'schema:dateCreated',
            updatedAt: 'schema:dateModified',
            kaynakOlayId: 'luminaos:kaynakOlayId',
          },
          '@type': 'schema:Note',
          '@id': 'urn:luminaos:memory-record:mem-1',
          content: 'Kahve yerine çay tercih ederim.',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          kaynakOlayId: 'evt-1',
        },
      ];

      expect(parseImportInput(JSON.stringify(exported))).toEqual([
        'Kahve yerine çay tercih ederim.',
      ]);
    });
  });

  describe('shape 3 — plain text fallback', () => {
    it('splits on newlines, trims each line, and drops empty lines', () => {
      const raw = '  Birinci satır  \n\nİkinci satır\n   \nÜçüncü satır';

      expect(parseImportInput(raw)).toEqual(['Birinci satır', 'İkinci satır', 'Üçüncü satır']);
    });

    it('drops multiple consecutive blank/whitespace-only lines', () => {
      const raw = 'A\n\n\n   \n\nB';

      expect(parseImportInput(raw)).toEqual(['A', 'B']);
    });

    it('applies verbatim to a string that is not valid JSON at all', () => {
      const raw = 'bu geçerli bir JSON değil {{{';

      expect(parseImportInput(raw)).toEqual(['bu geçerli bir JSON değil {{{']);
    });

    it('applies to a JSON array whose elements are plain strings, not objects (does not match shape 1 or 2 — only object-with-specific-field arrays match those)', () => {
      const raw = JSON.stringify(['Birinci', 'İkinci']);

      // JSON.stringify of a flat array produces a single line of text — shape
      // 3 treats the WHOLE raw string as one line, it does NOT re-interpret
      // the JSON array elements as separate items.
      expect(parseImportInput(raw)).toEqual([raw]);
    });

    it('applies to a JSON array of objects that have NEITHER schema:text NOR content (falls through, does not invent a fourth shape)', () => {
      const raw = JSON.stringify([{ foo: 'bar' }, { baz: 'qux' }]);

      expect(parseImportInput(raw)).toEqual([raw]);
    });

    it('applies to valid JSON that is not an array at all (e.g. a bare object)', () => {
      const raw = JSON.stringify({ content: 'tek bir kayıt, dizi değil' });

      expect(parseImportInput(raw)).toEqual([raw]);
    });

    it('a pretty-printed (multi-line), non-matching JSON array degrades to one entry per RAW line, not one entry per array element', () => {
      const raw = JSON.stringify([{ foo: 'bar' }, { baz: 'qux' }], null, 2);

      const expectedLines = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      expect(parseImportInput(raw)).toEqual(expectedLines);
      // Sanity: this is genuinely a multi-line degenerate result, not
      // accidentally identical to the single-line case above.
      expect(expectedLines.length).toBeGreaterThan(1);
    });
  });

  describe('mixed-shape arrays (not every element matches the same shape)', () => {
    it('falls through to shape 3 when only SOME elements have schema:text (not homogeneous)', () => {
      const raw = JSON.stringify([{ 'schema:text': 'Var' }, { content: 'Yok' }]);

      expect(parseImportInput(raw)).toEqual([raw]);
    });

    it('falls through to shape 3 when only SOME elements have content (not homogeneous)', () => {
      const raw = JSON.stringify([{ content: 'Var' }, { foo: 'bar' }]);

      expect(parseImportInput(raw)).toEqual([raw]);
    });
  });
});
