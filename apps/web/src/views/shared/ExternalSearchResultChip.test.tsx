import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ExternalSearchResultChip as ExternalSearchResultChipModuleExport } from './ExternalSearchResultChip.js';

/**
 * F2-T11 (RED step), ADR-0027 §f — TDD red step. Contract under test (not yet
 * implemented — implementer must create
 * apps/web/src/views/shared/ExternalSearchResultChip.tsx):
 *
 *   export interface ExternalSearchResultChipProps {
 *     result: { connectorType: string; title: string; snippet: string };
 *   }
 *   export function ExternalSearchResultChip(props: ExternalSearchResultChipProps): React.JSX.Element;
 *
 * Mirrors `../calendar/ExternalEventChip.tsx`'s exact read-only precedent
 * (Card + neutral Badge, `data-testid="external-search-result-chip"` per
 * ADR-0027 §f) — a `Card` containing a `Badge` labeled with the raw
 * `connectorType` string (ADR-0027 §f: "Badge metni: connectorType" — no
 * Turkish display-name mapping was committed to, so this test pins the literal
 * connectorType value, not an invented label), plus the result's `title`/
 * `snippet` text. Deliberately NO interactive element/handler — dış sonuçları
 * LuminaOS nesnelerine dönüştürme kapsam dışı (ADR-0027 §f rationale), so
 * unlike a normal command-palette result row this component must never expose
 * a clickable affordance at all.
 *
 * `./ExternalSearchResultChip.ts(x)` does not exist yet, so a bare `import {
 * ExternalSearchResultChip } from './ExternalSearchResultChip.js'` binding
 * would otherwise type as `any`, cascading `@typescript-eslint/no-unsafe-*`
 * errors through every JSX call site below -- same lint-avoidance technique as
 * `../../../server/src/integrations/connector-health.test.ts`'s
 * `ModuleExport as unknown as Constructor` pattern, applied here to a function
 * component instead of a class. The props shape is re-declared locally
 * (ADR-0027 §a/§f's exact pinned shape) rather than type-imported from the
 * not-yet-existing module, for the same reason.
 */

interface ExternalSearchResultChipProps {
  result: {
    connectorType: string;
    title: string;
    snippet: string;
  };
}

// cast-around-a-not-yet-existing-module pattern above is intentional (see file
// header comment); now that the real component's types happen to match this
// locally re-declared interface exactly, TS sees the double-cast as a no-op,
// but the cast must stay for this file to keep compiling once the module
// existed before this component did.
const ExternalSearchResultChip = ExternalSearchResultChipModuleExport;

function makeResult(
  overrides: Partial<ExternalSearchResultChipProps['result']> = {},
): ExternalSearchResultChipProps['result'] {
  return {
    connectorType: 'notion',
    title: 'Quarterly Roadmap Page',
    snippet: 'A snippet of the external page content goes here.',
    ...overrides,
  };
}

describe('ExternalSearchResultChip', () => {
  it('renders data-testid="external-search-result-chip" containing the title and snippet text', () => {
    render(
      <ExternalSearchResultChip
        result={makeResult({
          title: 'Notion Roadmap Page',
          snippet: 'This quarter we are focusing on...',
        })}
      />,
    );

    const chip = screen.getByTestId('external-search-result-chip');
    expect(chip).toHaveTextContent('Notion Roadmap Page');
    expect(chip).toHaveTextContent('This quarter we are focusing on...');
  });

  it('labels the Badge with the raw connectorType value (no invented display-name mapping)', () => {
    render(<ExternalSearchResultChip result={makeResult({ connectorType: 'github' })} />);

    const chip = screen.getByTestId('external-search-result-chip');
    expect(chip).toHaveTextContent('github');
  });

  it('is read-only — exposes no clickable/interactive element (no button role, no onClick reachable via a11y queries)', () => {
    const handleDocumentClick = vi.fn();
    document.addEventListener('click', handleDocumentClick);

    render(<ExternalSearchResultChip result={makeResult()} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    const chip = screen.getByTestId('external-search-result-chip');
    expect(chip).not.toHaveAttribute('role', 'option');
    expect(chip).not.toHaveAttribute('aria-selected');
    expect(chip.tabIndex).toBeLessThanOrEqual(0);

    document.removeEventListener('click', handleDocumentClick);
  });
});
