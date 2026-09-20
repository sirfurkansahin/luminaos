import { getWorkspaceExportUrl } from '../lib/apiClient';

export function DataRightsPanel({ workspaceId }: { workspaceId: string }) {
  return (
    <section className="settings-card" aria-labelledby="data-rights-heading">
      <h2 id="data-rights-heading">Veri hakları</h2>
      <p>Bu çalışma alanında erişebildiğiniz verileri taşınabilir JSON olarak indirebilirsiniz.</p>
      <a href={getWorkspaceExportUrl(workspaceId)} download>
        JSON verilerimi indir
      </a>
      <h3>Hesap silme talebi</h3>
      <p>
        Silme talebi kayda alındıktan sonra en kısa sürede ve en geç 30 gün içinde sonuçlandırılır.
      </p>
      <nav className="legal-links" aria-label="Hukuki belgeler">
        <a href="/?legal=privacy">Aydınlatma metni</a>
        <a href="/?legal=terms">Kullanım koşulları</a>
      </nav>
    </section>
  );
}
