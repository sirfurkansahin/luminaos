import { ValidationError } from '@luminaos/shared';

import { THEME_PRESETS, type ThemePresetName } from './theme-preset.js';

import type { ArtifactContent, ArtifactSection } from './artifact-content.js';
import type { ArtifactType } from './artifact-type.js';

// PURE -- no I/O, no provider call. Every user/LLM-supplied string is escaped
// BEFORE interpolation (Karar c/d's central security guarantee).
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSection(section: ArtifactSection): string {
  switch (section.kind) {
    case 'heading': {
      // Security-review finding (F3-T7 PR1): `level` is interpolated into an
      // actual markup position (the tag NAME), unlike every other field here
      // which only ever reaches TEXT content via `escapeHtml`. `ArtifactSection.
      // level`'s `1|2|3` type is a compile-time-only guarantee -- a caller that
      // bypasses `artifactContentSchema` (e.g. an `as ArtifactContent` cast, or
      // reading `.data` off a `safeParse` without checking `.success`) could
      // otherwise smuggle an arbitrary string into `<h${level}>`. Narrowing
      // explicitly here (never a blind `String(...)` coercion) makes this
      // function safe regardless of what the caller actually validated.
      const level = String(section.level === 1 || section.level === 3 ? section.level : 2);
      return `<h${level}>${escapeHtml(section.text ?? '')}</h${level}>`;
    }
    case 'paragraph':
      return `<p>${escapeHtml(section.text ?? '')}</p>`;
    case 'list':
      return `<ul>${(section.items ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    case 'table': {
      const headerRow = `<tr>${(section.headers ?? []).map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
      const bodyRows = (section.rows ?? [])
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
      return `<table>${headerRow}${bodyRows}</table>`;
    }
    case 'imagePlaceholder':
      return `<div class="artifact-image-placeholder">${escapeHtml(section.caption ?? 'Görsel')}</div>`;
  }
}

/** v0 emits ZERO <script> tags -- every artifactType renders a fully static
 * document (consistent with Karar (f)'s "dashboard is a static snapshot"). */
export function renderArtifactHtml(
  content: ArtifactContent,
  theme: ThemePresetName,
  artifactType: ArtifactType,
): string {
  // Security-review finding (F3-T7 PR1): `ThemePresetName` is a
  // compile-time-only guarantee -- `theme` will eventually originate from a
  // real HTTP request body (PR2), so this lookup must fail closed with a
  // proper `@luminaos/shared` error, never a raw `TypeError` from indexing
  // past the end of `THEME_PRESETS` below. `Object.hasOwn` (rather than an
  // `!preset` truthiness check) is used deliberately so this guard survives
  // even though TS's own closed-union type makes `THEME_PRESETS[theme]`
  // look "always defined" at compile time.
  if (!Object.hasOwn(THEME_PRESETS, theme)) {
    throw new ValidationError(`Unknown theme preset: "${theme}".`);
  }

  const preset = THEME_PRESETS[theme];
  const cssVariables = Object.entries(preset.cssVariables)
    // CSS-injection note: this interpolation is safe ONLY because
    // `preset.cssVariables` always comes from the fixed `THEME_PRESETS`
    // constant above, never from user/LLM input -- if a future "custom
    // theme" feature ever lets a caller supply CSS values here, this
    // `${value}` interpolation must NOT be reused as-is (`escapeHtml` is
    // built for HTML text/attribute contexts, not CSS).
    .map(([key, value]) => `${key}: ${value};`)
    .join(' ');
  const body = content.sections.map(renderSection).join('\n');

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<title>${escapeHtml(content.title)}</title>`,
    `<style>:root { ${cssVariables} } body { background: var(--artifact-bg); color: var(--artifact-fg); font-family: var(--artifact-font); } h1,h2,h3 { color: var(--artifact-accent); } table { border-collapse: collapse; } th,td { border: 1px solid var(--artifact-fg); padding: 4px 8px; } .artifact-image-placeholder { border: 1px dashed var(--artifact-fg); padding: 24px; text-align: center; }${artifactType === 'presentation' ? ' section.artifact-section { min-height: 90vh; page-break-after: always; }' : ''}</style>`,
    '</head><body>',
    `<h1>${escapeHtml(content.title)}</h1>`,
    body,
    '</body></html>',
  ].join('');
}
