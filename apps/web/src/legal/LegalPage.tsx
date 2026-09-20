import { legalConfig } from './legal-config';

export type LegalDocument = 'privacy' | 'terms';

export function LegalPage({ document }: { document: LegalDocument }) {
  return (
    <main className="legal-shell">
      <article className="legal-card">
        <a href="/">Giriş ekranına dön</a>
        {document === 'privacy' ? <PrivacyNotice /> : <BetaTerms />}
      </article>
    </main>
  );
}

function PrivacyNotice() {
  return (
    <>
      <h1>Kişisel Veriler Aydınlatma Metni</h1>
      <p>Yürürlük tarihi: {legalConfig.effectiveDate}</p>
      <p>
        Bu metin kapalı betada kişisel verilerin nasıl işlendiğini açıklar; açık rıza talebi
        değildir.
      </p>
      <h2>Veri sorumlusu</h2>
      <p>{legalConfig.controllerName}</p>
      <p>Başvuru ve iletişim: {legalConfig.contactEmail}</p>
      <h2>Toplanan veri kategorileri</h2>
      <ul>
        <li>Hesap bilgileri: e-posta adresi, parola özeti ve oturum kayıtları.</li>
        <li>Çalışma alanı içeriği: görevler, belgeler, yorumlar ve tercihler.</li>
        <li>Teknik kayıtlar: istek zamanı, hata türü ve güvenlik günlükleri.</li>
      </ul>
      <h2>İşleme amaçları ve hukuki sebepler</h2>
      <p>
        Veriler beta hesabını ve çalışma alanını sunmak, güvenliği sağlamak, hataları gidermek,
        talepleri cevaplamak ve yasal yükümlülükleri yerine getirmek için; sözleşmenin ifası, hukuki
        yükümlülük ve temel haklara zarar vermeyen meşru menfaat şartlarına dayanılarak işlenir.
        Açık rıza gerektiren isteğe bağlı özellikler ayrıca sorulur.
      </p>
      <h2>Toplama yöntemi ve aktarım</h2>
      <p>
        Veriler web işlemleri ve güvenlik günlükleri yoluyla elektronik olarak toplanır. Altyapı
        Oracle Cloud üzerinde çalışır ve şifreli yedek kullanır. Harici AI veya bağlantı
        sağlayıcısına veri gönderen bir özellikte kapsam ve alıcı işlemden önce ayrıca açıklanır.
      </p>
      <h2>Saklama</h2>
      <p>
        Aktif hesap verileri hizmet sürdüğü müddetçe tutulur. Kabul edilen silme talebinde uygun
        veriler silinir veya anonimleştirilir. Şifreli yedek kopyalar erişimi kısıtlı tutulur ve
        yayımlanan yedek saklama takvimi sonunda silinir.
      </p>
      <h2>Haklarınız</h2>
      <p>
        İşleme hakkında bilgi ve kopya isteme, düzeltme, silme/yok etme, aktarılan taraflara
        bildirim ve kanuna aykırı işlem nedeniyle zararın giderilmesini isteme haklarına sahipsiniz.
        Başvurular en kısa sürede ve en geç 30 gün içinde cevaplanır.
      </p>
    </>
  );
}

function BetaTerms() {
  return (
    <>
      <h1>Kapalı Beta Kullanım Koşulları</h1>
      <p>Yürürlük tarihi: {legalConfig.effectiveDate}</p>
      <p>
        LuminaOS kapalı beta sınırlı değerlendirme amacıyla sunulur; üretim garantisi veya
        kesintisiz hizmet taahhüdü vermez.
      </p>
      <h2>Hesap ve güvenlik</h2>
      <p>Hesabınızı paylaşmayın, güçlü parola kullanın ve şüpheli erişimi bildirin.</p>
      <h2>Kabul edilebilir kullanım</h2>
      <p>
        Yalnızca işlemeye yetkili olduğunuz içeriği yükleyin; hizmeti hukuka aykırı amaçla
        kullanmayın.
      </p>
      <h2>Beta değişiklikleri</h2>
      <p>Özellikler değişebilir; önemli koşul ve gizlilik değişiklikleri önceden bildirilir.</p>
      <h2>Veri taşınabilirliği ve ayrılma</h2>
      <p>
        Verilerinizi Veri Hakları bölümünden dışa aktarabilir ve hesap silme talebi verebilirsiniz.
      </p>
    </>
  );
}
