import { describe, expect, it } from 'vitest';

import { artifactContentSchema } from './artifact-content.js';
import {
  buildQueryResultTableSection,
  MAX_WIDGET_CELL_LENGTH,
  MAX_WIDGET_TABLE_ROWS,
} from './build-query-result-table-section.js';
import { renderArtifactHtml } from './render-artifact-html.js';

import type { ArtifactContent } from './artifact-content.js';

/**
 * F3-T8 PR1 (RED step), ADR-0042 Karar (h) —
 * `packages/artifacts/src/build-query-result-table-section.ts`.
 *
 *   export const MAX_WIDGET_TABLE_ROWS = 25;
 *   export const MAX_WIDGET_CELL_LENGTH = 500;
 *   export function buildQueryResultTableSection(
 *     rows: { title: string; fieldValues: Record<string, unknown> }[],
 *     columns: string[],
 *   ): ArtifactSection; // {kind:'table', headers: columns, rows: string[][]}
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/build-query-result-table-section.ts` — this module
 * does not exist yet at all, so this import fails with "Cannot find module".
 *
 * `artifact-content.ts`/`render-artifact-html.ts` ALREADY EXIST (merged as
 * part of F3-T7) — they are imported here REAL/un-mocked, both to build a
 * realistic `ArtifactContent` fixture and to prove PR1's core security
 * property (escaping) end-to-end, not just in isolation.
 */

interface QueryResultRow {
  title: string;
  fieldValues: Record<string, unknown>;
}

function buildRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    title: 'Örnek Satır',
    fieldValues: {},
    ...overrides,
  };
}

// Mirrors render-artifact-html.ts's own escapeHtml replacement table exactly
// -- used ONLY to build expected values in this test file, never imported
// from the implementation.
function escapeHtmlForTest(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

describe('MAX_WIDGET_TABLE_ROWS / MAX_WIDGET_CELL_LENGTH constants', () => {
  it('MAX_WIDGET_TABLE_ROWS is exactly 25 (ADR-0042 Karar h)', () => {
    expect(MAX_WIDGET_TABLE_ROWS).toBe(25);
  });

  it("MAX_WIDGET_CELL_LENGTH is exactly 500 (ADR-0042 Karar h, consistent with artifactSectionSchema's table.rows cell cap)", () => {
    expect(MAX_WIDGET_CELL_LENGTH).toBe(500);
  });
});

describe('buildQueryResultTableSection — headers', () => {
  it('sets "headers" to exactly the "columns" array passed in, verbatim', () => {
    const columns = ['title', 'status', 'assignee'];
    const section = buildQueryResultTableSection([buildRow()], columns);

    expect(section.headers).toEqual(columns);
  });

  it('sets "kind" to "table"', () => {
    const section = buildQueryResultTableSection([buildRow()], ['title']);

    expect(section.kind).toBe('table');
  });
});

describe('buildQueryResultTableSection — row-count truncation', () => {
  it('truncates rows to exactly MAX_WIDGET_TABLE_ROWS (25) when more than 25 rows are passed in, keeping the FIRST 25', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      buildRow({ title: `Satır ${String(i + 1)}` }),
    );

    const section = buildQueryResultTableSection(rows, ['title']);

    expect(section.rows).toHaveLength(MAX_WIDGET_TABLE_ROWS);
    expect(section.rows).toEqual(Array.from({ length: 25 }, (_, i) => [`Satır ${String(i + 1)}`]));
  });

  it('does not truncate when exactly MAX_WIDGET_TABLE_ROWS (25) rows are passed in', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      buildRow({ title: `Satır ${String(i + 1)}` }),
    );

    const section = buildQueryResultTableSection(rows, ['title']);

    expect(section.rows).toHaveLength(25);
  });

  it('does not truncate when fewer than MAX_WIDGET_TABLE_ROWS rows are passed in', () => {
    const rows = Array.from({ length: 3 }, (_, i) => buildRow({ title: `Satır ${String(i + 1)}` }));

    const section = buildQueryResultTableSection(rows, ['title']);

    expect(section.rows).toHaveLength(3);
  });
});

describe('buildQueryResultTableSection — "title" column special-case', () => {
  it('reads the "title" column from row.title, NOT row.fieldValues.title, for every row', () => {
    const rows = [
      { title: 'Gerçek Başlık', fieldValues: { title: 'YANLIŞ Başlık (fieldValues içinde)' } },
    ];

    const section = buildQueryResultTableSection(rows, ['title']);

    expect(section.rows?.[0]).toEqual(['Gerçek Başlık']);
  });
});

describe('buildQueryResultTableSection — non-"title" columns read from row.fieldValues', () => {
  it('reads a non-"title" column value from row.fieldValues[columnKey]', () => {
    const rows = [buildRow({ fieldValues: { status: 'Devam Ediyor', assignee: 'Ayşe' } })];

    const section = buildQueryResultTableSection(rows, ['title', 'status', 'assignee']);

    expect(section.rows?.[0]).toEqual(['Örnek Satır', 'Devam Ediyor', 'Ayşe']);
  });
});

describe('buildQueryResultTableSection — cell-value stringification', () => {
  it('stringifies null to an empty string', () => {
    const rows = [buildRow({ fieldValues: { status: null } })];

    const section = buildQueryResultTableSection(rows, ['title', 'status']);

    expect(section.rows?.[0]?.[1]).toBe('');
  });

  it('stringifies undefined to an empty string', () => {
    const rows = [buildRow({ fieldValues: { status: undefined } })];

    const section = buildQueryResultTableSection(rows, ['title', 'status']);

    expect(section.rows?.[0]?.[1]).toBe('');
  });

  it('stringifies a missing field key (not present in fieldValues at all) to an empty string', () => {
    const rows = [buildRow({ fieldValues: {} })];

    const section = buildQueryResultTableSection(rows, ['title', 'status']);

    expect(section.rows?.[0]?.[1]).toBe('');
  });

  it('truncates a plain string longer than MAX_WIDGET_CELL_LENGTH to exactly that length', () => {
    const longString = 'x'.repeat(MAX_WIDGET_CELL_LENGTH + 50);
    const rows = [buildRow({ fieldValues: { status: longString } })];

    const section = buildQueryResultTableSection(rows, ['title', 'status']);

    expect(section.rows?.[0]?.[1]).toHaveLength(MAX_WIDGET_CELL_LENGTH);
    expect(section.rows?.[0]?.[1]).toBe(longString.slice(0, MAX_WIDGET_CELL_LENGTH));
  });

  it('does not truncate a plain string of exactly MAX_WIDGET_CELL_LENGTH', () => {
    const exactString = 'y'.repeat(MAX_WIDGET_CELL_LENGTH);
    const rows = [buildRow({ fieldValues: { status: exactString } })];

    const section = buildQueryResultTableSection(rows, ['title', 'status']);

    expect(section.rows?.[0]?.[1]).toBe(exactString);
  });

  it('joins an array value (simulating a people/multiSelect field) with ", " before truncation', () => {
    const rows = [buildRow({ fieldValues: { people: ['Ayşe', 'Mehmet', 'Ali'] } })];

    const section = buildQueryResultTableSection(rows, ['title', 'people']);

    expect(section.rows?.[0]?.[1]).toBe('Ayşe, Mehmet, Ali');
  });

  it('truncates a joined array value to MAX_WIDGET_CELL_LENGTH when the joined string exceeds it', () => {
    const manyNames = Array.from({ length: 200 }, (_, i) => `Kişi${String(i)}`);
    const rows = [buildRow({ fieldValues: { people: manyNames } })];

    const section = buildQueryResultTableSection(rows, ['title', 'people']);
    const expectedJoined = manyNames.join(', ').slice(0, MAX_WIDGET_CELL_LENGTH);

    expect(section.rows?.[0]?.[1]).toHaveLength(MAX_WIDGET_CELL_LENGTH);
    expect(section.rows?.[0]?.[1]).toBe(expectedJoined);
  });

  it('coerces a number value via String() then truncates, without throwing', () => {
    const rows = [buildRow({ fieldValues: { amount: 4200 } })];

    expect(() => buildQueryResultTableSection(rows, ['title', 'amount'])).not.toThrow();
    const section = buildQueryResultTableSection(rows, ['title', 'amount']);
    expect(section.rows?.[0]?.[1]).toBe('4200');
  });

  it('coerces a boolean value via String() then truncates, without throwing', () => {
    const rows = [buildRow({ fieldValues: { done: true } })];

    expect(() => buildQueryResultTableSection(rows, ['title', 'done'])).not.toThrow();
    const section = buildQueryResultTableSection(rows, ['title', 'done']);
    expect(section.rows?.[0]?.[1]).toBe('true');
  });
});

describe('buildQueryResultTableSection — security-critical: adversarial fieldValues survive escaping end-to-end through the REAL renderArtifactHtml', () => {
  const SCRIPT_PAYLOAD = '<script>alert(1)</script>';
  const ATTRIBUTE_INJECTION_PAYLOAD = '"><img src=x onerror=alert(1)>';

  it('renders a <script> payload embedded in a fieldValue as HTML-entity-escaped text, never as a raw <script> tag', () => {
    const rows = [buildRow({ title: 'Satır', fieldValues: { notes: SCRIPT_PAYLOAD } })];
    const columns = ['title', 'notes'];

    const section = buildQueryResultTableSection(rows, columns);
    const content: ArtifactContent = { title: 'Canlı Widget', sections: [section] };
    const html = renderArtifactHtml(content, 'kurumsal', 'dashboard');

    expect(html).not.toContain('<script>');
    expect(html).not.toContain(SCRIPT_PAYLOAD);
    expect(html).toContain(escapeHtmlForTest(SCRIPT_PAYLOAD));
  });

  it('neutralizes a quote-breakout + onerror handler injection attempt embedded in a fieldValue, leaving no live onerror= handler', () => {
    const rows = [
      buildRow({ title: 'Satır', fieldValues: { notes: ATTRIBUTE_INJECTION_PAYLOAD } }),
    ];
    const columns = ['title', 'notes'];

    const section = buildQueryResultTableSection(rows, columns);
    const content: ArtifactContent = { title: 'Canlı Widget', sections: [section] };
    const html = renderArtifactHtml(content, 'kurumsal', 'dashboard');

    expect(html).not.toContain(ATTRIBUTE_INJECTION_PAYLOAD);
    expect(html).not.toMatch(/<img[^>]*onerror=/);
    expect(html).toContain(escapeHtmlForTest(ATTRIBUTE_INJECTION_PAYLOAD));
  });

  it('escapes an adversarial payload embedded in the "title" column path as well (row.title, not just fieldValues)', () => {
    const rows = [buildRow({ title: SCRIPT_PAYLOAD, fieldValues: {} })];
    const columns = ['title'];

    const section = buildQueryResultTableSection(rows, columns);
    const content: ArtifactContent = { title: 'Canlı Widget', sections: [section] };
    const html = renderArtifactHtml(content, 'kurumsal', 'dashboard');

    expect(html).not.toContain('<script>');
    expect(html).toContain(escapeHtmlForTest(SCRIPT_PAYLOAD));
  });
});

describe('buildQueryResultTableSection — realistic max-column/max-row output round-trips through artifactContentSchema', () => {
  it('produces an ArtifactSection that, embedded in a full ArtifactContent, passes artifactContentSchema.safeParse for a max-column (8) / max-row (25) input', () => {
    const columns = ['title', 'field1', 'field2', 'field3', 'field4', 'field5', 'field6', 'field7'];
    const rows = Array.from({ length: 25 }, (_, i) => ({
      title: `Satır ${String(i + 1)}`,
      fieldValues: {
        field1: 'x'.repeat(MAX_WIDGET_CELL_LENGTH + 100),
        field2: ['a', 'b', 'c'],
        field3: 42,
        field4: true,
        field5: null,
        field6: undefined,
        field7: 'normal değer',
      },
    }));

    const section = buildQueryResultTableSection(rows, columns);
    const result = artifactContentSchema.safeParse({ title: 'x', sections: [section] });

    expect(result.success).toBe(true);
  });
});
