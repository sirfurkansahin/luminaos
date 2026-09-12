# F3-T13 — Bildirim Bütçeleri, Bağlam-Değiştirme Sayacı, Ajan Sessiz Saatleri, Aşırı Yük → Yeniden Dengeleme Önerisi

**Epik:** F3-E5 (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]) · **Durum:** Planlandı — Epik F3-E5'in İKİNCİ ve SON görevi, F3-T12'den (Cihaz Üstü Model Köprüsü, ADR-0046) sonra gelir. Mimari karar `docs/adr/ADR-0047-bildirim-butcesi-sessiz-saatler.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** Epik F3-E2 (F3-T4/ADR-0038 Uçuş Kayıt Cihazı, F3-T5/ADR-0039 Otonomi Kadranı) TAMAMEN kapandı — bu görev `notifyAutonomousAction`'ın (`apps/server/src/commands/commands.service.ts`) ve `AutonomyTierSettingsService.get`'in (`apps/server/src/agent-runtime/autonomy-tier-settings.service.ts`) ZATEN kurulu şekillerini DEĞİŞTİRMEDEN üzerine bir kapı ekler.

## Amaç

Bugün `notifyAutonomousAction` (ADR-0039 §h) her `act_and_notify` aksiyonu için `sourceObjectId` tanımlıysa KOŞULSUZ bir bildirim yorumu yazar — ne bir bütçe, ne sessiz saat, ne "bu kullanıcı çok fazla kesintiye uğruyor" sinyali var. Bu görev, `docs/PLAN.md` satır 299'un vaat ettiği dört unsuru ekler: **bildirim bütçesi** (kayan pencere başına izin verilen toplam bildirim sayısı), **bağlam-değiştirme sayacı** (gerçekten teslim edilmiş bildirim sayısı — kesinti ölçüsü), **ajan sessiz saatleri** (belirli UTC-saat aralığında bildirim teslimatının bastırılması, ajanın kendi çalışmasının DEĞİL), **aşırı yük sinyali → yeniden dengeleme önerisi** (bütçe dolduğunda `AutonomyTierPanel`'de en çok bildirim üreten aksiyon tipini işaret eden pasif bir öneri). Tasarımın tamamı `docs/adr/ADR-0047-bildirim-butcesi-sessiz-saatler.md` Karar (a)-(i)'de sabitlendi; bu spec onu görev/PR/kabul-kriteri şekline çevirir.

## Kapsam

1. **Yeni `NotificationPreference`/`NotificationDeliveryRecord` domain tipleri** — saf tipler `packages/agent-runtime/src/notification-preference.ts` + `notification-delivery-record.ts` (+ olay şemaları `notification-preference-events.ts`/`notification-delivery-events.ts`, `index.ts`'ten dışa aktarım): `QuietHoursWindow{startHourUtc,endHourUtc}`, `NotificationPreference{id,workspaceId,userId,notificationBudgetPerWindow,quietHours,updatedAt}`, `NotificationDeliveryOutcome='delivered'|'suppressed_quiet_hours'|'suppressed_budget_exceeded'`, `NotificationDeliveryRecord` (ADR-0047 §a/§b/§d).
2. **Servis-katmanı ve depolama** — `apps/server/src/agent-runtime/notification-preferences.service.ts` (`set`/`get`/`resolvePreference`, self-RBAC), `apps/server/src/agent-runtime/agent-notification-governor.service.ts` (`guardAndDeliver`/`getUsageSummary`), `agent_notification_preferences`/`agent_notification_deliveries` şemaları + TEK migration (+ down script), event-kaynaklı projeksiyonlar (ADR-0047 §a/§d, Somut Şekiller).
3. **Ayar YOKSA fail-open** — `resolvePreference` satır bulunamazsa `null` döner, `guardAndDeliver` bugünkü (kısıtsız) davranışı AYNEN korur (ADR-0047 §b).
4. **Alıcı çözümleme** — `AutonomyTierSettingsService.get(workspaceId, actionType).updatedBy` `{type:'user',id}` DEĞİLSE fail-open (ADR-0047 §c).
5. **Bağlam-değiştirme sayacı** — YALNIZCA `AgentNotificationDelivered` olayları sayılır, `AgentNotificationSuppressed` HARİÇ (ADR-0047 §d).
6. **Sessiz saat davranışı** — bastırılan bildirim TAMAMEN düşer, sessiz saat bitince ERTELENMİŞ olarak da gönderilmez; yalnızca `AgentNotificationSuppressed{reason:'quiet_hours'}` kaydedilir (ADR-0047 §e).
7. **Bütçe + aşırı yük sinyali** — kayan pencere içinde `deliveredCount >= notificationBudgetPerWindow` olduğunda sonraki teslimler `suppressed_budget_exceeded` olarak bastırılır; `getUsageSummary` `overloaded`/`topActionType`'ı CANLI hesaplar, kalıcı bir "sinyal" satırı YAZILMAZ (ADR-0047 §f).
8. **Yeniden dengeleme önerisi (frontend)** — `AutonomyTierPanel.tsx`'e `overloaded===true` iken `data-testid="autonomy-rebalance-suggestion"` banner'ı eklenir, "hemen uygula" butonu YOK (ADR-0047 §g).
9. **`notifyAutonomousAction` entegrasyonu** — mevcut `commentsService.create` çağrısı `guardAndDeliver`'ın `deliver` callback'ine sarılır; `sourceObjectId===undefined` erken-dönüşü ve mevcut try/catch DEĞİŞMEZ (ADR-0047 §h).
10. **RBAC** — `set` self-only (admin istisnası YOK); `get`/`getUsageSummary` self VEYA admin+ (ADR-0047 §i).
11. **Frontend** — `NotificationPreferencesPanel.tsx` (kişisel bütçe/sessiz-saat formu) + `useNotificationPreferenceQuery`/mutation + `useNotificationUsageSummaryQuery` hook'ları + `apiClient.ts` eklentisi.

## 3 Bağlayıcı İnsan Kararı

- **Yeniden dengeleme önerisi YALNIZCA pasif.** Sistem `AutonomyTierSettingsService.set()`'i KENDİ BAŞINA çağırmaz; yalnızca öneri gösterilir, kullanıcı mevcut panel üzerinden manuel değiştirir — bir "ajan aksiyonu" DEĞİL, `{niyet,gerekçe,kaynaklar,geri_alma_planı}` sözleşmesini TETİKLEMEZ (ADR-0047 Karar g/1).
- **Ajan sessiz saatleri YALNIZCA bildirim teslimini susturur.** Ajan kendi otonomi kademesine göre çalışmaya devam eder; yalnızca `notifyAutonomousAction`'ın yorum-yazma adımı bastırılır (ADR-0047 Karar e/2).
- **Ayar kapsamı KULLANICI BAŞINA.** `(workspaceId, userId)` anahtarlı kişisel tercih, `TaskAutonomySetting`'in `(workspaceId, actionType)` deseninden AYRI (ADR-0047 Karar b/3).

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0047-bildirim-butcesi-sessiz-saatler.md` Karar (a)-(i) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Yerleşim:** Saf tipler `packages/agent-runtime/`'a yeni dosyalar; servis-katmanı `apps/server/src/agent-runtime/`'a — ADR-0038/0039'un AYNI ikili bölünme deseni.
- **(b) Şekil:** `NotificationPreference` event-kaynaklı, `(workspaceId,userId)` anahtarlı; ayar yoksa FAIL-OPEN (ADR-0039'un fail-safe kutbunun bilinçli tersi — yeni kısıtlama, isteğe bağlı).
- **(c) Alıcı:** `TaskAutonomySetting.updatedBy` — yeni bir "sahip/atanmış" çözümleme mantığı İCAT EDİLMEDEN.
- **(d) Sayaç:** Yalnızca `AgentNotificationDelivered`; bastırılanlar hariç.
- **(e) Sessiz saat:** Tamamen düşer, ertelenmez — yeni kuyruk/worker altyapısı gerektirmeden.
- **(f) Bütçe/aşırı yük:** Kayan pencere, agrege sayım, canlı `overloaded`/`topActionType` — kalıcı sinyal satırı YOK.
- **(g) Öneri UI:** `AutonomyTierPanel.tsx`'e banner, "uygula" butonu YOK.
- **(h) Entegrasyon:** `notifyAutonomousAction`'ın `commentsService.create` çağrısı `guardAndDeliver`'a sarılır; ledger/`dispatchExecute` DEĞİŞMEZ.
- **(i) RBAC:** `set` self-only; `get`/`getUsageSummary` self veya admin+.

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar — mimari-kritik, her PR ±400 satır sınırını hedefler)

1. **PR1 — Domain + tercih altyapısı (backend).** `packages/agent-runtime/src/notification-preference.ts` + `notification-delivery-record.ts` (+ olay şemaları); `apps/server/src/db/schema/agent-notification-preferences.ts` + `agent-notification-deliveries.ts` şemaları + TEK migration `0046_agent_notification_governor.sql` (+ down); `NotificationPreferencesService` (`set`/`get`/`resolvePreference`, deterministik `streamId`); `env.agentNotificationBudgetWindowMs`. Yalnızca `GET`+`PUT` controller (kendi tercihi). Integration testler: RBAC (`set` self-only/admin dahil reddedilir, `get` self-veya-admin), `resolvePreference` satır yoksa `null`, migration down script'i test edilmiş.
2. **PR2 — `AgentNotificationGovernorService` + `CommandsService` kablolaması.** `guardAndDeliver`/`countDeliveredInWindow`/`isWithinQuietHours`/`recordOutcome`/`getUsageSummary`; `CommandsService.notifyAutonomousAction`'ın `guardAndDeliver`'ı sarması. Integration testler: fail-open (ayar yok / `updatedBy.type!=='user'`), sessiz saat bastırması (`AgentNotificationSuppressed{reason:'quiet_hours'}`, gece-yarısı-sarma dahil), bütçe aşımı bastırması (`suppressed_budget_exceeded`), teslim başarılı (`AgentNotificationDelivered`, sayaç yalnızca bunu sayar), `sourceObjectId===undefined` erken-dönüşü DEĞİŞMEDİĞİ, gerçek mutasyon/ledger'ın bildirim hatasından ETKİLENMEDİĞİ (mevcut best-effort try/catch regresyonu).
3. **PR3 — Frontend.** `NotificationPreferencesPanel.tsx` (bütçe sayı-girişi + sessiz-saat başlangıç/bitiş seçicisi) + `AutonomyTierPanel.tsx`'e `autonomy-rebalance-suggestion` banner'ı + `useNotificationPreferenceQuery`/mutation + `useNotificationUsageSummaryQuery` hook'ları + `apiClient.ts` eklentisi + `App.tsx` kablolaması. Testler: banner yalnızca `overloaded===true` iken görünür, `topActionType` etiketi `ACTION_REGISTRY`'den doğru okunuyor, banner'da hiçbir mutasyon-tetikleyen buton YOK.

## Kapsam Dışı

- **Sessiz saatte bastırılan bildirimlerin kuyruğa alınıp sonra (toplu/gecikmeli) teslim edilmesi** — yeni bir kuyruk/worker altyapısı gerektirirdi, bilinçli olarak reddedildi (ADR-0047 §e).
- **ActionType-başına ayrı bütçe** — v0 yalnızca agrege (workspace-genelinde tek sayı) bütçe (ADR-0047 §f/Alternatifler).
- **Kullanıcı-başına saat dilimi** — sessiz saatler yalnızca UTC-saat (ADR-0047 §b, Bilinen Sınırlamalar).
- **Otomatik otonomi-kademesi değişikliği** — öneri YALNIZCA pasif, `AutonomyTierSettingsService.set()` sistem tarafından ASLA çağrılmaz (insan kararı 1).
- **Workspace-genelinde ayar** — tercih yalnızca `(workspaceId, userId)` kişisel (insan kararı 3).
- **AI-üretimli bildirim içeriği** — mevcut sabit şablon (ADR-0039 §h) DEĞİŞMEZ.
- **Yeni bir genel-amaçlı notification/delivery altyapısı** — yalnızca mevcut `CommentsService.create` reply-comment mekanizmasının ÜZERİNE bütçe/sessiz-saat kapısı eklenir.

## Kabul Kriterleri

- [ ] **PR1:** `NotificationPreferencesService.resolvePreference` ayar bulunamadığında `null` döner (fail-open, budget/quiet-hours kontrolü hiç yapılmaz).
- [ ] **PR1:** `NotificationPreferencesService.set`, çağıran `actor.id !== userId` olduğunda ADMIN DAHİL herkese `ForbiddenError` fırlatır (self-only, admin istisnası YOK).
- [ ] **PR1:** `NotificationPreferencesService.get`, `requestingUserId !== userId` VE çağıran admin+ DEĞİLSE `ForbiddenError` fırlatır; admin+ başka bir kullanıcının tercihini OKUYABİLİR.
- [ ] **PR1:** `agent_notification_preferences`/`agent_notification_deliveries` migration'ının down script'i mevcut ve geri-alma test edilmiş.
- [ ] **PR2:** `updatedBy.type !== 'user'` veya `NotificationPreference` satırı yoksa `guardAndDeliver` bugünküyle AYNI şekilde koşulsuz teslim eder (regresyon testi).
- [ ] **PR2:** Şu anki UTC saat kullanıcının `quietHours` aralığındaysa (gece-yarısı-saran aralık dahil, ör. 22→07) bildirim `suppressed_quiet_hours` olarak bastırılır, `CommentsService.create` HİÇ ÇAĞRILMAZ.
- [ ] **PR2:** Kayan pencere içinde `deliveredCount >= notificationBudgetPerWindow` olduğunda sonraki teslim `suppressed_budget_exceeded` olarak bastırılır.
- [ ] **PR2:** Başarılı bir teslimde `AgentNotificationDelivered` kaydedilir VE bağlam-değiştirme sayacı (`getUsageSummary().deliveredCountInWindow`) yalnızca bunu sayar — bastırılan kayıtlar sayaca dahil EDİLMEZ.
- [ ] **PR2:** `sourceObjectId===undefined` durumunda `notifyAutonomousAction` governor'a hiç ULAŞMADAN (mevcut ADR-0039 davranışı) erken döner.
- [ ] **PR2:** Governor/kayıt hatası gerçek aksiyonun yürütülmesini/ledger yazımını ETKİLEMEZ (best-effort regresyonu).
- [ ] **PR3:** `AutonomyTierPanel.tsx`'teki `autonomy-rebalance-suggestion` banner'ı yalnızca `overloaded===true` iken render edilir, `topActionType`'ın etiketi `ACTION_REGISTRY`'den doğru okunur; banner içinde `AutonomyTierSettingsService.set`'i tetikleyen HİÇBİR buton YOKTUR.
- [ ] Her PR'da `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil (PR3 ayrıca `@luminaos/web` için).
- [ ] `security-reviewer` her PR'da çağrılır ve bulgu kapatılmadan bir sonraki PR'a geçilmez (özellikle PR2: self-only RBAC'ın gerçekten admin'i bile reddettiği, `guardAndDeliver`'ın gerçek mutasyonu/ledger'ı asla etkilemediği).
- [ ] Spec dosyasına Done + PR linkleri işlendi.

## Açık Sorular

Gerçek bir açık soru yok — ADR-0047 Bağlam/Karar/Alternatifler bölümleri tüm tasarım kararlarını (yerleşim, şekil, alıcı çözümleme, sayaç tanımı, sessiz-saat akıbeti, bütçe/aşırı-yük hesaplama, öneri sunumu, entegrasyon noktası, RBAC) çözdü. ADR'nin "Bilinen Sınırlamalar" bölümünün açıkça gelecekteki genişletme noktası olarak işaretlediği, bu görevi BLOKE ETMEYEN kalemler ayrı bir gelecekteki karara ERTELENMİŞTİR:

- Sessiz saatte bastırılan bildirimlerin toplulaştırılıp sonra teslim edilmesi (PLAN.md §7 madde 6'nın "toplulaştırma" vizyonunun tam gerçekleştirilmesi).
- ActionType-başına ayrı bütçe.
- Kullanıcı-başına saat dilimi farkındalığı (bugün yalnızca UTC-saat).

## Sıradaki adım

```
docs/PLAN.md'nin FAZ 3 sıralamasına göre F3-T13 kapanınca Epik F3-E5 (Hibrit AI +
Refah Katmanı) TAMAMEN kapanmış olacak; sıradaki görev F3-T14 — Epik F3-E6
(Federatif Beyin v0, Kapsam Q)'nın TEK ve son görevi: "Kurumlar arası paylaşılan
proje alanı: yalnız o kapsamda ortak bellek/bağlam; çift taraflı denetim günlüğü."
Bu görev CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür" VE "hassas veri
sınıfları buluta ham gönderilmez" Mimari Değişmezlerine doğrudan dokunduğu için
koddan önce bir ADR zorunlu: önce explorer ile mevcut workspace-izolasyon modelini
(bugün tüm event/projeksiyon sorguları TEK workspaceId'ye kapsamlı) VE
packages/memory'nin erişim-politikası şeklini keşfet, sonra architect ile
docs/adr/ADR-0048-federatif-beyin-v0.md taslağını VE
docs/specs/F3-E6/F3-T14-federatif-beyin-v0.md spec dosyasını oluştur, insana
onaylat; sonra plan mode'a geç.
```
