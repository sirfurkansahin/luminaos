# F2-T16 — Yeniden Kullanılabilir Webhook'lar + Otomasyon Geçmişi/Denetim Ekranı

**Epik:** F2-E5 (Otomasyon Motoru, Kapsam I) · **Durum:** Tamamlandı — ADR-0033 + PR1 (#180), PR2 (#181), PR3 (#182), PR4 (#183).
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

- [x] Açık Soru 1-5'in insan kararları netleşti (`architect` taslağı + insan onayı, ADR-0033) ve insan onayından önce sunuldu.
- [x] Bir workspace admin'i, bir hedef URL + abone olunan olay tip(ler)i ile bir outbound webhook aboneliği oluşturabilir/düzenleyebilir/silebilir. PR1 (#180, `webhook_subscriptions` şeması + `ssrf-guard.ts` + CRUD, admin+ RBAC).
- [x] Bir `ActionsProposed`/`ActionsDecided` olayı gerçekleştiğinde, ilgili abonelikteki her URL'ye imzalı bir payload POST edilir; imza alıcı tarafından doğrulanabilir bir HMAC şeması kullanır. PR2 (#181, enqueue projeksiyonu + `WebhookDeliveryService` imzalama/SSRF-yeniden-kontrol).
- [x] Teslimat başarısızlığı workspace'in geri kalan işleyişini asla etkilemez (fire-and-forget + sınırlı yeniden deneme + log, crash yok). PR2 (#181, `WebhookDeliveryWorker` poller + security-review'de düzeltilen izolasyon/lease/lifecycle düzeltmeleri — aşağıya bakın).
- [x] `CommandsService`'in yeni liste yeteneği + destekleyici `GET` uç noktası, bir workspace'in bekleyen önerilerini (en azından) doğru şekilde döndürür; cross-workspace izolasyon korunur. PR3 (#182, `CommandsService.listProposals` + `GET .../commands/proposals`, member+ RBAC).
- [x] `apps/web`'de yeni bir denetim ekranı: bekleyen önerileri listeler, her biri için onay/red aksiyonu sunar (gerçek `decide()` çağrısı), karar-verilmiş geçmişi gösterir. PR4 (#183, `AutomationHistoryPanel.tsx` + `WebhookSubscriptionsPanel.tsx`).
- [x] İmzalama sırrı hiçbir zaman ham olarak loglanmaz veya (oluşturma-anı dışında) API yanıtında geri döndürülmez. PR1/PR2 (#180/#181), security-review'de doğrulandı.
- [x] Cross-workspace izolasyon: bir workspace'in webhook aboneliği/denetim verisi başka bir workspace'e asla sızmaz. PR1-PR3'ün her birinin integration testlerinde ayrı ayrı doğrulandı.
- [x] Testler: abonelik CRUD RBAC'ı, teslimat imzalama doğruluğu, teslimat-başarısızlığının sistemi çökertmediği, liste uç noktasının cross-workspace izolasyonu, denetim ekranının onay/red akışının gerçekten `decide()`'ı çağırdığı. Test kanıtı aşağıda.
- [x] `security-reviewer` denetiminde bulgu yok (özellikle: sır sızıntısı, SSRF riski — kullanıcı-yapıştırdığı bir URL'ye sunucu-taraflı POST atmanın kendine özgü SSRF yüzeyi, RBAC bypass'ı). PR2'nin 5, PR3'ün 1 bulgusu düzeltilerek merge edildi (aşağıya bakın); PR4'te engelleyici bulgu yok, tek bilgilendirici öneri bilinçli olarak uygulanmadı (aşağıya bakın).
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil (her PR için ayrı ayrı doğrulandı).

## Done

**PR'lar:**

- PR1 (#180): `webhook_subscriptions` şeması + `ssrf-guard.ts` + CRUD, admin+ RBAC.
- PR2 (#181): Teslimat mekanizması — enqueue projeksiyonu + `WebhookDeliveryService` (imzalama, SSRF-yeniden-kontrol) + `WebhookDeliveryWorker` poller.
- PR3 (#182): `CommandsService.listProposals` + `GET .../commands/proposals`, member+ RBAC.
- PR4 (#183): `AutomationHistoryPanel.tsx` + `WebhookSubscriptionsPanel.tsx` (frontend).

**Test kanıtı:**

- PR1 — 38 birim test (`ssrf-guard`) + 2 entegrasyon test dosyası (Docker-gated, bu oturumun sandbox'ında çalıştırılamadı, gerçek CI yeşil-geçit).
- PR2 — 6 birim test (`webhook-delivery.service`) + 2 entegrasyon test dosyası (aynı Docker-gated not).
- PR3 — 2 entegrasyon test dosyası (aynı not).
- PR4 — 72 yeni birim test (`useWebhookSubscriptionsQuery`/`useProposalsQuery`/`WebhookSubscriptionsPanel`/`AutomationHistoryPanel`), tüm `apps/web` paketi 61 dosya/589 test yeşil — bu oturumda fiilen çalıştırılıp doğrulandı (Docker-gated değil, düz vitest+RTL testleri).
- `pnpm typecheck && pnpm lint` her PR'da ayrı ayrı doğrulandı (bu oturumun kendi disiplini gereği, her implementer dispatch'inden sonra bağımsız kontrol edildi).

## Bilinen Kısıtlar / Gelecek Takip

- **PR2 security-review'de bulunup düzeltilen 5 sorun (merge öncesi):**
  1. Webhook-enqueue projeksiyonunun catch-up hatası, zaten karar verilmiş bir öneriyi kalıcı olarak "askıda" bırakabilirdi — düzeltildi (kendi try/catch'ine izole edildi, asla yeniden fırlatılmıyor).
  2. `ENCRYPTION_KEY` tanımsızsa TÜM sunucu boot anında çökerdi — düzeltildi (yalnızca webhook teslimatı, lazy olarak, başarısız oluyor).
  3. Çakışan worker tick'leri üçüncü-parti bir uç noktaya çift teslimat yapabilirdi — düzeltildi (atomik bir claim-lease eklendi).
  4. Worker, yumuşak-silinmiş (soft-deleted) aboneliklere teslimata devam ediyordu — düzeltildi (yaşam-döngüsü filtresi eklendi).
  5. Yanıt gövdeleri iptal edilmiyordu, açık bağlantı riski taşıyordu — düzeltildi (her zaman iptal ediliyor).
- **PR3 security-review'de bulunup düzeltilen 1 sorun:** `listProposals`'ta çağıran-tarafından-sağlanan `limit` sınırsızdı — düzeltildi (`MAX_LIST_PROPOSALS_LIMIT = 200` eklendi, serviste kırpılıyor).
- **PR4 security-review'de engelleyici bulgu yok; bilinçli olarak uygulanmayan bir bilgilendirici öneri:** `WebhookSubscriptionsPanel`'in sil butonunda mutasyonu çağırmadan önce bir onay adımı yok (`McpAccessPanel`'in mevcut onaysız-iptal emsalini yansıtıyor) — bu, bir webhook aboneliğini silmenin, model alındığı MCP-token-iptal durumundan DAHA GENİŞ bir etki alanı (blast radius) taşıması nedeniyle işaretlendi: sessizce üçüncü-parti bir entegrasyonu kırabilir; imzalama sırrı yalnızca-bir-kez-gösterilir ve kurtarılamaz olduğundan, yeniden oluşturmak yeni bir sırrın yeniden dağıtılmasını gerektirir. Gelecekteki bir PR hafif bir onay adımı ekleyebilir.
- **ADR-0033'ün "Mimari Değişmezlerle İlişki" bölümünden miras (zaten yazılı, burada yeniden türetilmedi):** `AutomationHistoryPanel`/`listProposals` üzerinden dışa açılan `actions[].params` alanları, `command_proposals.command`'ın kendisi ham transkript SAKLAMASA da (ADR-0031 §f), transkript-türevli olabilir — bu CLAUDE.md'nin "veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" değişmeziyle tutarlı, admin-başlatımlı, açık bir veri-görünürlüğü kararı olarak çerçevelendi, bir kusur değil, ve bu görevde daha fazla çözülmedi.
- **i18n:** Her iki yeni frontend paneli de (`AutomationHistoryPanel`, `WebhookSubscriptionsPanel`) bir i18n kataloğu yerine satır-içi Türkçe metin kullanıyor — bu, `McpAccessPanel.tsx`/`IntegrationsPanel.tsx`'te ZATEN VAR OLAN emsale uyuyor (bu görevin ürettiği yeni bir ihlal değil, tüm bu paneller genelinde önceden var olan teknik borç); gelecekteki özel bir i18n-kataloğu geçişi bunların hepsini birlikte kapsamalı.

---

**Sıradaki adım:** F2-T16 tamamlandı. `docs/PLAN.md`'ye göre (satır 269) F2-E5'in son görevi F2-T17 ("AI önerili otomasyon şablonları, kullanım desenlerinden") — henüz bir spec dosyası yok, CLAUDE.md'nin ritüeli gereği önce spec yazılmalı:

```
/yeni-ozellik F2-T17 — AI önerili otomasyon şablonları: kullanıcının geçmiş kullanım desenlerinden (tekrarlayan komutlar, sık onaylanan aksiyon tipleri, F2-T15'in tetikleyici/koşul motorunun mevcut kullanımı, F2-T16'nın CommandsService.listProposals ile artık okunabilir hale gelen onay/red geçmişi) yola çıkarak AI'ın yeni otomasyon/tetikleyici ŞABLONLARI önermesi — kullanıcı bu önerileri inceleyip onaylayarak gerçek bir tetikleyiciye (F2-T15'in automation_triggers kaynağına) dönüştürebilir; hiçbir şablon kullanıcı onayı olmadan gerçek bir tetikleyiciye dönüşmez (fail-closed öner→onayla disiplini).
```
