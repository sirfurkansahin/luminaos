# F2-T16 — Yeniden Kullanılabilir Webhook'lar + Otomasyon Geçmişi/Denetim Ekranı

**Epik:** F2-E5 (Otomasyon Motoru, Kapsam I) · **Durum:** Taslak — insan onayına sunuluyor.
**Bağımlılık:** F2-T15/ADR-0032 (tetikleyici/koşul/aksiyon çekirdeği, Tamamlandı — bu görev onun ürettiği `ActionsProposed`/`ActionsDecided` olaylarını dışa açar), F1-T16/ADR-0015 (konuşma-komutları öner→onayla akışı, `command_proposals`'ın kaynağı), F2-T13/ADR-0030 (notetaker'ın tek-amaçlı inbound webhook'u — bu görevin "yeniden kullanılabilir" karşıtı örneği), F2-T9/ADR-0025 (`connector_credentials`'ın şifreli-sır-saklama deseni — webhook imzalama sırrı için yeniden kullanılabilir emsal).

> ⚠️ MİMARİ-KARAR GEREKTİREN GÖREV — CLAUDE.md'nin ADR kriterinin (a) ve (b) fıkralarına giriyor: (a) yeni bir outbound-webhook teslim mekanizması (imzalama şeması, yeniden-deneme semantiği, hangi olay tiplerinin tetiklediği) sıfırdan icat ediliyor — bu, gelecekteki her otomasyon-ilişkili görevin (F2-T17 dahil) üzerine inşa edeceği bir sözleşim; (b) `CommandsService`'e ilk kez genel bir "önerileri listele" yeteneği ekleniyor — bu, F1-T16/ADR-0015'in orijinal öner→onayla sözleşmesini genişletiyor. `architect`'in bu iki noktayı netleştiren bir ADR taslağı + insan onayı koddan önce gerekli.

## Amaç

F2-T15'in ürettiği tetikleyici/aksiyon motorunun (ve F1-T16/F2-T14'ün diğer öner→onayla akışlarının) şu ana kadar hiçbir kullanıcı-arayüzü/dışa-entegrasyon yolu yoktu — `ActionsProposed`/`ActionsDecided` olayları yalnızca `command_proposals` tablosunda, tek bir bilinen `proposalId` veya (F2-T14 PR5'ten beri) tek bir `sourceObjectId` üzerinden okunabiliyordu. Bu görev iki tamamlayıcı parçayı ekliyor: (1) bir workspace'in otomasyon olaylarına abone olabileceği YENİDEN KULLANILABİLİR (genel-amaçlı, notetaker'ın tek-amaçlı inbound webhook'unun aksine) bir OUTBOUND webhook mekanizması — harici sistemlerin "bir tetikleyici ateşlendi/bir aksiyon onaylandı" gibi olaylardan haberdar olabilmesi için; (2) bir "otomasyon geçmişi/denetim ekranı" — hem `apps/web`'de hem de destekleyici API'de, kullanıcının önerilen/onaylanan/reddedilen tüm aksiyonları görebildiği VE (F1-T16'dan beri hiç var olmamış) bir onay/red arayüzü sunan bir görünüm.

## Mevcut Durum (bir `explorer` dispatch'i ile doğrulandı)

- **Inbound webhook'lar TEK-AMAÇLI, genel bir abonelik kavramı YOK.** `apps/server/src/notetaker/notetaker-webhook.controller.ts` sabit, parametresiz bir `POST /webhooks/notetaker` rotası — tek bir paylaşılan env-var HMAC sırrı (`notetaker-webhook-auth.guard.ts`), tek bir hardcoded servise (`MeetingsService.applyWebhookUpdate`) dispatch ediyor. Kod tabanı genelinde `webhook` için geniş bir arama, bu tek özellik dışında ikinci bir inbound uç nokta veya genel bir "webhook aboneliği" tablosu bulmuyor.
- **Outbound HTTP-to-kullanıcı-yapılandırdığı-URL TAMAMEN YOK — sıfırdan bir alt-sistem.** `packages/integrations/src/` yalnızca sabit üçüncü-parti sağlayıcı bağlayıcıları taşıyor (takvim, MCP bağlayıcıları, toplantı-bot istemcisi) — hiçbiri kullanıcının forma yapıştırdığı rastgele bir URL'ye POST atmıyor. "Bu JSON'u şu saklanan URL'ye gönder" şeklinde genel bir yardımcı hiçbir yerde yok.
- **`command_proposals` şeması** (`apps/server/src/db/schema/command-proposals.ts`): `id` (proposalId, PK), `streamId` (unique), `workspaceId` (FK), `command` (text), `sourceObjectId` (nullable), `actions` (jsonb), `decisions` (nullable jsonb), `createdAt`, `decidedAt` (nullable). `ActionProposalProjection` bu satırı `ActionsProposed`'da ekliyor, `ActionsDecided`'da `decisions`/`decidedAt`'i güncelliyor.
- **Genel bir "önerileri listele" yeteneği HİÇBİR KATMANDA yok.** `commands.controller.ts` yalnızca `POST .../commands/parse` ve `POST .../commands/:proposalId/decide` taşıyor — GET yok. `CommandsService`'in kendisinde de `list`/`findAll` metodu yok. Tek okuma yolu, `MeetingsService.getMeetingDetails`'in `command_proposals`'a karşı doğrudan yazdığı, TEK bir `sourceObjectId`'ye özel, ad hoc bir sorgu (F2-T14 PR5) — genel bir liste değil.
- **`apps/web`'de onay/red arayüzü HİÇ YOK.** F1-T16'dan beri (`decide()` uç noktası var olduğundan beri) hiçbir öneri onaylama/reddetme ekranı inşa edilmemiş — kullanıcılar `decide()`'ı yalnızca ham bir HTTP isteğiyle çağırabiliyor. En yakın "ayarlar paneli" emsali `apps/web/src/views/shared/McpAccessPanel.tsx`/`IntegrationsPanel.tsx` (liste + oluşturma-diyaloğu deseni, `App.tsx`'e doğrudan gömülü, ayrı bir `/settings` rotası/sayfa iskeleti yok).
- **RBAC emsali:** `AutomationTriggersService`'in (F2-T15) düz kuralı — yazma `admin`+, okuma `member`+ — bir webhook aboneliği kaynağı için de doğrudan uygulanabilir bir emsal, ANCAK bir webhook aboneliğinin bir imzalama sırrı taşıyabileceği (bir tetikleyici tanımının taşımadığı) göz önüne alındığında bu paralelliğin aynen uygulanıp uygulanmayacağı açık bir soru.
- **Sır saklama emsali:** `connector_credentials` (F2-T9/ADR-0025) + `ConnectorCredentialsService`'in `encryptSecret`/`decryptSecret` (`packages/shared`, `env.encryptionKey` ile anahtarlı) deseni — bir webhook aboneliğinin kendi imzalama sırrı için YENİDEN KULLANILABİLİR bir şifreleme şeması, sıfırdan icat edilmesi gerekmiyor. Şema şekli (workspace+user+connectorType üçlüsü) workspace+webhookId şekline uyarlanmalı.

## Kapsam

1. **Outbound webhook abonelik CRUD'u** — bir workspace'in kendi webhook aboneliğini (hedef URL + hangi olay tiplerine abone olduğu + isteğe bağlı imzalama sırrı) tanımlayabildiği, düzenleyebildiği, silebildiği yeni bir kaynak.
2. **Outbound teslim mekanizması** — belirlenen otomasyon olayları (en azından `ActionsProposed`/`ActionsDecided`; tetikleyici yaşam-döngüsü olayları kapsam açık sorusu) gerçekleştiğinde, ilgili abonelikteki her URL'ye imzalı bir JSON payload POST eden bir servis. Başarısız teslimatlar için asgari bir yeniden-deneme/log disiplini (ADR'de netleşir).
3. **`CommandsService`'e genel liste yeteneği** — bir workspace'in TÜM (veya filtrelenmiş: bekleyen/karar-verilmiş) önerilerini döndüren yeni bir metod + destekleyici `GET` uç noktası.
4. **Otomasyon geçmişi/denetim ekranı (`apps/web`)** — yeni bir görünüm: bekleyen önerileri listeler, her biri için tek-tek onay/red aksiyonu sunar (F1-T16'nın `decide()`'ının İLK gerçek kullanıcı arayüzü), karar verilmiş önerilerin geçmişini gösterir.

## Kapsam DIŞI

- **F2-T17'nin AI-önerili otomasyon şablonları** — kullanım desenlerinden şablon öğrenme bu görevin işi değil.
- **Inbound webhook'ların genelleştirilmesi** — notetaker'ın kendi tek-amaçlı inbound webhook'u DEĞİŞTİRİLMİYOR; bu görev yalnızca OUTBOUND (LuminaOS'ten dışarıya) webhook'ları kapsıyor (Açık Soru 1'in kesin kapsamı insan onayına sunuluyor).
- **Otomasyon olaylarının gerçek-zamanlı (WebSocket/SSE) frontend güncellemesi** — denetim ekranı v0'da sayfa-yenileme/polling ile çalışır, canlı push bildirimleri kapsam dışı.
- **Webhook teslimat metriklerinin/analitiğinin görselleştirilmesi** — yalnızca temel başarı/başarısızlık logu, bir metrik panosu değil.

## Açık Sorular

1. **[KRİTİK] Bir outbound webhook aboneliği HANGİ olay tiplerine abone olabilir?**
   - **Bağlam:** En dar kapsam yalnızca `ActionsProposed`/`ActionsDecided` (F1-T16/ADR-0015/ADR-0031/ADR-0032'nin öner→onayla akışı) olabilir. Daha geniş bir kapsam `TriggerCreated`/`TriggerUpdated`/`TriggerDeleted` (F2-T15) gibi tetikleyici-yaşam-döngüsü olaylarını da kapsayabilir.
   - **Öneri:** v0'ı yalnızca `ActionsProposed`/`ActionsDecided` ile sınırla — görevin kendi başlığındaki "otomasyon geçmişi" ile doğrudan eşleşen, en dar ve en net kapsam.
2. **[KRİTİK] Webhook imzalama şeması ne olacak (HMAC-SHA256 imza başlığı, hangi sır, ne formatta)?**
   - **Öneri:** `connector_credentials`'ın şifreleme şemasını (`packages/shared`'in `encryptSecret`/`decryptSecret`'ı, `env.encryptionKey`) yeniden kullanarak her abonelik kendi rastgele üretilmiş imzalama sırrını saklar; teslimat, notetaker'ın kendi HMAC doğrulama desenine BENZER (ama ters yönde — biz imzalıyoruz, alıcı doğruluyor) bir `X-LuminaOS-Signature` başlığı gönderir.
3. **Teslimat başarısız olursa ne olur — yeniden deneme var mı, kaç kez, ne sıklıkla?**
   - **Öneri:** v0 için basit: sabit sayıda (ör. 3) yeniden deneme, üstel geri-çekilmeyle, sonra sessizce vazgeç + logla (F2-T15'in sweeper/scheduler'larının "asla crash etme, opak id ile logla" disiplinine tutarlı) — karmaşık bir dead-letter-queue icat edilmez.
4. **`CommandsService`'in yeni liste metodu hangi filtreleri destekler (yalnızca bekleyenler mi, tümü mü, sayfalama var mı)?**
   - **Öneri:** En azından `decidedAt IS NULL` (bekleyen) filtresi zorunlu (denetim ekranının asıl ihtiyacı budur); tam geçmiş için sayfalama gerektiren bir "tümünü listele" modu da eklenir ama v0'da basit bir `limit`/`cursor` yeterli, F1-T6'nın tam sorgu DSL'i bu görevde yeniden kullanılmaz (aşırı mühendislik olur).
5. **Webhook aboneliği RBAC'ı `AutomationTriggersService`'in düz kuralını (yazma admin+, okuma member+) mi izler, yoksa imzalama-sırrı-taşıma nedeniyle daha kısıtlayıcı mı olmalı (ör. hem yazma HEM okuma admin+)?**
   - **Öneri:** Yazma admin+, ama OKUMA da admin+ (member+ değil) — çünkü bir aboneliğin var olduğunu bilmek + hedef URL'sini görmek, bir tetikleyici tanımını görmekten daha hassas (dışarıya veri sızdıran bir entegrasyonun varlığını ima ediyor); imzalama sırrının kendisi HİÇBİR rolde, hatta admin'e bile, ham olarak GÖSTERİLMEZ (yalnızca oluşturma anında bir kez gösterilir, tıpkı çoğu SaaS API-key deseni gibi).

## Kabul Kriterleri

- [ ] Açık Soru 1-5'in insan kararları netleşti (`architect` taslağı + insan onayı) ve insan onayından önce sunuldu.
- [ ] Bir workspace admin'i, bir hedef URL + abone olunan olay tip(ler)i ile bir outbound webhook aboneliği oluşturabilir/düzenleyebilir/silebilir.
- [ ] Bir `ActionsProposed`/`ActionsDecided` olayı gerçekleştiğinde, ilgili abonelikteki her URL'ye imzalı bir payload POST edilir; imza alıcı tarafından doğrulanabilir bir HMAC şeması kullanır.
- [ ] Teslimat başarısızlığı workspace'in geri kalan işleyişini asla etkilemez (fire-and-forget + sınırlı yeniden deneme + log, crash yok).
- [ ] `CommandsService`'in yeni liste yeteneği + destekleyici `GET` uç noktası, bir workspace'in bekleyen önerilerini (en azından) doğru şekilde döndürür; cross-workspace izolasyon korunur.
- [ ] `apps/web`'de yeni bir denetim ekranı: bekleyen önerileri listeler, her biri için onay/red aksiyonu sunar (gerçek `decide()` çağrısı), karar-verilmiş geçmişi gösterir.
- [ ] İmzalama sırrı hiçbir zaman ham olarak loglanmaz veya (oluşturma-anı dışında) API yanıtında geri döndürülmez.
- [ ] Cross-workspace izolasyon: bir workspace'in webhook aboneliği/denetim verisi başka bir workspace'e asla sızmaz.
- [ ] Testler: abonelik CRUD RBAC'ı, teslimat imzalama doğruluğu, teslimat-başarısızlığının sistemi çökertmediği, liste uç noktasının cross-workspace izolasyonu, denetim ekranının onay/red akışının gerçekten `decide()`'ı çağırdığı.
- [ ] `security-reviewer` denetiminde bulgu yok (özellikle: sır sızıntısı, SSRF riski — kullanıcı-yapıştırdığı bir URL'ye sunucu-taraflı POST atmanın kendine özgü SSRF yüzeyi, RBAC bypass'ı).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** Bu spec taslağı insan onayına sunulur. Onaylanırsa Plan Mode'a geçilip Açık Sorular 1-5'in insan kararları (özellikle Açık Soru 1/2'nin mimari forkları — olay-tipi kapsamı ve imzalama şeması) `architect` subagent'ı ile netleştirilir; ardından `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir.
