# F3-T4 — Ajan Aksiyon Kayıt Defteri: Her Ajan Aksiyonu için Gerekçe + Kaynaklar + Geri Alma Planı ("Uçuş Kayıt Cihazı")

**Epik:** F3-E2 (Cam Kutu Otonomi, Kapsam K) · **Durum:** PLANLANDI — bu, Epik F3-E2'nin AÇILIŞ görevidir (F3-T5 otonomi kadranı ve F3-T6 tek-tık geri alma bu Epiğin sonraki görevleridir, bu spec'in kapsamı DIŞINDA). Mimari karar `docs/adr/ADR-0038-ajan-aksiyon-kayit-defteri.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** Epik F3-E1 (F3-T1/ADR-0035 — Agent Runtime + izin manifestosu/sandbox; F3-T2/ADR-0036 — Skill SDK v1; F3-T3/ADR-0037 — Ajan-İnsan Etkileşimi, `MentionActionWorker`/`CommandsService.executeDecidedAction`) TAMAMEN kapandı, PR #191-#217 `main`'e merge edildi. Bu görev doğrudan CLAUDE.md'nin Mimari Değişmezi'ni — "Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar" — kuruluştan bu yana İLK KEZ gerçekten GERÇEKLEŞTİREN (yalnızca "ihlal etmeyen" değil) görevdir.

## Amaç

Bugün ajan aksiyonlarının izlenebilirliği iki KATEGORİK OLARAK farklı, birbirinden kopuk yolda yaşıyor ve ikisi de CLAUDE.md'nin `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesini gerçek anlamda KARŞILAMIYOR:

1. **`decide()`-yürütülen yol** (`CommandsService.executeDecidedAction`): `ProposedAction.rationale`/`resources`/`rollbackNote` alanları ZATEN var ama AI'nın yazdığı SERBEST METİN düzyazı — hiç ayrıştırılmıyor/doğrulanmıyor, `resources: string[]` gerçek nesne/yorum/toplantı id'lerine karşı DOĞRULANMAMIŞ, ve gerçek yürütülen mutasyona güvenilir tek bağı yalnızca PAYLAŞILAN bir `causationEventId` — `executeAssignPeople`/`executeReconfigureAgentPermissions` bu id'yi bugün hiç TAŞIMIYOR bile (sıfır izlenebilirlik).
2. **Otonom mention→beceri yolu** (`MentionActionWorker.runOnce()` → `executeSkill`): `agent_action_executions` yalnızca `{outcome, durationMs, occurredAt}` — saf hız-sınırı muhasebesi, sıfır gerekçe/kaynak/geri-alma-planı.

Bu görev ikisini TEK birleşik `AgentActionRecord` defterinde toplar: her ajan aksiyonu — insan onaylı olsun ya da tamamen otonom — niyet/gerekçe/kaynaklar/geri-alma-planını yapısal, sorgulanabilir bir kayıt olarak bırakır. Tasarımın tamamı `docs/adr/ADR-0038-ajan-aksiyon-kayit-defteri.md` Karar (a)-(i)'de sabitlendi; bu spec onu görev/PR/kabul-kriteri şekline çevirir.

## Kapsam

1. **Yeni `AgentActionRecord` varlığı** — saf tipler `packages/agent-runtime/src/agent-action-record.ts` (+ olay şeması `agent-action-record-events.ts`, `index.ts`'ten dışa aktarım): `provenance: 'decided'|'autonomous'`, `actor`, `actionType`, `intent`, `rationale`, `resources: ActionResourceReference[]` (ayrık birleşim — `object`/`comment`/`meeting`/`agent`/`external`, ASLA çıplak doğrulanmamış string), `rollbackPlan: RollbackPlan` (YAPISAL açıklama, YÜRÜTÜLEBİLİR değil), `outcome`, `resultRef`, `causationEventId`, `occurredAt`. Servis-katmanı `apps/server/src/agent-runtime/agent-action-records.service.ts`'e eklenir — `AgentPermissionManifestsService`/`AgentResourceLimitsService` ile AYNI dizin/bölünme deseni (ADR-0038 §a).
2. **`decide()`-yürütülen yol kablolaması** — 6 `executeXxx` metodunun (`executeCreateTask`, `executeGenerateSubtasks`, `executeAssignPeople`, `executeCreateTaskFromMeeting`, `executeCreateTaskFromTrigger`, `executeReconfigureAgentPermissions`) her biri kendi `DecideActionResult`'ını belirledikten hemen sonra KENDİ ZATEN BİLDİĞİ somut değerlerle `AgentActionRecordsService.record(...)`'ı çağırır — `command_proposals.actions` jsonb'sinin yeniden ayrıştırılması İCAT EDİLMEZ. `executeAssignPeople`/`executeReconfigureAgentPermissions` imzalarına bugün eksik olan `causationEventId` parametresi eklenir (ADR-0038 §c).
3. **Otonom mention→beceri yol kablolaması** — `MentionActionWorker.runOnce()`, `executeSkill` çağrısından SONRA kendi ledger kaydını yazar (`executeSkill`'in kendisi DEĞİŞMEZ — ADR-0037 onun sabit sırasını zaten kapattı). Somut alanlar ADR-0038 §d'de sabit (ör. `actionType:'answer-question'`, `intent`/`rationale` sabit şablon dizeleri, ham `body`/`answer` metni gömülmez).
4. **Okuma** — `AgentActionRecordsService.list`/`.get`, member+ RBAC, workspace-genelinde (DM'lerin `req.user.id===userId` kişisel kısıtlaması BURADA yok — bu defter kişisel değil, workspace-genelinde denetim kaydı).
5. **Yazma** — HİÇBİR HTTP route yok, yalnızca dahili servis çağrıları (`executeXxx`'ler ve `MentionActionWorker`) yazar.
6. **Frontend** — salt-okunur `apps/web/src/views/shared/FlightRecorderPanel.tsx` (`AutomationHistoryPanel.tsx`'in düz-liste-diyalogsuz konvansiyonunu birebir izler) + `useAgentActionRecordsQuery(workspaceId)` (`useProposalsQuery`'yi yansıtır). Hiçbir düzenleme/aksiyon butonu yok.

## 4 Bağlayıcı İnsan Kararı

1. **Birleşik tek kayıt defteri.** HEM `decide()`-yürütülen aksiyonlar HEM mention→beceri otonom çalıştırmaları TEK yeni olay-kaynaklı tablo/servise yazar — iki ayrı defter İCAT EDİLMEZ (Plan Mode oturumunda alındı, ADR-0038 Bağlam).
2. **Salt-okunur frontend görüntüleyici dahil edilir.** "Uçuş Kayıt Cihazı" paneli bu görevin kapsamına F3-T1'in "v0 yalnızca-backend" emsalinin AKSİNE dahil edilir — Epik F3-E2'nin çekirdek vaadi (şeffaflık) F3-T6'yı beklemeden karşılanır (Plan Mode oturumunda alındı, ADR-0038 §h).
3. **`reconfigureAgentPermissions`'ın `revoke` dalı için `RollbackPlan.kind:'manual'` — v0 YAGNI sınırlaması.** Revoke-öncesi manifesto durumu SNAPSHOT'LANMAZ, dolayısıyla yapısal bir ters-işlem tarif edilemez; `description` insana "önceki manifestoyu elle yeniden ver" der. Gerçek bir ihtiyaç doğarsa bu ayrı bir karar/genişletme gerektirir (ADR-0038 §g).
4. **Geçmişe dönük backfill YOK.** Mevcut `command_proposals`/`agent_action_executions` satırları için hiçbir geriye-dönük-türetme yapılmaz — defter yalnızca migration'dan SONRAKİ aksiyonları kapsar; Flight Recorder paneli boş başlar. Serbest-metin `rationale`/`rollbackNote`'u güvenilir biçimde yapılandırılmış forma dönüştürecek deterministik bir kural yok — sahte-kesinlikli backfill hiç yapmamaktan daha kötü bir denetim riski olurdu (ADR-0038 §i).

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0038-ajan-aksiyon-kayit-defteri.md` Karar (a)-(i) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Yerleşim:** Saf tipler `packages/agent-runtime/`'a YENİ dosyalar olarak eklenir, yeni bir paket AÇILMAZ; servis-katmanı `apps/server/src/agent-runtime/`'a eklenir — mevcut `AgentPermissionManifestsService`/`AgentResourceLimitsService` bölünmesiyle aynı desen.
- **(b) `AgentActionRecord` şekli:** `provenance`/`actor`/`actionType`/`intent`/`rationale`/`resources[]`/`rollbackPlan`/`outcome`/`resultRef`/`causationEventId`/`occurredAt`. `AgentActionOutcome` iki farklı çıktı sözlüğünü (`DecideActionResult.status` ve `AgentActionResult.outcome`) tek `succeeded|partially_succeeded|failed|rejected` sözlüğüne eşler; `timeout` ayrı bir dal DEĞİL (zaten worker'ın kendi retry mantığında ayrı işleniyor).
- **(c) `decide()`-yol:** Her `executeXxx` KENDİ kaydını KENDİ zaten bildiği somut değerlerle yazar — jsonb yeniden-ayrıştırma İCAT EDİLMEZ. `causationEventId` `executeAssignPeople`/`executeReconfigureAgentPermissions`'a eklenir. Yazım `AgentResourceLimitsService.recordAgentAction`'ın best-effort/asla-fırlatmaz sözleşmesini izler; `rejected`/`failed` sonuçlar DA kaydedilir.
- **(d) Otonom yol:** `MentionActionWorker.runOnce()` `executeSkill`'den SONRA kendi kaydını yazar — `executeSkill`'in imzası/sabit sırası DEĞİŞMEZ (ADR-0037 onu yeniden açmaz). `agent_action_executions` AYNEN korunur, DEĞİŞTİRİLMEZ, birleştirilmez — yeni ledger bunun YERİNE geçmeyen zengin bir KARDEŞ tablo.
- **(e) Okuma RBAC:** `list`/`get` member+, workspace-genelinde, kişisel kısıtlama YOK.
- **(f) `resources[]` doğrulama:** AI-yazımı `ProposedAction.resources: string[]` düzyazısı ledger'a HİÇBİR ZAMAN doğrudan aktarılmaz/yeniden-yorumlanmaz — her çağrı noktası kendi zaten bildiği somut id'lerden (oluşturduğu nesnenin id'si, `parentObjectId`, mention'ın `objectId`/`commentId`'si, vb.) yapısal olarak inşa eder. AI'nın `intent`/`rationale` düzyazısı görüntüleme amaçlı AYNEN kopyalanır ama hiçbir zaman yetki kaynağı olarak KULLANILMAZ.
- **(g) F3-T6'ya sınır:** Bu görev SADECE kayıt yapar — `revert`/`undo` metodu YOK, ters-olay üretimi YOK. `RollbackPlan` yapısal bir TARİF, gerçek yürütme F3-T6'nın sorumluluğu. Çoklu-kaynaklı aksiyonlar ve `revoke` dalı için tam orkestrasyon İCAT EDİLMEZ.
- **(h) Frontend gerekçesi:** F3-T1'in v0-backend-only emsali burada UYGULANMAZ — bu kaydın olgunluk seviyesi (zaten insan-okunabilir mutasyonlara bağlı) kategorik olarak farklı; ertelemek Epik'in şeffaflık vaadini belirsiz süre karşılıksız bırakırdı.
- **(i) Backfill duruşu:** Yok, açıkça kayda geçirilmiş bir sınırlama (yukarıda İnsan Kararı 4).

**RBAC özeti:** Okuma (`list`/`get`) = member+, workspace-genelinde; Yazma = HİÇBİR HTTP uç noktası yok, yalnızca `executeXxx`'ler ve `MentionActionWorker` dahili servis çağrısıyla yazar.

## PR Bölünmesi (4 PR, tek plan onayı hepsini kapsar)

1. **PR1 — Defter altyapısı (backend).** `packages/agent-runtime` saf tipleri (`AgentActionRecord`/`ActionResourceReference`/`RollbackPlan`/`ActionProvenance`/`AgentActionOutcome` + küçük saf fabrika yardımcıları) + `AgentActionRecorded` olay şeması; `agent_action_records` tablosu + migration + down script; projeksiyon; `AgentActionRecordsService` (`record`/`list`/`get`); controller (yalnızca GET, member+); module kablolaması. Integration testler: RBAC (member+ okur, guest reddedilir), cross-workspace izolasyon, `record`'ın best-effort (asla fırlamayan) davranışı.
2. **PR2 — `decide()`-yol kablolaması.** 6 `executeXxx`'e ledger-yazma eklenir; `executeAssignPeople`/`executeReconfigureAgentPermissions`'ın bugün eksik `causationEventId` boşlukları kapatılır. Integration testler: her aksiyon tipi için doğru kayıt (doğru `resources[]`/`rollbackPlan`/`causationEventId`), reddedilen/başarısız kararların da kaydedildiği, ledger-yazım hatasının gerçek aksiyonu (asıl mutasyonu) BOZMADIĞI.
3. **PR3 — Otonom mention→beceri yol kablolaması.** `MentionActionWorker`'a ledger-yazma eklenir (başarı + izin-reddi + timeout/failure yolları). Integration testler: `provenance:'autonomous'`/`actor`/`resultRef`/`causationEventId:null` doğruluğu, `executeSkill`'in imzasının DEĞİŞMEDİĞİ.
4. **PR4 — Frontend.** `FlightRecorderPanel.tsx` + `useAgentActionRecordsQuery` + `apiClient.ts` eklentisi + `App.tsx` kablolaması.

## Kapsam Dışı

- **Gerçek geri-alma/undo yürütme** — F3-T6'nın kapsamı; bu görev yalnızca `RollbackPlan`'ı KAYDEDER, hiç ÇALIŞTIRMAZ.
- **`decide()`'ı bypass eden veya ikinci bir onay/karar yüzeyi eklemek** — ADR-0037'nin `decide()`'ı TEK boğaz noktası olarak sabitleyen kararına uyulur; bu bir KAYIT mekanizmasıdır, ONAY mekanizması DEĞİL.
- **`agent_action_executions`'ın değiştirilmesi/birleştirilmesi** — hız-sınırı sayaç tablosu olarak AYNEN kalır, yeni ledger onun YERİNE geçmez.
- **`SkillExecutionService.executeSkill`'in imzasının değiştirilmesi** — ADR-0037 onun sabit sırasını yeniden açılmaz ilan etti.
- **Geçmiş `command_proposals`/`agent_action_executions` satırları için backfill** — İnsan Kararı 4.
- **Çoklu-kaynaklı aksiyonlar (`generateSubtasks`) veya `revoke` dalı için tam yapısal ters-işlem orkestrasyonu** — `RollbackPlan.targetResource` tekil kalır, tam liste `resources[]`'tan okunur; N-kaynaklı orkestrasyon F3-T6'nın veya ayrı bir gelecekteki genişletmenin kapsamı.

## Kabul Kriterleri

- [x] **PR1:** `AgentActionRecordsService.list`/`.get` member+ RBAC uygular (guest reddedilir); cross-workspace izolasyon doğrulanır (bir workspace'in kaydı başka bir workspace'te görünmez/erişilmez); `record()` best-effort'tur — kasıtlı bir DB hatası enjekte edildiğinde `record()` fırlatmaz, yalnızca loglar.
- [x] **PR2:** 6 `executeXxx`'in her biri doğru `provenance:'decided'`, `actionType`, `resources[]` (kendi bildiği somut id'lerden inşa edilmiş), `rollbackPlan`, `causationEventId` ile bir kayıt yazdığı doğrulanır; `executeAssignPeople`/`executeReconfigureAgentPermissions`'ın `causationEventId` boşluğunun kapandığı ayrıca doğrulanır; `rejected`/`failed` `DecideActionResult`'ların da kaydedildiği doğrulanır; ledger-yazım hatası enjekte edildiğinde asıl mutasyonun/`DecideActionResult`'ın ETKİLENMEDİĞİ doğrulanır.
- [x] **PR3:** Başarı yolunda `provenance:'autonomous'`, `actor:{type:'agent',id:agentIdentifier}`, `resultRef:{kind:'comment',commentId:...}`, `causationEventId:null` doğru yazılır; izin-reddi (`ForbiddenError`) yolunda `outcome:'failed'`, `resultRef:null`, `rollbackPlan:{kind:'none',...}` yazılır; timeout/failure retry döngüsünde HER deneme için ayrı kayıt YAZILMADIĞI (yalnızca nihai sonucun kaydedildiği) veya ADR'de tarif edilen davranış doğrulanır; `executeSkill`'in imzası DEĞİŞMEDİĞİ (tip-seviyesinde) doğrulanır.
- [x] **Yapısal doğruluk (PR1-PR3 geneli):** `resources[]` hiçbir zaman `ProposedAction.resources: string[]`'in AI-yazımı serbest metninden DOĞRUDAN türetilmez — her kayıt noktası kendi bildiği somut id'lerden yapısal olarak inşa eder (kod incelemesi + testle kanıtlanır).
- [x] **Yazma yüzeyi:** Ledger için hiçbir HTTP POST/PUT/PATCH/DELETE route'u YOKTUR — yalnızca GET (`list`/`get`) mevcuttur; bu router tanımlarının statik incelemesiyle doğrulanır.
- [x] `agent_action_records` migration'ının down script'i mevcuttur ve geri-alma test edilmiştir (CLAUDE.md: "Migration'ı down script'i olmadan yazma").
- [x] **PR4:** `FlightRecorderPanel.tsx` salt-okunur — hiçbir düzenleme/aksiyon/geri-al butonu içermez; her satır niyet/gerekçe/kaynaklar/geri-alma-planı/actor/`occurredAt`/outcome rozetini gösterir.
- [x] Her PR'da `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil (PR4 ayrıca `@luminaos/web` için).
- [x] `security-reviewer` her PR'da çağrılır ve bulgu kapatılmadan bir sonraki PR'a geçilmez (özellikle PR2/PR3: ledger-yazım hatasının gerçek aksiyonu bozmadığı, `resources[]`'ın hiçbir zaman doğrulanmamış AI metninden türetilmediği).

## Done

Tüm 4 PR `main`'e merge edildi:

- **PR1 — Defter altyapısı** (#220): `packages/agent-runtime/src/agent-action-record.ts` + `agent-action-record-events.ts` (saf tipler + zod payload şeması), `agent_action_records` şeması + migration `0043` (+ down script), `AgentActionRecordProjection`, `AgentActionRecordsService` (`record`/`list`/`get`, `agentActionRecordedPayloadSchema.parse()` ile payload doğrulamalı best-effort yazım), yalnızca-GET `AgentActionRecordsController`, modül kablolaması.
- **PR2 — decide()-yol kablolaması** (#221): 6 `CommandsService.executeXxx` metodunun tamamı artık ledger kayıtlarını yeni bir `recordDecidedLedgerEntry` yardımcısı üzerinden yazıyor (kendi savunmacı try/catch'iyle); `executeAssignPeople`/`executeReconfigureAgentPermissions` daha önce eksik olan `causationEventId` parametresini kazandı; reddedilen kararlar da kaydediliyor (`outcome:'rejected'`); `resources[]`/`rollbackPlan`/`resultRef` her zaman ilgili metodun kendi somut id'lerinden yapısal olarak inşa ediliyor, AI-önerisinin serbest-metin alanlarından ASLA türetilmiyor.
- **PR3 — Otonom mention→beceri yol kablolaması** (#222): `MentionActionWorker.runOnce()` ledger kayıtlarını `recordSuccess`/`recordTerminalFailure` yardımcıları üzerinden yazıyor (kendi savunmacı try/catch'iyle); `retryOrFail` artık `Promise<boolean>` döndürüyor (nihai-başarısızlık mı yoksa yalnızca-planlanmış-yeniden-deneme mi) böylece her satır için yalnızca NİHAİ sonuç kaydediliyor, her yeniden deneme denemesi için ayrı kayıt YAZILMIYOR; bu yolda `causationEventId` her zaman `null`; sabit şablon `intent`/`rationale` dizeleri kullanılıyor (ham mention gövdesi/AI cevap metni asla loglanmıyor).
- **PR4 — Frontend** (#223): yeni salt-okunur `FlightRecorderPanel.tsx` (`AutomationHistoryPanel.tsx`'in düz-liste konvansiyonunu izler, sıfır düzenleme/aksiyon/geri-al butonu), `useAgentActionRecordsQuery` hook'u, `apiClient.ts` eklentileri (`AgentActionRecord` tipleri + `listAgentActionRecords`), `App.tsx`'e kablolandı.
- Not: bu, CLAUDE.md'nin `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` mimari değişmezini ajan aksiyonları için yalnızca İHLAL ETMEYEN değil, gerçekten GERÇEKLEŞTİREN ilk ADR'dir (ADR-0038).
- Kanıt: `@luminaos/server` + `@luminaos/web` test paketlerinin tamamı 4 PR boyunca yeşil (birim + entegrasyon, Testcontainers üzerinden gerçek Postgres/Redis), `pnpm typecheck && pnpm lint` boyunca yeşil, her PR'da `security-reviewer` çalıştı ve sıfır bloklayıcı bulgu bıraktı (bir yan-ürün olarak uygulama-geneli, F3-T4'ten BAĞIMSIZ, önceden var olan bir hata bulundu — `AppErrorFilter`'ın global `@Catch()`'ü, gerçekten eşleşmeyen route'lar için NestJS'in kendi dahili `NotFoundException`'ını HTTP 404 yerine 500 olarak yanlış sınıflandırıyor; bu görevde DÜZELTİLMEDİ, ayrı bir gelecekteki düzeltme için işaretlendi).

## Açık Sorular

Bu görev için gerçekten açık bir soru yok — ADR-0038 Bağlam/Karar/Alternatifler bölümleri tüm tasarım kararlarını (yerleşim, şekil, iki yolun kablolanması, RBAC, doğrulama yaklaşımı, F3-T6 sınırı, frontend gerekçesi, backfill duruşu) çözdü. ADR-0038'in "Sonuçlar/Ödünler" bölümünün açıkça gelecekteki genişletme noktası olarak işaretlediği, bu görevi BLOKE ETMEYEN iki kalem F3-T6'ya veya ayrı bir gelecekteki karara ERTELENMİŞTİR:

- Revoke-öncesi manifesto durumunun snapshot'lanması (bugün `RollbackPlan.kind:'manual'` ile v0 YAGNI sınırlaması olarak bırakıldı).
- Çoklu-kaynaklı aksiyonlar (`generateSubtasks`) için tam N-kaynaklı yapısal ters-işlem orkestrasyonu.

## Sıradaki adım

```
docs/PLAN.md'nin Epik F3-E2 (Cam Kutu Otonomi) sıralamasına göre F3-T4 kapandı; sıradaki görev
F3-T5 — Otonomi kadranı: öner / onayla-yap / yap-bildir, görev tipi başına kullanıcı ayarı.
Önce docs/specs/F3-E2/F3-T5-otonomi-kadrani.md spec dosyasını (henüz yazılmadıysa explorer ile
mevcut agent-runtime/decide() akışını keşfedip) oluştur, insana onaylat; sonra plan mode'a geç.
```
