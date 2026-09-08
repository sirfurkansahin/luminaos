# F3-T5 — Otonomi Kadranı: Öner / Onayla-Yap / Yap-Bildir, Görev Tipi Başına Kullanıcı Ayarı

**Epik:** F3-E2 (Cam Kutu Otonomi, Kapsam K) · **Durum:** PLANLANDI — Epik F3-E2'nin ikinci görevi, F3-T4'ten (Ajan Aksiyon Kayıt Defteri) sonra gelir. Mimari karar `docs/adr/ADR-0039-otonomi-kadrani.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** Epik F3-E1 (F3-T1/ADR-0035, F3-T2/ADR-0036, F3-T3/ADR-0037) TAMAMEN kapandı. F3-T4/ADR-0038 (Ajan Aksiyon Kayıt Defteri) TAMAMEN kapandı, PR #220-#223 `main`'e merge edildi — bu görev `AgentActionRecordsService`'in `'autonomous'` provenance şeklini DEĞİŞTİRMEDEN ikinci bir çağıran olarak kullanır.

## Amaç

Bugün `docs/PLAN.md` satır 282'nin vaat ettiği üç kademe (öner/onayla-yap/yap-bildir) yok — her `ProposedAction` her zaman "öner" davranır: bir insan `decide()` çağırana kadar bekler. Bu görev, `(workspaceId, actionType)` başına ayarlanabilen bir otonomi kadranı ekler: **öner** (bugünkü davranış, değişmez), **onayla-yap** (sistem `decide()`'ı otomatik çağırır, `decide()`'ın kendisi tek satır değişmez), **yap-bildir** (`decide()`/`command_proposals`/`ActionsDecided` TAMAMEN atlanır, aksiyon doğrudan yürütülür ve ADR-0038'in `provenance:'autonomous'` şekliyle kaydedilir). Tasarımın tamamı `docs/adr/ADR-0039-otonomi-kadrani.md` Karar (a)-(i)'de sabitlendi; bu spec onu görev/PR/kabul-kriteri şekline çevirir.

## Kapsam

1. **Yeni `AutonomyTier`/`TaskAutonomySetting` domain tipleri** — saf tipler `packages/agent-runtime/src/autonomy-tier.ts` (+ olay şeması `autonomy-tier-events.ts`, `index.ts`'ten dışa aktarım): `AutonomyTier = 'propose'|'approve_and_act'|'act_and_notify'`, `AUTONOMY_TIER_RANK`, `isAutoDecidable`, `AUTONOMY_GOVERNANCE_FLOOR: readonly string[] = ['reconfigureAgentPermissions']`, `TaskAutonomySetting` arayüzü (ADR-0039 §a/§b/§c).
2. **Servis-katmanı ve depolama** — `apps/server/src/agent-runtime/autonomy-tier-settings.service.ts` (`AgentPermissionManifestsService`/`AgentActionRecordsService` ile AYNI dizin/bölünme deseni), `task_autonomy_settings` şeması + migration (+ down script), event-kaynaklı projeksiyon (`TaskAutonomyTierSet` olayı → satır upsert), `AutonomyTierSettingsService.set/get/list/resolveTier` — ayar yoksa `resolveTier` fail-safe `'propose'` döner (ADR-0039 §b).
3. **Yönetişim tabanı** — `AUTONOMY_GOVERNANCE_FLOOR` listesindeki action type'lar (`reconfigureAgentPermissions`) için `set(tier !== 'propose')` HER ZAMAN `ForbiddenError` fırlatır, admin dahil kimse bunu gevşetemez (ADR-0039 §c).
4. **Yönlendirme** — yeni private `routeProposedActions`, 4 `propose*` metodunun (`parse`/`proposeFromMeeting`/`proposeFromTrigger`/`proposeFromDirectMessage`) her birinde `recordProposal`'ın DOĞRUDAN çağrılmasının YERİNE geçer: kademeye göre aksiyonları `act_and_notify` (doğrudan yürüt) / `remaining` (öner+onayla-yap, `recordProposal`'a yazılır) olarak ayırır; `remaining` tamamen `approve_and_act` ise `decideAsSystem` otomatik tetiklenir (ADR-0039 §d/§g).
5. **Yap-bildir yürütme mekaniği** — `executeDecidedAction`'ın 6 durumlu switch'i özel `dispatchExecute(workspaceId, action, actor, callerRole, causationEventId)`'a çıkarılır; `executeAutonomousAction` bunu `actor=AUTONOMY_DIAL_ACTOR`, `causationEventId=null` ile çağırır, `command_proposals`/`decide()`/`ActionsDecided`'a HİÇ uğramaz, sonucu ADR-0038'in AYNI `'autonomous'` provenance şekliyle ledger'a yazar (ADR-0039 §e).
6. **Onayla-yap yürütme mekaniği** — `decideAsSystem`, `decide()`'ın (satır değişmeden) ince bir sarmalayıcısı: `actor=AUTONOMY_DIAL_ACTOR` ile gerçek `decide()`'ı çağırır, `ActionsDecided` olayı ÜRETİLİR (ADR-0039 §f).
7. **Karma-kademe geri düşüş** — tek bir `parse()` (veya `proposeFromMeeting`/`proposeFromTrigger`) çağrısından `propose` ile `approve_and_act` karışık gelirse `remaining` TAMAMEN pending kalır, kısmi otomatik-karar YOK (ADR-0039 §g).
8. **Bildirim** — `notifyAutonomousAction`, `sourceObjectId` tanımlıysa `CommentsService.create(workspaceId, AUTONOMY_DIAL_ACTOR, 'member', {objectId: sourceObjectId, body: <sabit şablon>})` ile `MentionActionWorker`'ın reply-comment desenini birebir yansıtır; `sourceObjectId` tanımsızsa bildirim atlanır (ledger tek iz kalır), best-effort — asla gerçek mutasyonu/ledger'ı etkilemez (ADR-0039 §h).
9. **RBAC** — ayar yazma (`set`) admin+ (governance-floor action type'lar için admin bile reddedilir); ayar okuma (`get`/`list`) member+; controller yalnızca `GET`/`PUT` (ADR-0039 §i).
10. **Frontend** — küçük bir ayar paneli (workspace admin'in her actionType için kademe seçebileceği, `AgentDirectoryPanel.tsx`/`FlightRecorderPanel.tsx`'in konvansiyonlarını izleyen — bu sefer salt-okunur DEĞİL, gerçek bir düzenleme UI'ı), `useTaskAutonomySettingsQuery`/mutation hook'u, `apiClient.ts` eklentisi.

## 3 Bağlayıcı İnsan Kararı

- **Karma-kademe muhafazakâr geri düşüş.** Tek bir `parse()` (veya `proposeFromMeeting`/`proposeFromTrigger`) çağrısından `propose`+`approve_and_act` karışık bir grup gelirse TÜM grup pending kalır — kısmi otomatik-karar İCAT EDİLMEZ; `decide()`'ın kendisini "kısmi karar" kavramına genişletmek veya tek `ActionsProposed` olayını iki satıra bölmek AÇIKÇA reddedildi (ADR-0039 Karar g, Alternatifler).
- **Yap-bildir'in `decide()`'ı TAMAMEN atlaması.** Yap-bildir kademesindeki bir aksiyon `command_proposals`'a hiç yazılmaz, `decide()` hiç çağrılmaz, `ActionsDecided` hiç üretilmez — bu, onayla-yap'tan (hâlâ `decide()`'ı kullanan) ayırt edici TEK özelliktir; yap-bildir'i de `decideAsSystem` üzerinden yürütüp "bildirimi" bir son-adım yan etkisi yapmak AÇIKÇA reddedildi (ADR-0039 Karar e, Alternatifler).
- **Salt-okunur değil, gerçek bir ayar paneli dahil edilir.** F3-T4'ün "Uçuş Kayıt Cihazı"nın aksine bu panel workspace admin'inin gerçekten kademe DEĞİŞTİREBİLDİĞİ bir UI'dır (yalnızca görüntüleme değil) — kadranın kendisi bir kullanıcı ayarı olduğu için işlevsiz kalırdı.

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0039-otonomi-kadrani.md` Karar (a)-(i) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Yerleşim:** Saf tipler `packages/agent-runtime/`'a yeni dosyalar olarak eklenir, yeni paket AÇILMAZ; servis-katmanı `apps/server/src/agent-runtime/`'a eklenir — ADR-0038'in AYNI ikili bölünme deseni, üçüncü kez tekrarı.
- **(b) Şekil:** `AutonomyTier`/`TaskAutonomySetting` event-kaynaklı, `(workspaceId, actionType)` deterministik-anahtarlı; ayar yoksa fail-safe varsayılan `'propose'`.
- **(c) Yönetişim tabanı:** `reconfigureAgentPermissions` kadrana HİÇBİR ZAMAN tabi değil — `AUTONOMY_GOVERNANCE_FLOOR`, mimarinin KENDİ çıkarımı (ADR-0037 §f'nin "decide() tek boğaz noktası" kararından türetildi, insan tarafından dikte edilmedi, gelecekte ayrı bir kararla gevşetilebilir).
- **(d) Yönlendirme:** Yeni `routeProposedActions`, 4 `propose*` metodunun HER BİRİNDE `recordProposal`'ın YERİNE geçer; `act_and_notify` aksiyonlar `recordProposal`'a ULAŞMADAN ÖNCE gruptan çıkarılır; `remaining` HER ZAMAN `recordProposal`'a yazılır (parse()'ın "her çağrıda tam bir `ActionsProposed`" değişmezi korunur); `CommandsServiceParseResult`'a yalnızca opsiyonel `autonomousResults` alanı eklenir.
- **(e) Yap-bildir mekaniği:** `dispatchExecute` (6 durumlu switch çıkarımı) hem `executeDecidedAction` hem `executeAutonomousAction` tarafından çağrılır; `executeAutonomousAction` `AUTONOMY_DIAL_ACTOR`/`causationEventId:null` ile ADR-0038'in AYNI `'autonomous'` ledger şeklini kullanır.
- **(f) Onayla-yap mekaniği:** `decideAsSystem`, `decide()`'ın ince sarmalayıcısı — `decide()`'ın kendi mantığı (tek-kez-decidedAt, dallanma, olay yazımı, ledger) HİÇ tekrarlanmaz/yeniden açılmaz.
- **(g) Karma-kademe:** Yalnızca `remaining` TAMAMEN `approve_and_act` ise (içinde tek bir `propose` bile yoksa) `decideAsSystem` tetiklenir; aksi halde `remaining` tamamen insan kararını bekler.
- **(h) Bildirim:** `sourceObjectId`-kapsamlı yorum, `MentionActionWorker`'ın reply-comment deseni birebir, best-effort, yeni bir bildirim alt sistemi İCAT EDİLMEDEN; kaynak-nesnesiz durumlarda atlanır.
- **(i) RBAC:** Yazma (`set`) admin+ (governance-floor için admin bile reddedilir); okuma (`get`/`list`) member+.

**RBAC özeti:** Ayar okuma (`get`/`list`) = member+; ayar yazma (`set`) = admin+ (governance-floor action type'lar için admin bile reddedilir); `routeProposedActions`/`executeAutonomousAction`/`decideAsSystem`'ın kendi HTTP uç noktası YOK — yalnızca `parse()`/`proposeFromMeeting()`/`proposeFromTrigger()`/`proposeFromDirectMessage()` üzerinden dolaylı tetiklenir.

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar)

1. **PR1 — Domain + ayar altyapısı (backend).** `packages/agent-runtime/src/autonomy-tier.ts` (+ `autonomy-tier-events.ts`, olay şeması) — `AutonomyTier`/`TaskAutonomySetting`/`AUTONOMY_TIER_RANK`/`isAutoDecidable`/`AUTONOMY_GOVERNANCE_FLOOR`; `apps/server/src/db/schema/task-autonomy-settings.ts` şeması + migration (+ down script); `AutonomyTierSettingsService` (`set`/`get`/`list`/`resolveTier`, deterministik `streamId`); yalnızca `GET`+`PUT` controller; module kablolaması. Integration testler: RBAC (`set` admin+/`get`+`list` member+), `resolveTier` varsayılan `'propose'`, governance-floor `ForbiddenError`.
2. **PR2 — `CommandsService` kablolaması.** `dispatchExecute` çıkarımı (switch tek yere), `executeAutonomousAction`, `decideAsSystem`, `routeProposedActions` (4 `propose*` metodunun hepsini kablolar), `recordAutonomousLedgerEntry`, `notifyAutonomousAction`, `CommandsServiceParseResult`'a opsiyonel `autonomousResults` alanı. Integration testler: öner-kademesi regresyon (davranış DEĞİŞMEZ), onayla-yap (`ActionsDecided` otomatik üretilir, ledger actor=`AUTONOMY_DIAL_ACTOR`/provenance=`'decided'`), yap-bildir (`command_proposals`'a HİÇ satır yazılmaz, ledger provenance=`'autonomous'`/causationEventId=null), karma-kademe (TAMAMEN pending), governance-floor'un hiçbir kademe ayarıyla atlatılamadığı.
3. **PR3 — Frontend.** Ayar paneli (`AgentDirectoryPanel.tsx`/`FlightRecorderPanel.tsx` konvansiyonları, gerçek düzenleme UI'ı) + `useTaskAutonomySettingsQuery`/mutation hook'u + `apiClient.ts` eklentisi + `App.tsx` kablolaması. Testler: panel yalnızca admin+ için düzenlenebilir, member için salt-okunur/gizli.

## Kapsam Dışı

- **Per-agent granularite** — kadran yalnızca `(workspaceId, actionType)` başına, agent bazında DEĞİL (insan tarafından seçildi).
- **`MentionActionWorker`'ın MEVCUT otonom yolunun bu kadrana tabi kılınması** — kasıtlı, ayrı bırakıldı; bu görev yalnızca `CommandsService`'in 4 `propose*` yolunu kablolar.
- **`decide()`'ın kendisinin kısmi-karar semantiğine genişletilmesi** — ADR-0037'nin tek-boğaz-noktası/tek-atış davranışını YENİDEN AÇAR, bu ADR'nin kapsamı DIŞINDA.
- **Yeni bir bildirim alt sistemi** — `CommentsService.create`'in ZATEN kurulu reply-comment deseni yeterli.
- **`parse()`'ın `_actor` parametresinin tüketilmesi** — F1-T16'dan beri açık kalan genişletme noktası, bu görevde de kapanmıyor.
- **Rollback/undo yürütme** — F3-T6'nın kapsamı.

## Kabul Kriterleri

- [ ] **PR1:** `AutonomyTierSettingsService.resolveTier` ayar bulunamadığında varsayılan `'propose'` döner.
- [ ] **PR1:** `AutonomyTierSettingsService.set`, `AUTONOMY_GOVERNANCE_FLOOR` listesindeki bir action type için `tier !== 'propose'` isteğini admin dahil HERKESE `ForbiddenError` ile reddeder.
- [ ] **PR1:** RBAC doğrulanır — `set` admin+ (member/guest reddedilir), `get`/`list` member+ (guest reddedilir); `task_autonomy_settings` migration'ının down script'i mevcut ve geri-alma test edilmiş.
- [ ] **PR2:** Öner kademesinde (ayar yok veya `'propose'`) davranış BUGÜNKÜYLE AYNIDIR — regresyon testiyle kanıtlanır (aksiyon `command_proposals`'a yazılır, `decide()` insan çağırana kadar bekler).
- [ ] **PR2:** Onayla-yap kademesinde `ActionsDecided` olayı OTOMATİK üretilir; ledger'da `actor:AUTONOMY_DIAL_ACTOR`, `provenance:'decided'` görünür.
- [ ] **PR2:** Yap-bildir kademesinde `command_proposals`'a HİÇ satır yazılmadığı doğrulanır; ledger'da `provenance:'autonomous'`, `causationEventId:null` görünür.
- [ ] **PR2:** Karma-kademe (tek `parse()` çağrısında `propose`+`approve_and_act` karışık) grubun TAMAMEN pending kaldığı, hiçbir kısmi otomatik-kararın verilmediği doğrulanır.
- [ ] **PR2:** `reconfigureAgentPermissions` için hiçbir kademe ayarının `decide()`'ı atlatamadığı (her zaman `'propose'` çözümlendiği, `executeAutonomousAction`/`decideAsSystem`'a hiç girmediği) doğrulanır.
- [ ] **PR2:** Bildirim best-effort'tur — `sourceObjectId` tanımsızken atlanır, `CommentsService.create` hata fırlatsa bile asıl mutasyon/ledger etkilenmez.
- [ ] **PR3:** Ayar paneli salt-okunur DEĞİLDİR (gerçek bir kademe seçme/kaydetme UI'ı), ama yalnızca admin+ için düzenlenebilir olduğu doğrulanır (member görüntüler ama düzenleyemez veya panel gizlenir).
- [ ] Her PR'da `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil (PR3 ayrıca `@luminaos/web` için).
- [ ] `security-reviewer` her PR'da çağrılır ve bulgu kapatılmadan bir sonraki PR'a geçilmez (özellikle PR2: governance-floor'un gerçekten atlatılamaz olduğu, ledger-yazım/bildirim hatasının gerçek aksiyonu bozmadığı).

## Açık Sorular

Bu görev için gerçekten açık bir soru yok — ADR-0039 Bağlam/Karar/Alternatifler bölümleri tüm tasarım kararlarını (yerleşim, şekil, yönetişim tabanı, yönlendirme, iki otomatik-kademe mekaniği, karma-kademe geri düşüşü, bildirim, RBAC) çözdü. ADR'nin "Sonuçlar/Ödünler" bölümünün açıkça gelecekteki genişletme noktası olarak işaretlediği, bu görevi BLOKE ETMEYEN kalemler ayrı bir gelecekteki karara ERTELENMİŞTİR:

- Karma-kademeli gruplar için kısmi otomatik-karar (gerçek bir ihtiyaç doğarsa `decide()`'ın kısmi-karar semantiğine genişletilmesi, ayrı bir ADR gerektirir).
- `parse()`'ın `_actor`'ının gerçekten tüketilmesi (DM-tabanlı bildirim kanalı).
- `reconfigureAgentPermissions`'ın kadrana tabi kılınması (governance-floor'un gevşetilmesi, ayrı bir karar/ADR gerektirir).

## Sıradaki adım

```
docs/adr/ADR-0039-otonomi-kadrani.md'deki Karar (a)-(i)'yi ve
docs/specs/F3-E2/F3-T5-otonomi-kadrani.md'nin Kabul Kriterleri'ni temel alarak, F3-T5
PR1 (packages/agent-runtime saf domain: AutonomyTier/TaskAutonomySetting tipleri,
TaskAutonomyTierSet olay şeması, task_autonomy_settings tablosu + migration,
AutonomyTierSettingsService set/get/list/resolveTier) için test-writer ile başarısız
testleri yaz.
```
