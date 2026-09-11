/**
 * F3-T7 PR3 (artifact boru hattı, ADR-0041 Karar d) -- renders a sandboxed
 * `<iframe srcDoc={htmlContent} sandbox="">`. `htmlContent` is ALREADY
 * fully-escaped, self-contained HTML produced server-side by
 * `renderArtifactHtml` (packages/artifacts) -- this component's ONLY job is
 * to hand it to the iframe via `srcDoc` with an EMPTY `sandbox` attribute
 * (the most restrictive setting available: no scripts, no same-origin, no
 * forms, no top-navigation, no popups, no pointer lock).
 *
 * `sandbox=""` MUST stay a literal empty string, present as an attribute --
 * never `allow-scripts`/`allow-same-origin`, never
 * `dangerouslySetInnerHTML`.
 */
export interface ArtifactViewerProps {
  htmlContent: string;
}

export function ArtifactViewer({ htmlContent }: ArtifactViewerProps) {
  return (
    <iframe
      srcDoc={htmlContent}
      sandbox=""
      data-testid="artifact-viewer-iframe"
      title="Üretilen artifact önizlemesi"
    />
  );
}
