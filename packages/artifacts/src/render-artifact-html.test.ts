import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { renderArtifactHtml } from './render-artifact-html.js';

import type { ArtifactContent, ArtifactSection } from './artifact-content.js';
import type { ArtifactType } from './artifact-type.js';
import type { ThemePresetName } from './theme-preset.js';

/**
 * F3-T7 PR1 (RED step), ADR-0041 Karar (c)/(d) — the PR's security-critical
 * deliverable, `packages/artifacts/src/render-artifact-html.ts`.
 *
 *   function escapeHtml(value: string): string; // NOT exported, tested
 *     // indirectly via renderArtifactHtml's own output (the real,
 *     // user-facing guarantee -- ADR-0041 Karar c/d).
 *   function renderSection(section: ArtifactSection): string; // NOT exported
 *   export function renderArtifactHtml(
 *     content: ArtifactContent,
 *     theme: ThemePresetName,
 *     artifactType: ArtifactType,
 *   ): string;
 *
 * v0 emits ZERO <script> tags -- every artifactType renders a fully static
 * document. Expected to fail (red) until `implementer` adds
 * `packages/artifacts/src/render-artifact-html.ts` (and its dependencies
 * `theme-preset.ts`/`artifact-content.ts`/`artifact-type.ts`) — none of these
 * modules exist yet, so these imports fail with "Cannot find module".
 */

// Mirrors ADR-0041's own `escapeHtml` replacement table exactly (Karar c) --
// used ONLY to build expected values in this test file, never imported from
// the (not-yet-existing) implementation.
function escapeHtmlForTest(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildContent(sections: ArtifactSection[], title = 'Rapor Başlığı'): ArtifactContent {
  return { title, sections };
}

const KURUMSAL_STYLE_BLOCK =
  '<style>:root { --artifact-bg: #ffffff; --artifact-fg: #1f2937; --artifact-accent: #1d4ed8; --artifact-font: Georgia, serif; } body { background: var(--artifact-bg); color: var(--artifact-fg); font-family: var(--artifact-font); } h1,h2,h3 { color: var(--artifact-accent); } table { border-collapse: collapse; } th,td { border: 1px solid var(--artifact-fg); padding: 4px 8px; } .artifact-image-placeholder { border: 1px dashed var(--artifact-fg); padding: 24px; text-align: center; }</style>';

const KURUMSAL_STYLE_BLOCK_PRESENTATION =
  '<style>:root { --artifact-bg: #ffffff; --artifact-fg: #1f2937; --artifact-accent: #1d4ed8; --artifact-font: Georgia, serif; } body { background: var(--artifact-bg); color: var(--artifact-fg); font-family: var(--artifact-font); } h1,h2,h3 { color: var(--artifact-accent); } table { border-collapse: collapse; } th,td { border: 1px solid var(--artifact-fg); padding: 4px 8px; } .artifact-image-placeholder { border: 1px dashed var(--artifact-fg); padding: 24px; text-align: center; } section.artifact-section { min-height: 90vh; page-break-after: always; }</style>';

const THEME: ThemePresetName = 'kurumsal';
const NON_PRESENTATION_TYPE: ArtifactType = 'page';

describe('renderArtifactHtml — per-section-kind rendering (exact fragment match)', () => {
  it('renders a "heading" section with no explicit level as <h2>...</h2>', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'heading', text: 'Bölüm Başlığı' }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<h2>Bölüm Başlığı</h2>');
  });

  it('renders a "heading" section with level:1 as <h1>...</h1>', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'heading', text: 'Ana Başlık', level: 1 }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<h1>Ana Başlık</h1>');
  });

  it('renders a "heading" section with level:2 as <h2>...</h2>', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'heading', text: 'Alt Başlık', level: 2 }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<h2>Alt Başlık</h2>');
  });

  it('renders a "heading" section with level:3 as <h3>...</h3>', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'heading', text: 'Küçük Başlık', level: 3 }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<h3>Küçük Başlık</h3>');
  });

  it('renders a "paragraph" section as <p>...</p>', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'Gövde metni burada.' }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<p>Gövde metni burada.</p>');
  });

  it('renders a "list" section with multiple items as <ul><li>...</li>...</ul>', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'list', items: ['Birinci', 'İkinci', 'Üçüncü'] }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<ul><li>Birinci</li><li>İkinci</li><li>Üçüncü</li></ul>');
  });

  it('renders a "table" section with headers+rows as the exact nested <table> structure', () => {
    const html = renderArtifactHtml(
      buildContent([
        {
          kind: 'table',
          headers: ['Ad', 'Değer'],
          rows: [
            ['A', '1'],
            ['B', '2'],
          ],
        },
      ]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain(
      '<table><tr><th>Ad</th><th>Değer</th></tr><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></table>',
    );
  });

  it('renders an "imagePlaceholder" section WITH a caption as the labeled placeholder div', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'imagePlaceholder', caption: 'Satış Grafiği' }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<div class="artifact-image-placeholder">Satış Grafiği</div>');
  });

  it('renders an "imagePlaceholder" section WITHOUT a caption using the default "Görsel" label', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'imagePlaceholder' }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain('<div class="artifact-image-placeholder">Görsel</div>');
  });
});

describe('renderArtifactHtml — theme CSS variables in the <style> block', () => {
  it('embeds the "kurumsal" preset\'s 4 CSS variables verbatim in the :root block', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'x' }]),
      'kurumsal',
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain(
      ':root { --artifact-bg: #ffffff; --artifact-fg: #1f2937; --artifact-accent: #1d4ed8; --artifact-font: Georgia, serif; }',
    );
  });
});

describe('renderArtifactHtml — artifactType controls the page-break-after CSS rule', () => {
  it('adds the "section.artifact-section { ... page-break-after: always; }" rule when artifactType is "presentation"', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'x' }]),
      'kurumsal',
      'presentation',
    );

    expect(html).toContain('page-break-after: always');
  });

  it('does NOT add the page-break-after rule when artifactType is "page" (non-presentation)', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'x' }]),
      'kurumsal',
      'page',
    );

    expect(html).not.toContain('page-break-after');
  });

  it.each(['dashboard', 'report'] as const)(
    'does NOT add the page-break-after rule when artifactType is "%s"',
    (artifactType) => {
      const html = renderArtifactHtml(
        buildContent([{ kind: 'paragraph', text: 'x' }]),
        'kurumsal',
        artifactType,
      );

      expect(html).not.toContain('page-break-after');
    },
  );
});

describe('renderArtifactHtml — overall document structure', () => {
  it('produces the EXACT full document for a minimal single-paragraph "page" artifact (kurumsal theme)', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'Merhaba' }], 'Rapor'),
      'kurumsal',
      'page',
    );

    const expected =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<title>Rapor</title>' +
      KURUMSAL_STYLE_BLOCK +
      '</head><body>' +
      '<h1>Rapor</h1>' +
      '<p>Merhaba</p>' +
      '</body></html>';

    expect(html).toBe(expected);
  });

  it('produces the EXACT full document for a minimal single-paragraph "presentation" artifact (kurumsal theme, page-break CSS included)', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'Merhaba' }], 'Rapor'),
      'kurumsal',
      'presentation',
    );

    const expected =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<title>Rapor</title>' +
      KURUMSAL_STYLE_BLOCK_PRESENTATION +
      '</head><body>' +
      '<h1>Rapor</h1>' +
      '<p>Merhaba</p>' +
      '</body></html>';

    expect(html).toBe(expected);
  });

  it('starts with "<!DOCTYPE html><html>"', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'x' }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html.startsWith('<!DOCTYPE html><html>')).toBe(true);
  });

  it('has a <title> matching content.title, HTML-escaped', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'x' }], 'Başlık & <Test>'),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain(`<title>${escapeHtmlForTest('Başlık & <Test>')}</title>`);
  });

  it('ends with "</body></html>"', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'x' }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html.endsWith('</body></html>')).toBe(true);
  });
});

describe('renderArtifactHtml — security: each of the 5 escaped characters, individually', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes a lone "%s" to "%s"', (raw, escaped) => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: `zzz${raw}zzz` }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).toContain(`zzz${escaped}zzz`);
    expect(html).not.toContain(`zzz${raw}zzz`);
  });
});

describe('renderArtifactHtml — security: <script> injection at every interpolation point (ADR-0041 Karar c/d)', () => {
  const PAYLOAD = '<script>alert(1)</script>';
  const ESCAPED_PAYLOAD = escapeHtmlForTest(PAYLOAD);

  it('escapes a <script> payload in a "heading" section\'s text', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'heading', text: PAYLOAD }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain(ESCAPED_PAYLOAD);
  });

  it('escapes a <script> payload in a "paragraph" section\'s text', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: PAYLOAD }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain(ESCAPED_PAYLOAD);
  });

  it('escapes a <script> payload inside a "list" section\'s items', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'list', items: ['safe item', PAYLOAD] }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain(ESCAPED_PAYLOAD);
  });

  it('escapes a <script> payload inside a "table" section\'s headers', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'table', headers: [PAYLOAD], rows: [['x']] }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain(ESCAPED_PAYLOAD);
  });

  it('escapes a <script> payload inside a "table" section\'s row cells', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'table', headers: ['h'], rows: [[PAYLOAD]] }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain(ESCAPED_PAYLOAD);
  });

  it('escapes a <script> payload in an "imagePlaceholder" section\'s caption', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'imagePlaceholder', caption: PAYLOAD }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain(ESCAPED_PAYLOAD);
  });

  it('escapes a <script> payload in the top-level content.title (appears in both <title> and <h1>)', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'paragraph', text: 'x' }], PAYLOAD),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain(`<title>${ESCAPED_PAYLOAD}</title>`);
    expect(html).toContain(`<h1>${ESCAPED_PAYLOAD}</h1>`);
  });

  it('the overall document never contains ANY literal, unescaped <script> substring, no matter the payload location', () => {
    const html = renderArtifactHtml(
      buildContent(
        [
          { kind: 'heading', text: PAYLOAD },
          { kind: 'table', headers: [PAYLOAD], rows: [[PAYLOAD]] },
          { kind: 'imagePlaceholder', caption: PAYLOAD },
        ],
        PAYLOAD,
      ),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('renderArtifactHtml — security: attribute-injection attempt via caption', () => {
  const ATTRIBUTE_INJECTION_PAYLOAD = '"><img src=x onerror=alert(1)>';

  it('neutralizes a quote-breakout + onerror handler injection attempt, leaving no live onerror= handler', () => {
    const html = renderArtifactHtml(
      buildContent([{ kind: 'imagePlaceholder', caption: ATTRIBUTE_INJECTION_PAYLOAD }]),
      THEME,
      NON_PRESENTATION_TYPE,
    );

    expect(html).not.toContain(ATTRIBUTE_INJECTION_PAYLOAD);
    expect(html).not.toMatch(/<img[^>]*onerror=/);
    expect(html).toContain(escapeHtmlForTest(ATTRIBUTE_INJECTION_PAYLOAD));
  });
});

describe('renderArtifactHtml — security: fails closed on an invalid theme instead of a raw TypeError', () => {
  it('throws ValidationError when theme is not a recognized THEME_PRESETS key (e.g. a caller that bypassed the ThemePresetName type)', () => {
    const invalidTheme = 'not-a-real-preset' as ThemePresetName;

    expect(() => renderArtifactHtml(buildContent([]), invalidTheme, NON_PRESENTATION_TYPE)).toThrow(
      ValidationError,
    );
  });
});

describe('renderArtifactHtml — security: a heading section.level that bypasses the 1|2|3 type never reaches the tag name unescaped', () => {
  it('falls back to <h2> for an out-of-range/injected level value instead of interpolating it raw into the tag name', () => {
    // Simulates a caller that skipped `artifactContentSchema` validation (e.g.
    // an `as ArtifactContent` cast, or reading `.data` off a `safeParse`
    // without checking `.success`) and handed in a `level` that is not
    // actually 1|2|3 at runtime.
    const maliciousSection = {
      kind: 'heading',
      text: 'Başlık',
      level: '1 onmouseover=alert(document.cookie)',
    } as unknown as ArtifactSection;

    const html = renderArtifactHtml(buildContent([maliciousSection]), THEME, NON_PRESENTATION_TYPE);

    expect(html).not.toContain('onmouseover');
    expect(html).toContain('<h2>Başlık</h2>');
  });
});
