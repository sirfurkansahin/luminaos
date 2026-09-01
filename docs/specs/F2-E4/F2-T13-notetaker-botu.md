# F2-T13 — Notetaker Botu: Meet/Zoom/Teams Toplantı Kaydı + Transkript

**Epik:** F2-E4 (Toplantı Zekâsı, Kapsam H) · **Durum:** ✅ Tamamlandı.

**PR'lar:**

- PR0 (ADR-0029/0030 taslağı): #157
- PR1 (`meeting` nesne tipi + `meeting_details` şeması): #158
- PR2 (takvim `meetingUrl` genişletmesi): #159
- PR3 (`MeetingBotClient` + davet uç noktası): #160
- PR4 (webhook alıcısı + HMAC imza doğrulama): #162
- PR5 (ad hoc link UI akışı): #163
  **Bağımlılık:** F1-T12/ADR-0012 (takvim entegrasyonu, Tamamlandı — `apps/server/src/calendar/`), F2-T9/F2-T10 (dış bağlayıcı/kimlik bilgisi deseni, emsal), F2-T12/ADR-0028 (ilk inbound güven sınırı, emsal — ama BU görev İKİNCİ, FARKLI türden bir inbound güven sınırı kuruyor: kullanıcı-token yerine sağlayıcı-imza doğrulamalı webhook).

> ⚠️ MİMARİ-KRİTİK GÖREV — CLAUDE.md'nin ADR kriterinin HEM (a) HEM (b) fıkrasına giriyor, VE bir mevcut boşluğu kapatıyor:
>
> - **(a) Mimari Değişmezlerle gerilim + EKSİK ADR:** CLAUDE.md'nin "Mimari Değişmezler" bölümü `docs/adr/ADR-000X-hibrit-ai.md`'ye atıfta bulunuyor ("Hassas veri sınıfları buluta ham gönderilmez, bkz. `docs/adr/ADR-000X-hibrit-ai.md`") — **böyle bir dosya hiç yazılmamış** (bu görevin `explorer` keşfinde doğrulandı, 28 mevcut ADR'nin hiçbiri bu konuyu kapsamıyor). Bu görev, tam olarak "ham ses" gibi en hassas veri sınıfını üreten ilk özellik olduğu için, bu boşluğu KENDİ ADR'siyle birlikte kapatmalı — insan onayıyla, plan aşamasında zaten kararlaştırıldı.
> - **(b) Gelecekteki görevlere dayatılan sözleşim:** F2-T14 ("Saklama tercihleri + otomatik aksiyon çıkarımı") doğrudan bu görevin `meeting` nesne tipi + kayıt/transkript şeması üzerine inşa edilecek.
>
> `architect` taslağı (muhtemelen İKİ ilişkili ADR: (1) hibrit-AI/yerel-öncelikli veri sınıflandırma politikası — genel, gelecekteki başka görevlerce de kullanılabilir; (2) notetaker bot mimarisi — bu politikayı somut bir üçüncü-parti entegrasyona uygular) + insan onayı koddan önce zorunlu.

## Amaç

Kullanıcının Google Meet/Zoom/Microsoft Teams toplantılarına — takvim etkinliğinden otomatik tespit edilerek VEYA kullanıcının bir toplantı linkini elle yapıştırmasıyla (ad hoc) — bir "notetaker" botu katılır, toplantıyı kaydeder ve transkribe eder. Bu görev yalnızca kayıt/transkript ÜRETİMİNİ ve LuminaOS'e GÜVENLE ulaşmasını kapsar; F2-T14 bu ham çıktıyı saklama tercihlerine göre işleyip onaylı görev/özet üretecek.

## Mevcut Durum (bir `explorer` dispatch'i ile doğrulandı — bu görev BÜYÜK ölçüde greenfield)

- **Vizyon dokümanlarında "nasıl katılır" sorusuna cevap YOK.** `docs/PLAN.md` ve mevcut 28 ADR'nin hiçbiri botun toplantıya katılma MEKANİZMASINI (kendi tarayıcı-otomasyonumuz mu, üçüncü-parti bir "meeting bot" API'si mi) belirtmiyor. **İnsan kararı (plan onayında alındı): üçüncü-parti bir toplantı-bot API'si (Recall.ai benzeri) kullanılacak** — kendi tarayıcı-otomasyonu botu inşa etmek, bu görevin kapsamını aylar süren ayrı bir mühendislik projesine büyütürdü.
- **Takvim entegrasyonu (ADR-0012) var ama toplantı linki alanı YOK.** `apps/server/src/db/schema/calendar-events-cache.ts`'in önbellek satırı yalnızca `{id, calendarAccountId, workspaceId, externalId, title, eventStart, eventEnd, updatedAt}` — konum/açıklama/URL alanı hiç yok. Otomatik toplantı-linki tespiti için ÖNCE bu şemaya alan eklenmesi gerekiyor.
- **`packages/ai-gateway` yalnızca metin-tabanlı.** `AIProvider.complete`/`EmbeddingProvider.embed` var, SIFIR ses/konuşma-metne (STT) yeteneği. Üçüncü-parti bot sağlayıcısı zaten transkripsiyonu kendi tarafında yaptığı için (Açık Soru 1'in önerilen kararı gereği) bu, LuminaOS'in KENDİ STT altyapısı kurmasını GEREKTİRMEZ — yalnızca sağlayıcıdan gelen metin transkripti tüketir.
- **`meeting`/`recording`/`transcript` nesne tipi YOK.** `packages/core-objects/src/lumina-object.ts`'in `ObjectType` union'ı yalnızca `task | doc | note | timeblock` içeriyor — yeni bir tip, mevcut kayıt mekanizmasını (union genişletme + `objectTypeRegistry` girdisi + şema/migration) izleyerek eklenmeli.
- **İçeri-doğru (inbound) webhook alma mekanizması hiç YOK.** `apps/server/src` genelinde "webhook" için sıfır eşleşme. F2-T12 (ADR-0028) İLK inbound güven sınırıydı ama TAMAMEN FARKLI bir tür: kullanıcının kendi ürettiği bir PAT ile kimlik doğrulama. Bu görevin webhook'u FARKLI bir güven modeli gerektiriyor: üçüncü-parti SAĞLAYICIDAN gelen, sağlayıcının imzaladığı (HMAC secret ile) bir callback — kullanıcı kimliği taşımıyor, sağlayıcı kimliği doğrulanıyor.
- **Blob/dosya depolama altyapısı hiç YOK.** `docs/PLAN.md`'nin mimari hedefi ("S3 uyumlu depo") yalnızca isim olarak var, hiç kurulmamış. Kayıt dosyalarının (varsa) nerede kalıcı olarak durduğu (sağlayıcıda mı, LuminaOS'in kendi deposunda mı) Açık Soru 2'nin konusu.
- **Zamanlama/polling emsali var, hafif ve süreç-içi.** `AIRefreshScheduler`/`SearchIndexEmbeddingScheduler` (ikisi de `setTimeout` tabanlı, harici kuyruk/cron kütüphanesi YOK) ve `calendar-sync-poller.service.ts` (takvim önbelleğini periyodik yeniler) — "yaklaşan toplantıyı tespit edip botu gönder" mantığı bu AYNI hafif, süreç-içi deseni izleyebilir, yeni bir kuyruk sistemi icat etmeye gerek yok.

## Kapsam

1. **Eksik hibrit-AI/yerel-öncelikli veri sınıflandırma ADR'si** — CLAUDE.md'nin atıfta bulunduğu ama hiç yazılmamış politikayı kurar: hangi veri sınıfları (ham ses, transkript metni, özet) hangi koşullarda buluta/üçüncü-parti sağlayıcıya gidebilir, kullanıcıya bu konuda ne zaman/nasıl açık onay gösterilir.
2. **Üçüncü-parti toplantı-bot API entegrasyonu** — sağlayıcı-agnostik bir istemci katmanı (ADR-0025/ADR-0026'nın MCP bağlayıcı soyutlamasına benzer ruhta — belirli bir sağlayıcıya sıkı bağlanmayan bir arayüz), gerçek sağlayıcı seçimi ADR'de netleşir.
3. **Takvim etkinliklerinde toplantı-linki tespiti** — `calendar-events-cache` şemasına yeni alan(lar) + Meet/Zoom/Teams URL desenlerini tanıyan ayrıştırma mantığı.
4. **Ad hoc link yapıştırma akışı** — kullanıcının takvimde olmayan bir toplantıya (elle link yapıştırarak) botu davet edebildiği bir UI akışı.
5. **İnbound webhook alıcısı** — sağlayıcıdan "kayıt/transkript hazır" bildirimini GÜVENLE (imza doğrulamalı) alan yeni bir uç nokta — bu codebase'in İLK sağlayıcı-imzalı webhook'u.
6. **Yeni `meeting` LuminaObject tipi** — kayıt/transkript meta verisini (başlık, tarih, katılımcılar, sağlayıcı referansı, transkript metni) taşıyan yeni bir nesne tipi.
7. **`architect` ile (muhtemelen 2 ilişkili) ADR**: hibrit-AI veri sınıflandırma politikası + notetaker bot mimarisinin somut şekli, insan onayından önce yazılır.

## Kapsam DIŞI

- **F2-T14'ün saklama tercihleri (kayıt/transkript/yalnız-özet) + otomatik aksiyon çıkarımı → onaylı görev üretimi** — bu görev yalnızca ham kayıt/transkripti GÜVENLE LuminaOS'e ULAŞTIRIR; F2-T14 bunu kullanıcı tercihine göre İŞLER.
- **Botun toplantıda aktif katılımı** (konuşma, soru sorma, ekran paylaşımı vb.) — yalnızca pasif dinleme/kayıt.
- **Canlı/gerçek-zamanlı transkript gösterimi** toplantı SIRASINDA — yalnızca toplantı SONRASI işleme.
- **Kendi tarayıcı-otomasyonu bot altyapımızı inşa etmek** — insan kararıyla (bkz. Mevcut Durum) reddedildi, üçüncü-parti API kullanılıyor.
- **LuminaOS'in kendi STT (konuşma-metne) altyapısını kurması** — üçüncü-parti sağlayıcı zaten bunu yapıyor.

## Açık Sorular

1. **[KRİTİK] Hangi üçüncü-parti toplantı-bot API sağlayıcısı?**
   - Bu, mühendislik yargısının ötesinde ticari/uyumluluk faktörleri (fiyatlandırma, veri işleme anlaşması şartları, KVKK/GDPR bölge-barındırma seçenekleri) gerektiren bir tedarikçi seçimi — **`architect`/insan tarafından ADR'de netleştirilmeli**, bu spec bir isim SABİTLEMİYOR. Mimari olarak sağlayıcı-agnostik bir arayüz önerilir (ADR-0025'in `McpConnector` soyutlamasına benzer ruhta) ki sağlayıcı değişikliği gelecekte izole bir karar olarak kalabilsin.
2. **[KRİTİK] Kayıt dosyası kalıcı olarak nerede durur?**
   - **Öneri:** v0'da LuminaOS kendi deposuna İNDİRMEZ — yalnızca sağlayıcının kendi (süreli/güvenli) barındırdığı kayıt URL'sine bir REFERANS saklanır, ham ses dosyası LuminaOS'in sunucusundan hiç GEÇMEZ. Gerekçe: "hassas veri sınıfları buluta ham gönderilmez" değişmezini LuminaOS'in KENDİ altyapısı tarafında en güçlü şekilde korur (ham ses LuminaOS'e hiç ulaşmaz); ayrıca yeni bir blob-depolama altyapısı kurma ihtiyacını v0'dan erteler. Dezavantaj: sağlayıcı kaydı sildiğinde/süresi dolduğunda erişim kaybolur — bu, `architect`'in ADR'de tam olarak tartışıp onaylaması gereken bir ödünleşim.
3. **[KRİTİK] Hibrit-AI ADR'ının somut kuralı: LuminaOS sunucusuna hangi veri sınıfı ulaşır?**
   - **Öneri:** Yalnızca METİN transkript (ve varsa üçüncü-parti sağlayıcının ürettiği özet) LuminaOS sunucusuna ulaşır — ham ses/video HİÇBİR ZAMAN LuminaOS'in kendi altyapısından geçmez (Açık Soru 2'nin önerisiyle tutarlı). Ancak üçüncü-parti sağlayıcının KENDİSİ sesi işliyor olması, kullanıcıya AÇIKÇA gösterilmesi gereken bir üçüncü-parti veri işleme onayı gerektirir (botu her davet ettiğinde veya ilk kurulumda tek seferlik bir bilgilendirme/onay ekranı) — bu onay akışının UI şekli `architect` tarafından netleştirilir.
4. **Ad hoc link yapıştırma akışı nereden tetiklenir?**
   - **Öneri:** `CommandPalette.tsx`'e (mevcut Cmd/Ctrl+K hızlı-eylem paleti) yeni bir hızlı-eylem olarak eklenir ("Toplantıya bot davet et" gibi), link yapıştırma bir Dialog'da olur — yeni bir üst-düzey ekran icat edilmez, mevcut hızlı-eylem yüzeyi genişletilir.
5. **`meeting` nesne tipi hangi alanları taşır?**
   - **Öneri (minimum v0):** `title`, `meetingUrl`, `provider` (`google-meet` | `zoom` | `microsoft-teams`), `scheduledAt`, `status` (`sunulan` | `beklemede` | `kaydedildi` | `başarısız`), `providerRecordingRef` (Açık Soru 2'nin kararına göre bir URL veya sağlayıcı-içi kimlik), `transcriptText` (nullable, webhook geldiğinde doldurulur). Katılımcı listesi/konuşmacı-ayrımı (diarization) v0'da YOK — sağlayıcı bunu sunuyorsa bile, F2-T14'ün kapsamına ertelenir.
6. **Takvim etkinliğine otomatik bot gönderme varsayılanı: opt-in mi, opt-out mu?**
   - **Öneri: Sıkı opt-in.** Varsayılan davranış "hiçbir toplantıya otomatik katılma" — kullanıcı ya her etkinlik için elle "botu davet et" der ya da (v0'da YOK, gelecek görev) bir workspace-genelinde "her toplantıya otomatik katıl" ayarını AÇIKÇA etkinleştirir. Gerekçe: bir bot'un kullanıcının HABERİ OLMADAN bir toplantıya katılıp kayıt yapması, diğer toplantı katılımcılarının rızası açısından da ciddi bir risk taşır — varsayılanın en kısıtlayıcı tarafta olması gerekir.
7. **Webhook güvenliği: sağlayıcıdan gelen callback nasıl doğrulanır?**
   - **Öneri:** HMAC imza doğrulaması (sağlayıcının sağladığı bir webhook-secret ile) — F2-T12'nin PAT modelinden TAMAMEN FARKLI bir güven modeli (kullanıcı kimliği değil, sağlayıcı kimliği doğrulanıyor). Tam mekanizma sağlayıcı seçimine (Açık Soru 1) bağlı olduğu için kesin şekli `architect` ADR'de belirler.

## Kabul Kriterleri

- [x] Açık Soru 1-7'nin insan kararları ADR(lar)'da kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu. (ADR-0029, ADR-0030 — PR #157)
- [x] Hibrit-AI/yerel-öncelikli veri sınıflandırma politikası yazılı bir ADR'de var (CLAUDE.md'nin eksik atıfı kapatıldı). (ADR-0029)
- [x] Kullanıcı bir takvim etkinliğine veya ad hoc yapıştırılan bir linke bot davet edebilir; bot yalnızca AÇIKÇA davet edildiğinde katılır (sıkı opt-in, hiçbir otomatik/sessiz katılım yok). (PR #160 davet uç noktası, PR #163 ad hoc UI)
- [x] Ham ses/video LuminaOS'in kendi sunucusundan hiçbir zaman geçmez (Açık Soru 2/3'ün kararına göre doğrulanır). (`meeting_details` yalnızca metin transkript + sağlayıcı referansı taşır, PR #158)
- [x] Sağlayıcıdan gelen webhook imza doğrulaması olmadan asla işlenmez; sahte/imzasız bir webhook isteği reddedilir ve hiçbir `meeting` nesnesini güncellemez. (`NotetakerWebhookAuthGuard`, PR #162)
- [x] Cross-workspace izolasyon: bir workspace'in bot daveti/webhook'u başka bir workspace'in `meeting` nesnesini asla etkilemez. (PR #160/#162 entegrasyon testleri)
- [x] **OKUMA yolu RBAC'ı (yalnızca webhook YAZMA yolu değil):** `GET .../meetings/:meetingId` — farklı bir workspace'in üyesi bir toplantının `transcriptText`'ine (hatta varlığına) asla erişemez; aynı workspace'te rol-bazlı kısıtlamanın öngördüğü rol (ör. `guest`) `transcriptText` alanını göremez (mevcut alan-bazlı izin süzgeci deseniyle tutarlı). (PR #160)
- [x] `meeting` nesne tipi mevcut nesne-tipi kayıt mekanizmasını (union + registry + şema) izleyerek eklendi. (PR #158)
- [x] Testler: bot davet akışı, ad hoc link akışı, webhook imza doğrulama (geçerli/geçersiz/eksik imza), cross-workspace izolasyon (yazma VE okuma yolu), rol-bazlı alan görünürlüğü (okuma yolu), opt-in davranışının gerçekten zorunlu olduğu. (Tüm PR'larda test-writer → implementer ritüeliyle)
- [x] `security-reviewer` denetiminde bulgu yok (özellikle: webhook imza doğrulama gerçekten bypass edilemiyor mu, ham ses sızıntısı yok, cross-workspace izolasyon hem yazma hem OKUMA yolunda, rol-bazlı transkript görünürlüğü). (Her PR için ayrı ayrı çalıştırıldı; PR4'te bulunan hex-format bypass bulgusu aynı PR içinde kapatıldı)
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** F2-T14 ("Saklama tercihleri + otomatik aksiyon çıkarımı") henüz bir spec dosyasına sahip değil — `docs/PLAN.md`'nin F2-E4 bölümünde yalnızca tek satırlık bir açıklama var. Bir sonraki oturumda önce bu spec dosyası yazılmalı:

```
/yeni-ozellik F2-T14 — Saklama tercihleri (kayıt/transkript/yalnız özet) + otomatik aksiyon çıkarımı → onaylı görev üretimi. F2-T13'ün ürettiği `meeting`/`meeting_details` üzerine inşa edilecek.
```
