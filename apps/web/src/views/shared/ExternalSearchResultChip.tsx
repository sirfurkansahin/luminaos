import { Badge, Card } from '@luminaos/ui';

// F2-T11 (ADR-0027 §f) — connected search "Dış Kaynaklar" block. Mirrors
// `../calendar/ExternalEventChip.tsx`'s read-only precedent exactly: external
// results are surfaced for display only, never wired into any select/
// navigate flow (turning an external result into a LuminaOS object is
// out of scope per ADR-0027 §f), so this component deliberately does NOT
// accept an onClick/onSelect prop.
export interface ExternalSearchResultChipProps {
  result: {
    connectorType: string;
    title: string;
    snippet: string;
  };
}

export function ExternalSearchResultChip({ result }: ExternalSearchResultChipProps) {
  return (
    <Card data-testid="external-search-result-chip">
      <Badge variant="neutral">{result.connectorType}</Badge>
      <div>{result.title}</div>
      <div>{result.snippet}</div>
    </Card>
  );
}
