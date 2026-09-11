import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ArtifactViewer as ArtifactViewerModuleExport } from './ArtifactViewer.js';

/**
 * F3-T7 PR3 (artifact boru hattı, ADR-0041 Karar d, spec Kabul Kriterleri)
 * — TDD red step. Contract under test (not yet implemented — implementer
 * must build apps/web/src/views/shared/ArtifactViewer.tsx to satisfy these
 * tests):
 *
 *   export interface ArtifactViewerProps { htmlContent: string; }
 *   export function ArtifactViewer(props: ArtifactViewerProps): React.JSX.Element;
 *
 * Renders a sandboxed `<iframe srcDoc={htmlContent} sandbox="">` per
 * ADR-0041 Karar (d)'s exact code sketch. `htmlContent` is ALREADY
 * fully-escaped, self-contained HTML produced server-side by
 * `renderArtifactHtml` (packages/artifacts) -- this component's ONLY job is
 * to hand it to the iframe via `srcDoc` with an EMPTY `sandbox` attribute
 * (the most restrictive setting available: no scripts, no same-origin, no
 * forms, no top-navigation, no popups, no pointer lock).
 *
 * THE MOST SECURITY-CRITICAL test in this file (and arguably in the whole
 * PR3 slice) is `sandbox` being PRESENT and EXACTLY the empty string -- an
 * ABSENT `sandbox` attribute means NO sandboxing at all, the opposite of
 * ADR-0041 Karar (d)'s intent. `allow-scripts`/`allow-same-origin` must
 * NEVER appear, even individually -- this is asserted as an explicit
 * regression guard against a future edit weakening the hardcoded literal,
 * not because today's implementation is expected to include either token.
 *
 * `./ArtifactViewer.tsx` does not exist yet, so this file is expected to
 * fail to even resolve that import until the component exists -- the
 * documented TDD red state.
 */

const ArtifactViewer = ArtifactViewerModuleExport;

const SAMPLE_HTML =
  '<!DOCTYPE html><html><head><title>Q3 Satış Sunumu</title></head><body><h1>Q3 Satışı</h1><p>Özet metin.</p></body></html>';

describe('ArtifactViewer', () => {
  it('renders exactly one iframe carrying data-testid="artifact-viewer-iframe"', () => {
    const { container } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);

    const iframes = container.querySelectorAll('iframe');
    expect(iframes).toHaveLength(1);
    expect(iframes[0]).toHaveAttribute('data-testid', 'artifact-viewer-iframe');
  });

  it('sets the iframe sandbox attribute to a PRESENT, EXACTLY EMPTY string (never absent, never non-empty)', () => {
    const { container } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    // getAttribute returns null when the attribute is ABSENT -- that would be
    // the opposite of ADR-0041 Karar (d)'s intent (no sandboxing at all).
    expect(iframe?.getAttribute('sandbox')).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('');
  });

  it('NEVER includes an "allow-scripts" token in the sandbox attribute (regression guard)', () => {
    const { container } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);

    const sandboxValue = container.querySelector('iframe')?.getAttribute('sandbox') ?? '';
    expect(sandboxValue.split(/\s+/).filter(Boolean)).not.toContain('allow-scripts');
  });

  it('NEVER includes an "allow-same-origin" token in the sandbox attribute (regression guard)', () => {
    const { container } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);

    const sandboxValue = container.querySelector('iframe')?.getAttribute('sandbox') ?? '';
    expect(sandboxValue.split(/\s+/).filter(Boolean)).not.toContain('allow-same-origin');
  });

  it('passes the exact htmlContent string through as the iframe srcdoc (HTML attribute is lowercase even though the React prop is srcDoc)', () => {
    const { container } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('srcdoc')).toBe(SAMPLE_HTML);
  });

  it('re-renders with an updated srcdoc when htmlContent changes (no stale cached content)', () => {
    const { container, rerender } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);
    const updatedHtml = '<!DOCTYPE html><html><body><h1>Güncellenmiş</h1></body></html>';

    rerender(<ArtifactViewer htmlContent={updatedHtml} />);

    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toBe(updatedHtml);
  });

  it('gives the iframe a non-empty accessible title (no untitled embedded document)', () => {
    const { container } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);

    const title = container.querySelector('iframe')?.getAttribute('title') ?? '';
    expect(title.trim().length).toBeGreaterThan(0);
  });

  it('never uses dangerouslySetInnerHTML as a raw-HTML-injection sink -- the ONLY rendered element is the sandboxed iframe itself', () => {
    const { container } = render(<ArtifactViewer htmlContent={SAMPLE_HTML} />);

    // The component's rendered output should be a single iframe element with
    // no sibling/wrapper elements that could carry a second, unsandboxed
    // raw-HTML sink.
    expect(container.children).toHaveLength(1);
    expect(container.children[0]?.tagName).toBe('IFRAME');
  });
});
