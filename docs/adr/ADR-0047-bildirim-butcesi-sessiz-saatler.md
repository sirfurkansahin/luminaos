# ADR-0047: Bildirim Bütçesi + Bağlam-Değiştirme Sayacı + Ajan Sessiz Saatleri + Aşırı Yük → Yeniden Dengeleme Önerisi (Epik F3-E5'in Kapanış Görevi)

**Durum:** Kabul edildi (3 bağlayıcı insan kararı Plan Mode oturumunda `AskUserQuestion` ile alındı — bu ADR onları icat etmiyor, aynen kayıt altına alıp somutlaştırıyor; aşağıdaki (a)-(i) maddelerinin kalan tasarım detayları mimarinin kendi sorumluluğu, CLAUDE.md "Çalışma Ritüeli")
**Tarih:** 2026-09-13
**İlgili görev:** [F3-T13 — Bildirim bütçeleri, bağlam-değiştirme sayacı, ajan sessiz saatleri, aşırı yük sinyali → yeniden dengeleme önerisi](../specs/F3-E5/F3-T13-bildirim-butcesi-sessiz-saatler.md). `docs/PLAN.md` satır 299 — Epik F3-E5'in (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]) İKİNCİ ve SON görevi, F3-T12'den (ADR-0046, Cihaz Üstü Model Köprüsü) sonra.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin ikinci fıkrasını tetikliyor — bu görev `ADR-0039`'un ZATEN kurduğu `notifyAutonomousAction` çağrı noktasının ÖNÜNE, birden fazla gelecekteki `act_and_notify` tüketicisine dayatılan yeni bir veri şekli (`NotificationPreference`, `(workspaceId, userId)` kişisel-tercih sözleşmesi) ve iki yeni olay tipi ekliyor.

> Bu ADR, ADR-0038'in (Uçuş Kayıt Cihazı) ve ADR-0039'un (Otonomi Kadranı) doğrudan devamıdır. ADR-0039 §h zaten şunu sabitlemişti: _"Yeni, genel bir 'Notification' alt sistemi inşa etmek. Reddedildi — `MentionActionWorker`'ın ZATEN kurduğu `CommentsService.create` reply-comment deseni tek gerçek ihtiyacı karşılıyor; ikinci bir gerçek tüketici olmadan önden mühendislik olurdu."_ **Bu ADR o reddi YENİDEN AÇMAZ** — `notifyAutonomousAction`'ın `CommentsService.create` reply-comment mekanizması BİREBİR korunur; bu ADR yalnızca o TEK çağrı noktasının ÖNÜNE bir bütçe/sessiz-saat KAPISI ekler. `docs/PLAN.md` §7 madde 6'nın ("Sakin Yazılım [P]: Bildirim = bütçeli kaynak... bütçe aşımında toplulaştırılır") vizyon notundaki "toplulaştırma" (aggregation/batching) bilinçli olarak bu ADR'nin kapsamı DIŞINDA bırakılıyor — bkz. Alternatifler; bu, mimariyi görevlendiren oturumun kendisinin ("Kapsam dışı: ... yeni bir genel-amaçlı notification/delivery altyapısı") zaten çizdiği sınırın doğrudan sonucu.

## Bağlam

`explorer`'ın doğruladığı bulgular (tekrar teyit edildi):

1. **Genel bir bildirim/alert alt sistemi YOK.** Tek "notify" ilkesi `CommandsService.notifyAutonomousAction` (`apps/server/src/commands/commands.service.ts:660-680`) — `AUTONOMY_DIAL_ACTOR` ile `sourceObjectId` üzerine bir yanıt-yorumu yazar (`this.commentsService.create(...)`), `executeAutonomousAction`'ın (yap-bildir kademesi) TEK çağıranı. `sourceObjectId` tanımsızsa best-effort atlanır; yorum yazımı hata verirse asıl mutasyon/ledger etkilenmez (ADR-0039 §h, kod satır 665-679'da doğrulandı).
2. **Ajan telemetrisi bugün ya bloklar ya denetler, hiçbir zaman öneri üretmez.** `AgentResourceLimitsService.assertActionRateNotExceeded` (`apps/server/src/agent-runtime/agent-resource-limits.service.ts:128-150`) DB-destekli bir SAYIM sorgusuyla (`agent_action_executions`, trailing `env.agentActionRateLimitWindowMs` penceresi) aşımda `QuotaExceededError` FIRLATIR — bu ADR'nin "bütçe" kavramına en yakın YAPISAL emsal, ama tamamen FARKLI bir eksende (ajan-başına hız sınırı, kullanıcı-başına bildirim bütçesi DEĞİL) ve tamamen farklı bir sonuç (sert red, pasif öneri DEĞİL). `AgentActionRecordsService` (ADR-0038, Flight Recorder) her karar/otonom aksiyonu `{intent,rationale,resources,rollbackPlan,outcome,provenance}` ile kaydeden bir DENETİM defteri — canlı sayaç/agregasyon/eşik mantığı YOK.
3. **ADR-0039'un otonomi kadranı zaten `(workspaceId, actionType)` başına `TaskAutonomySetting` tutuyor**, `updatedBy: Actor` alanıyla — bu alan "bu action type'ı `act_and_notify`'a kim çevirdi" sorusunun HALİHAZIRDA var olan, deterministik cevabı (`AutonomyTierSettingsService.get`, `apps/server/src/agent-runtime/autonomy-tier-settings.service.ts:128-141`). Bu ADR'nin (c) Kararı bu alanı YENİDEN KULLANIR — yeni bir "kime bildirilecek" çözümleme mantığı İCAT EDİLMEZ.
4. **Hibrit AI (ADR-0029/ADR-0046) ile veri-akışı kesişimi YOK** — bildirim içerikleri AI-üretimli DEĞİL, bu görev kapsamında böyle bir şey talep edilmedi; bu ADR hiçbir AI-sağlayıcı çağrısına dokunmuz.

**Plan Mode oturumunda alınan 3 bağlayıcı insan kararı (aynen kayıt altına alınıyor, bu ADR onları icat etmiyor):**

1. **Yeniden dengeleme önerisi YALNIZCA PASİF.** Sistem `AutonomyTierSettingsService.set()`'i KENDİ BAŞINA çağırmaz; yalnızca bir öneri/rozet gösterir, kullanıcı ZATEN VAR OLAN `AutonomyTierPanel` üzerinden manuel değiştirir. Bu nedenle bu öneri bir "ajan aksiyonu" DEĞİLDİR, `{niyet,gerekçe,kaynaklar,geri_alma_planı}` sözleşmesini TETİKLEMEZ.
2. **Ajan sessiz saatleri YALNIZCA bildirim TESLİMİNİ susturur.** Ajanın kendi otonomi kademesine göre çalışması DEVAM EDER (iş durmaz) — yalnızca `notifyAutonomousAction`'ın yorum-yazma adımı ertelenir/bastırılır.
3. **Ayar kapsamı KULLANICI BAŞINA** — `(workspaceId, userId)` anahtarlı kişisel tercih, `TaskAutonomySetting`'in `(workspaceId, actionType)` deseninden AYRI, YENİ bir model.

**Çözülmesi gereken merkezi soru:** yeni verinin nerede/nasıl saklanacağı (a/b), TESLİMATIN kime (hangi `userId`) yapılacağının nasıl çözüleceği (c), "bağlam-değiştirme sayacı"nın tam olarak neyi saydığı (d), sessiz saatlerde bastırılan bildirimin akıbeti (e), "aşırı yük sinyali"nin nasıl hesaplandığı ve bütçenin ne anlama geldiği (f), önerinin nerede/nasıl yüzeye çıkacağı (g), `notifyAutonomousAction`'ın bu yeni kapıyı NASIL çağıracağı (h), RBAC (i).

## Karar

### (a) Yerleşim — ADR-0038/0039'un AYNI ikili bölünmesi ÜÇÜNCÜ/DÖRDÜNCÜ kez genişletilir

Saf tipler `packages/agent-runtime/src/notification-preference.ts` (`NotificationPreference`, `QuietHoursWindow`), `packages/agent-runtime/src/notification-delivery-record.ts` (`NotificationDeliveryOutcome`, `NotificationDeliveryRecord`) + iki olay-şeması dosyası (`notification-preference-events.ts`, `notification-delivery-events.ts`), `index.ts`'ten dışa aktarım. Servis-katmanı `apps/server/src/agent-runtime/notification-preferences.service.ts` (CRUD, self-RBAC) + `apps/server/src/agent-runtime/agent-notification-governor.service.ts` (kapı+kayıt+özet) — `AgentPermissionManifestsService`/`AgentActionRecordsService`/`AutonomyTierSettingsService` ile AYNI dizin/bölünme deseni, DÖRDÜNCÜ kez tekrarı gerekçeli: hepsi "ajan çalışma zamanı davranışı" kategorisinin bir parçası, yeni bağımsız bir paket açmak yerine.

### (b) `NotificationPreference` — event-kaynaklı, `(workspaceId, userId)` anahtarlı, ayar YOKSA fail-OPEN (ADR-0039'un fail-safe kutbunun BİLİNÇLİ TERSİ)

```ts
export interface QuietHoursWindow {
  /** UTC saat, 0-23. `endHourUtc < startHourUtc` ise pencere gece yarısını
   * SARAR (ör. 22 → 07). v0 SADECE UTC-saat — kullanıcı-başına saat dilimi
   * YOK (bilinçli basitleştirme, bkz. Bilinen Sınırlamalar). */
  startHourUtc: number;
  endHourUtc: number;
}

export interface NotificationPreference {
  id: string;
  workspaceId: string;
  userId: string;
  /** Kayan pencere (`AGENT_NOTIFICATION_BUDGET_WINDOW_MS`, sabit sistem
   * sabiti — `env.agentActionRateLimitWindowMs`'in AYNI deseni, kullanıcı
   * BAŞINA farklı pencere uzunluğu YOK, v0 basitleştirmesi) başına izin
   * verilen TOPLAM (tüm actionType'lar arasında AGREGE, actionType-başına
   * DEĞİL — bkz. Alternatifler) bildirim sayısı. */
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindow | null;
  updatedAt: Date;
}
```

**Ayar HİÇ YOKSA (satır bulunamazsa) davranış BUGÜNKÜYLE AYNIDIR: bütçe kısıtı YOK, sessiz saat YOK, her `act_and_notify` bildirimi ADR-0039 §h'nin ZATEN kurduğu şekilde doğrudan teslim edilir.** Bu, ADR-0039 §b'nin "ayar yoksa en muhafazakâr `'propose'`" fail-safe kutbunun KASITLI TERSİ — orada muhafazakârlık "otonom davranışa GİRME", burada muhafazakârlık "MEVCUT davranışı BOZMA" anlamına geliyor: bu ADR YENİ, isteğe-bağlı bir kısıtlama ekliyor, bir insan onu AÇIKÇA yapılandırmadan hiçbir kullanıcının bildirim akışı değişmemeli (CLAUDE.md "Spec'te olmayan kapsamı ekleme" ruhu — bu, kimsenin talep etmediği bir davranış değişikliğidir, isteğe bağlı bir özelliğin ta kendisi).

### (c) Alıcı çözümleme — `TaskAutonomySetting.updatedBy`, YENİ bir "kime bildirilecek" mantığı İCAT EDİLMEDEN

`AgentNotificationGovernorService`, `notifyAutonomousAction`'ın zaten sahip olduğu `(workspaceId, action.type)` çiftiyle `AutonomyTierSettingsService.get(workspaceId, action.type)` çağırır (bu servis ZATEN `CommandsService`'e enjekte, yalnızca `.resolveTier()` yerine `.get()` de çağrılır — yeni bağımlılık YOK). Dönen `TaskAutonomySetting.updatedBy` (o action type'ı `'act_and_notify'`e kim çevirdiyse) **`{type:'user', id}` İSE**, `id` bu bildirimin kişisel bütçe/sessiz-saat kontrolüne tabi olacağı `recipientUserId`'dir — **"bu action type'ı yap-bildir'e dial eden kişi, o kademenin ürettiği bildirimlerin BİRİNCİL tüketicisidir"** varsayımı, gerçek bir per-object/per-assignee alıcı-çözümleme mantığı İCAT ETMEDEN (nesne ataması alan-bazlı/tip-bazlı bir kavram — `packages/core-objects`'te sabit bir "assignee" kolonu YOK, `explorer` doğruladı — deterministik bir "bu nesnenin sahibi kim" sorgusu bu kod tabanında bugün YOK).

`updatedBy.type !== 'user'` İSE (ör. `type:'system'`/`'agent'`, teorik olarak bir migration/seed-script tarafından yazılmışsa) VEYA `updatedBy.id` için hiç `NotificationPreference` satırı yoksa: **fail-open, bugünkü davranış AYNEN korunur** (Karar b'nin AYNI ilkesi).

### (d) "Bağlam-değiştirme sayacı" — TEK, somut tanım: TESLİM EDİLMİŞ (bastırılmamış) bildirim sayısı

**Sayaç, `(workspaceId, recipientUserId)` başına, kayan pencere içinde GERÇEKTEN TESLİM EDİLMİŞ `AgentNotificationDelivered` olay sayısıdır — bastırılan (`AgentNotificationSuppressed`) bildirimler sayaca DAHİL EDİLMEZ.** Gerekçe: sayaç "kullanıcının kaç kez GERÇEKTEN kesintiye uğradığını" ölçmeli — bastırılan bir bildirim tanım gereği bir kesinti YARATMADI (bastırmanın TÜM amacı bu). Bu iki yeni geçmiş-zaman olayla gerçekleşir (event-sourcing değişmezine uygun, `agent_notification_deliveries` bunların salt projeksiyonu):

```ts
export type NotificationDeliveryOutcome =
  'delivered' | 'suppressed_quiet_hours' | 'suppressed_budget_exceeded';

export interface NotificationDeliveryRecord {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  actionType: string;
  sourceObjectId: string;
  outcome: NotificationDeliveryOutcome;
  commentId: string | null; // yalnızca outcome==='delivered'
  occurredAt: Date;
}
```

Olay tipleri: `AgentNotificationDelivered {workspaceId, recipientUserId, actionType, sourceObjectId, commentId}`, `AgentNotificationSuppressed {workspaceId, recipientUserId, actionType, sourceObjectId, reason: 'quiet_hours'|'budget_exceeded'}` — `AgentActionExecutionRecorded`'ın AYNI "kayıt-başına-taze-stream" deseni (`randomUUID()` streamId), `agent_notification_deliveries` tablosuna projekte edilir.

### (e) Sessiz saatlerde bastırılan bildirimler — TAMAMEN DÜŞER, ERTELENMEZ (gerekçeli karar)

**Sessiz saatte yakalanan bir bildirim ASLA teslim edilmez — sessiz saat bitince "gecikmiş" olarak da gönderilmez.** Yalnızca `AgentNotificationSuppressed{reason:'quiet_hours'}` kaydedilir, ledger (ADR-0038, `agent_action_records`) zaten TEK denetim izi olarak durur (ADR-0039 §h'nin `sourceObjectId` tanımsızken "bildirim atlanır, ledger tek iz kalır" emsalinin AYNI mantığının BURAYA genişlemesi).

**Gerekçe (ertelemenin NEDEN reddedildiği):**

1. **Yeni bir kalıcı sıra/worker altyapısı gerektirirdi** — `MentionActionEnqueueProjection`/`MentionActionWorker` desenine benzer bir "bekleyen bildirimler" kuyruğu + periyodik teslim worker'ı İCAT ETMEK gerekirdi. Bu görevi görevlendiren oturumun kendisi bunu AÇIKÇA kapsam dışı bıraktı ("yeni bir genel-amaçlı notification/delivery altyapısı" — kapsam dışı listesi).
2. **Yap-bildir'in kendi doğası zaten bu kararı destekliyor** (ADR-0039 insan kararı 2, bu ADR'nin kendi insan kararı 2'siyle aynı ruhta): aksiyon zaten sessiz saatte de YÜRÜTÜLDÜ (iş durmadı) — bildirim yalnızca bir FYI'dir, gecikmeli teslimi "işin kendisini" hiçbir şekilde tamamlamaz, yalnızca EK bir UX kararı ekler (toplu/gecikmeli bildirimlerin NE ZAMAN/NASIL sunulacağı, ör. "sabah özeti" gibi) — bu, PLAN.md §7 madde 6'nın "toplulaştırma" vizyonuna daha yakın, gerçek bir ihtiyaç doğduğunda AYRI bir karar/görev gerektiren bir genişleme.
3. **Ertelenmiş toplu teslim, sessiz saatin TAM AMACINI (odağı korumak) sessiz saat biter bitmez bir "bildirim bombardımanı"yla baltalayabilir** — sessiz saatler boyunca birikmiş N bildirimin hepsinin aynı anda düşmesi, hiç sessiz saat olmamasından daha kötü bir kesinti yaratabilir.

### (f) Bütçe + aşırı yük sinyali — TEK eşik, agrege sayım, canlı hesaplanır (kalıcı "sinyal" satırı YOK)

`notificationBudgetPerWindow`, kayan pencere (`AGENT_NOTIFICATION_BUDGET_WINDOW_MS`) içinde izin verilen TOPLAM teslim sayısıdır (Karar b) — bütçe TÜKENDİĞİNDE (`deliveredCountInWindow >= budget`) O ANDAN sonraki teslimler `suppressed_budget_exceeded` olarak bastırılır (yalnızca GÖRÜNTÜLEME amaçlı bir sayaç DEĞİL, gerçek bir üst-sınır — "bütçe" kelimesinin gerektirdiği anlam). **"Aşırı yük sinyali" AYRI, kalıcı bir satır/olay DEĞİLDİR** — `AgentNotificationGovernorService.getUsageSummary(workspaceId, userId)` çağrıldığında CANLI hesaplanan bir türetilmiş değerdir: `overloaded = deliveredCountInWindow >= notificationBudgetPerWindow`, artı `agent_notification_deliveries`'in `outcome='delivered'` satırlarının `actionType`'a göre GROUP BY/COUNT'uyla bulunan `topActionType: {actionType, count} | null` (en çok bildirim üreten actionType — önerinin İSİM VEREREK somutlaşmasını sağlar). Bu, `agent_action_executions`'ın COUNT-sorgusu ÜZERİNE hiçbir yeni kalıcı durum eklemeyen `assertActionRateNotExceeded`'ın AYNI "canlı sayım, kalıcı sinyal satırı yok" felsefesi.

### (g) Yeniden dengeleme önerisi — `AutonomyTierPanel.tsx`'e SALT BİLGİLENDİRİCİ bir banner, YENİ bir "uygula" butonu YOK

`overloaded === true` olduğunda `AutonomyTierPanel.tsx`'e (mevcut panel, YENİ bir sayfa/panel DEĞİL) `data-testid="autonomy-rebalance-suggestion"` ile bir banner eklenir: `"<topActionType.label> aksiyon tipi son <pencere> içinde <count> bildirim ürettü — bu aksiyon tipinin otonomi kademesini aşağıdaki listeden düşürmeyi düşünebilirsiniz."` (`ACTION_REGISTRY`'den etiket, ADR-0043 §f'nin "tek doğruluk kaynağı" ilkesi). **Bilinçli olarak "hemen uygula" butonu EKLENMEZ** — insan kararı 1'in harfiyen izlenmesi: kullanıcı ZATEN VAR OLAN, aynı panelin altındaki per-actionType `SelectRoot`'u kullanarak MANUEL değiştirir; bir "uygula" kısayolu, bir pasif ÖNERİ ile yarı-otomatik bir AKSİYON arasındaki çizgiyi bulanıklaştırırdı (bkz. Alternatifler).

Ayrıca yeni, ayrı bir `NotificationPreferencesPanel.tsx` (kendi bütçe/sessiz-saat FORM'u — kullanıcının KENDİ tercihini düzenlediği, `AutonomyTierPanel`'den KATEGORİK OLARAK farklı bir kavram: biri workspace POLİTİKASI/admin-yönetişimi, diğeri KİŞİSEL rahatlık ayarı) `apps/web/src/views/shared/`e eklenir.

### (h) `notifyAutonomousAction` entegrasyonu — YENİ bir `guardAndDeliver` kapısı, `dispatchExecute`/ledger AKIŞI DEĞİŞMEZ

`AgentNotificationGovernorService.guardAndDeliver` `AgentResourceLimitsService.executeAgentAction<T>(fn)`'in AYNI "kapı-kontrolü + callback + best-effort kayıt" desenini izler:

```ts
async guardAndDeliver(
  workspaceId: string,
  actionType: string,
  sourceObjectId: string,
  deliver: () => Promise<{ commentId: string }>,
): Promise<void> {
  const setting = await this.autonomyTierSettingsService.get(workspaceId, actionType);
  if (!setting || setting.updatedBy.type !== 'user') {
    await deliver();
    return;
  }
  const recipientUserId = setting.updatedBy.id;
  const preference = await this.preferencesService.resolvePreference(workspaceId, recipientUserId);
  if (!preference) {
    await deliver();
    return;
  }
  if (this.isWithinQuietHours(preference.quietHours)) {
    await this.recordOutcome(workspaceId, recipientUserId, actionType, sourceObjectId, 'suppressed_quiet_hours');
    return;
  }
  const deliveredCount = await this.countDeliveredInWindow(workspaceId, recipientUserId);
  if (deliveredCount >= preference.notificationBudgetPerWindow) {
    await this.recordOutcome(workspaceId, recipientUserId, actionType, sourceObjectId, 'suppressed_budget_exceeded');
    return;
  }
  const { commentId } = await deliver();
  await this.recordOutcome(workspaceId, recipientUserId, actionType, sourceObjectId, 'delivered', commentId);
}
```

`CommandsService.notifyAutonomousAction`'ın (`apps/server/src/commands/commands.service.ts:660-680`) MEVCUT try/catch'i AYNEN korunur; içindeki `this.commentsService.create(...)` çağrısı `deliver` callback'ine SARILIR ve TÜM gövde `this.notificationGovernor.guardAndDeliver(workspaceId, action.type, sourceObjectId, deliver)` çağrısına dönüşür — `sourceObjectId === undefined` erken-dönüşü (mevcut satır 665-667) DEĞİŞMEDEN kalır (governor'a hiç ULAŞMAZ, ADR-0039 §h'nin kendi emsali). `dispatchExecute`/`recordAutonomousLedgerEntry`/ledger-yazımı bu ADR'de TEK SATIR DEĞİŞMEZ — governor yalnızca `notifyAutonomousAction`'ın İÇİNE, mevcut `commentsService.create` çağrısının ETRAFINA eklenir.

### (i) RBAC — DM'lerin (ADR-0037 §e) AYNI self-restriction deseni, ama YAZMA için ADMIN İSTİSNASI DA YOK

`NotificationPreferencesService.set(workspaceId, userId, prefs, actor, callerRole)`: `hasAtLeastRole(callerRole,'member')` VE `actor.id === userId` ZORUNLU — **admin BİLE başka bir kullanıcının kişisel tercihini YAZAMAZ** (`direct-messages.service.ts:177`'nin `requestingUserId !== targetUserId && !hasAtLeastRole(callerRole,'admin')` desenindeki admin-istisnası BİLİNÇLİ OLARAK BURAYA taşınmaz — DM geçmişini görüntülemek bir gözetim/oversight ihtiyacı, ama bir başkasının kişisel odak tercihini DEĞİŞTİRMEK bir yönetişim aşımı olurdu). `NotificationPreferencesService.get(workspaceId, userId, requestingUserId, callerRole)`: member+ VE (`requestingUserId === userId` VEYA admin+) — DM `list`'in (`direct-messages.service.ts:166-179`) BİREBİR AYNI okuma-deseni (admin gözetim amaçlı başkasının tercihini GÖREBİLİR, ama değiştiremez). `resolvePreference` (governor'ın iç kullanımı) `AutonomyTierSettingsService.get`'in AYNI "RBAC parametresi YOK, internal read-point" deseni.

## Somut Şekiller

```ts
// packages/agent-runtime/src/notification-preference.ts
export interface QuietHoursWindow {
  startHourUtc: number; // 0-23
  endHourUtc: number; // 0-23, wraps past midnight if < startHourUtc
}

export interface NotificationPreference {
  id: string;
  workspaceId: string;
  userId: string;
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindow | null;
  updatedAt: Date;
}

// packages/agent-runtime/src/notification-delivery-record.ts
export type NotificationDeliveryOutcome =
  'delivered' | 'suppressed_quiet_hours' | 'suppressed_budget_exceeded';

export interface NotificationDeliveryRecord {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  actionType: string;
  sourceObjectId: string;
  outcome: NotificationDeliveryOutcome;
  commentId: string | null;
  occurredAt: Date;
}
```

```ts
// apps/server/src/db/schema/agent-notification-preferences.ts
export const agentNotificationPreferences = pgTable(
  'agent_notification_preferences',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 100 }).notNull(),
    notificationBudgetPerWindow: integer('notification_budget_per_window').notNull(),
    quietHoursStartHourUtc: integer('quiet_hours_start_hour_utc'), // nullable together
    quietHoursEndHourUtc: integer('quiet_hours_end_hour_utc'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('agent_notification_preferences_workspace_user_idx').on(
      table.workspaceId,
      table.userId,
    ),
  ],
);

// apps/server/src/db/schema/agent-notification-deliveries.ts
export const agentNotificationDeliveries = pgTable(
  'agent_notification_deliveries',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recipientUserId: varchar('recipient_user_id', { length: 100 }).notNull(),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    sourceObjectId: uuid('source_object_id').notNull(),
    outcome: varchar('outcome', { length: 30 }).notNull(),
    commentId: uuid('comment_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_notification_deliveries_recipient_occurred_idx').on(
      table.recipientUserId,
      table.occurredAt,
    ),
  ],
);
```

Migration: `0046_agent_notification_governor.sql` (iki tabloyu TEK migration'da bündler — `0027_connector_credentials_and_rate_limit.sql`'in AYNI "tek görevin iki tablosu, tek migration" emsali), down script'iyle birlikte (CLAUDE.md: "Migration'ı down script'i olmadan yazma", `apps/server/src/db/migrations/down/0046_agent_notification_governor.down.sql`).

Servisler: `NotificationPreferencesService` (`set`/`get`/`resolvePreference`, deterministik `streamId = deriveDeterministicUuid(NAMESPACE, workspaceId + ':' + userId)`, event `AgentNotificationPreferenceSet`, stream tipi `'agent-notification-preference'`); `AgentNotificationGovernorService` (`guardAndDeliver`/`getUsageSummary`, event tipleri `AgentNotificationDelivered`/`AgentNotificationSuppressed`, stream tipi `'agent-notification-delivery'`, `AgentActionExecutionsProjection`'ın AYNI "kayıt-başına-taze-stream" deseni).

Yeni sabit `env.agentNotificationBudgetWindowMs` (`agentActionRateLimitWindowMs`'in AYNI `readPositiveIntegerEnv` deseni, `apps/server/src/config/env.ts`).

`CommandsService` değişiklikleri: constructor'a `AgentNotificationGovernorService` enjekte edilir; `notifyAutonomousAction`'ın gövdesi `guardAndDeliver`'ı sarar (yukarıdaki Karar h) — `executeAutonomousAction`/`dispatchExecute`/`recordAutonomousLedgerEntry` DEĞİŞMEZ.

**RBAC özeti:** `NotificationPreferencesService.set` = self-only (admin istisnası YOK); `.get` = self VEYA admin+; `AgentNotificationGovernorService`'in kendi HTTP uç noktası YOK, yalnızca `notifyAutonomousAction`'dan dolaylı tetiklenir; `getUsageSummary` controller-seviyesinde `.get`'in AYNI self-veya-admin RBAC'ını taşır.

## Alternatifler ve Reddedilme Gerekçeleri

- **Sessiz saatte bastırılan bildirimleri kuyruğa alıp sessiz saat bitince (veya "sabah özeti" olarak toplulaştırılmış) teslim etmek.** Reddedildi (Karar e) — yeni bir kalıcı sıra/worker altyapısı gerektirirdi (bu görevi görevlendiren oturumun AÇIKÇA kapsam dışı bıraktığı "yeni notification/delivery altyapısı"); toplu gecikmeli teslim sessiz saatin amacını (odağı korumak) tam bitişte bir bildirim yığınıyla baltalayabilir.
- **Bütçeyi `(workspaceId, userId, actionType)` başına (actionType-başına ayrı bütçe) tanımlamak.** Reddedildi — "bildirim bütçeleri" (çoğul) ifadesi PLAN.md'de bir ÖZELLİK adı, literal olarak N ayrı sayaç/UI alanı gerektirmiyor; TEK agrege bütçe + `topActionType` breakdown'u (Karar f), somut/isimlendirilmiş bir öneri üretmek için YETERLİ, actionType-başına ayrı bir bütçe FORM'u/UI'ı v0 için gereksiz karmaşıklık olurdu.
- **Alıcıyı nesnenin "sahibi/atanmışı" alanından çözmek.** Reddedildi (Karar c) — `packages/core-objects`'te sabit, tip-bağımsız bir "assignee" kolonu YOK (alan-bazlı, `explorer` doğruladı); `TaskAutonomySetting.updatedBy` HALİHAZIRDA var olan, deterministik, yeni sorgu gerektirmeyen bir alıcı kaynağı.
- **Yeniden dengeleme önerisine "hemen uygula" (otomatik `set()` çağıran) bir buton eklemek.** Reddedildi (Karar g, insan kararı 1'in harfiyen izlenmesi) — pasif öneri ile yarı-otomatik aksiyon arasındaki çizgiyi bulanıklaştırırdı; kullanıcı ZATEN VAR OLAN panel-içi seçiciyi kullanır.
- **Aşırı yük sinyalini kalıcı bir tabloya/olaya yazmak (`AgentOverloadSignalRaised` gibi).** Reddedildi (Karar f) — `assertActionRateNotExceeded`'ın AYNI "canlı sayım, kalıcı sinyal-satırı yok" felsefesi; `overloaded` her zaman `agent_notification_deliveries`'ten TÜRETİLEBİLİR, ayrı bir kalıcı durumun senkron-dışı kalma riski YOK.
- **`NotificationPreferencesService.set`'e DM `list`'in AYNI admin-istisnasını taşımak.** Reddedildi (Karar i) — bir başkasının kişisel odak tercihini bir admin'in DEĞİŞTİREBİLMESİ (yalnızca GÖREBİLMESİ değil) bir yönetişim aşımı olurdu; DM emsali salt OKUMA (gözetim) içindi, YAZMA için aynı gerekçe geçerli değil.

## Mimari Değişmezlerle İlişki

- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu ADR bu sözleşmeyi TETİKLEMİYOR — yeniden dengeleme önerisi bir ajan aksiyonu DEĞİL (Karar 1, salt pasif bilgi), sessiz-saat/bütçe bastırması da bir aksiyon değil bir TESLİMAT kararı (asıl aksiyon zaten `executeAutonomousAction`/ADR-0039'un AYNI ledger sözleşmesiyle yürütülüp kaydedildi, bu ADR yalnızca sonraki BİLDİRİM adımını kapılıyor).
- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** `agent_notification_preferences`/`agent_notification_deliveries` sırasıyla `AgentNotificationPreferenceSet`/`AgentNotificationDelivered`/`AgentNotificationSuppressed` olaylarının salt projeksiyonları — `task_autonomy_settings`/`agent_action_executions`'ın AYNI kategorisinde.
- **Veri dışa aktarma / hassas veri sınıfları.** Bu ADR hiçbir export uç noktasına veya AI-sağlayıcı çağrısına dokunmuyor; bildirim gövdesi AI-üretimli DEĞİL (mevcut sabit şablon, ADR-0039 §h, DEĞİŞMEZ).

## Bilinen Sınırlamalar / Sonuçlar-Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin F3-T13 vaadi (bildirim bütçesi, bağlam-değiştirme sayacı, sessiz saatler, aşırı yük → öneri) `notifyAutonomousAction`/`AutonomyTierSettingsService`'in ZATEN kurduğu mekanizmaların (tek bildirim çağrı-noktası, `updatedBy` alıcı-kaynağı, canlı-sayım felsefesi) ÜZERİNE, yeni bir bildirim alt sistemi İCAT EDİLMEDEN kurulur; Epik F3-E5'in "Refah Katmanı" vaadi somut, test edilebilir bir mekanizmaya kavuşur.

**Neyi erteliyoruz / kabul ediyoruz:**

- Sessiz saatte bastırılan bildirimler KALICI OLARAK kaybolur, toplulaştırılıp sonra gönderilmez (Karar e) — PLAN.md §7 madde 6'nın "toplulaştırma" vizyonunun TAM gerçekleştirilmesi ayrı bir gelecekteki karar/görev gerektirir.
- Bütçe actionType-başına DEĞİL, agrege (Karar f/Alternatifler) — gerçek bir ihtiyaç doğarsa actionType-başına bütçe AYRI bir genişletme.
- Sessiz saatler yalnızca UTC-saat, kullanıcı-başına saat dilimi YOK (Karar b) — v0 basitleştirmesi, timezone-farkındalığı doğal bir gelecekteki genişletme noktası.
- Alıcı çözümleme `TaskAutonomySetting.updatedBy`'a bağlı — bir actionType `'act_and_notify'`e bir `type:'system'`/`'agent'` aktör tarafından (teorik, bugün pratikte olmaz — yalnızca admin+ insan `set()` çağırabilir, ADR-0039 §i) çevrilmişse fail-open kalır, bütçe/sessiz-saat hiç uygulanmaz.
- Yeniden dengeleme önerisi YALNIZCA panel açıkken görülür (canlı hesaplanır, push/e-posta bildirimi YOK) — bu görevi görevlendiren oturumun "yeni bir genel-amaçlı notification/delivery altyapısı" kapsam-dışı sınırının doğrudan sonucu.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E5/F3-T13-bildirim-butcesi-sessiz-saatler.md`) bu ADR ile birlikte yazıldı. Bu ADR'nin onayı üzerine PR1'e (`packages/agent-runtime` saf domain: `NotificationPreference`/`QuietHoursWindow`/`NotificationDeliveryRecord` tipleri + olay şemaları + `agent_notification_preferences`/`agent_notification_deliveries` şemaları/migration + `NotificationPreferencesService` set/get/resolvePreference) `test-writer` ile başlanır:

```
docs/adr/ADR-0047-bildirim-butcesi-sessiz-saatler.md'deki Karar (a)-(i)'yi ve
docs/specs/F3-E5/F3-T13-bildirim-butcesi-sessiz-saatler.md'nin Kabul Kriterleri'ni temel
alarak, F3-T13 PR1 (packages/agent-runtime saf domain: NotificationPreference/
QuietHoursWindow/NotificationDeliveryRecord tipleri, AgentNotificationPreferenceSet/
AgentNotificationDelivered/AgentNotificationSuppressed olay şemaları,
agent_notification_preferences/agent_notification_deliveries tabloları + migration,
NotificationPreferencesService set/get/resolvePreference) için test-writer ile
başarısız testleri yaz.
```
