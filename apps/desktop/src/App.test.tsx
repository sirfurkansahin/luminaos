import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';

/**
 * Contract for `implementer` (F2-T2b, `apps/desktop/src/App.tsx` not yet
 * built):
 *
 * `App.tsx` must export a named `App` React component that, per ADR-0019
 * Karar (d) ("minimal çalışan uygulama" — a "hello world"-level Tauri app,
 * no real business logic) and Karar (b) (workspace-linking proof), does two
 * things in a single render:
 *
 * 1. Renders a heading discoverable via
 *    `screen.getByRole('heading', { name: 'LuminaOS Desktop' })` — the
 *    "boş pencere açılıp kapanabiliyor" smoke-test surface (spec Kabul
 *    Kriteri "Minimal pencere açılıp kapanabiliyor").
 * 2. Renders a REAL component imported from `@luminaos/ui` (not a local
 *    re-implementation) carrying `data-testid="ui-package-proof"`, proving
 *    the `apps/desktop` → `packages/ui` workspace-linking (ADR-0019 Karar
 *    (b), spec Kabul Kriteri #6). `@luminaos/ui`'s `Button` is a natural
 *    choice — it forwards arbitrary props (including `data-testid`) to a
 *    native `<button>`, so asserting `tagName === 'BUTTON'` confirms this
 *    is genuinely `@luminaos/ui`'s component rendering, not a decoy.
 *
 * Unlike `apps/web/src/App.tsx`, this minimal skeleton is NOT expected to
 * wire `ThemeProvider`/`QueryClientProvider`/data-fetching — ADR-0019 Karar
 * (d) scopes this to "yalnız iskelet, gerçek iş mantığı yok". These tests
 * therefore render `<App />` directly, no provider wrapping required.
 *
 * `apps/desktop/package.json` must declare `@luminaos/ui: "workspace:*"` as
 * a runtime dependency for this import to resolve at all (see
 * `../package-config.integration.test.ts`).
 */
describe('App', () => {
  it('renders a "LuminaOS Desktop" heading (hello-world smoke test)', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'LuminaOS Desktop' })).toBeInTheDocument();
  });

  it('renders a real @luminaos/ui component, proving workspace-linking', () => {
    render(<App />);

    const proof = screen.getByTestId('ui-package-proof');
    expect(proof).toBeInTheDocument();
    expect(proof.tagName).toBe('BUTTON');
  });
});
