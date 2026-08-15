import { Button } from '@luminaos/ui';

// ADR-0019 Karar (d): "yalnız iskelet, gerçek iş mantığı yok" — bu bileşen
// F2-T3'ün üzerine inşa edeceği boş pencere iskeleti. `Button` importu
// `@luminaos/ui`'den gerçekten geliyor (ADR-0019 Karar (b) workspace-linking
// kanıtı) ve `data-testid="ui-package-proof"` prop'unu native `<button>`'a
// forward ediyor.
export function App() {
  return (
    <main>
      <h1>LuminaOS Desktop</h1>
      <Button data-testid="ui-package-proof">LuminaOS Desktop</Button>
    </main>
  );
}
