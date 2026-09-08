# ADR-0038: Ajan Aksiyon Kayıt Defteri — Niyet + Gerekçe + Kaynaklar + Geri Alma Planı ("Uçuş Kayıt Cihazı", Epik F3-E2 Açılışı)

**Durum:** Kabul edildi (Plan Mode oturumunda insan onayı zaten alındı — bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-08
**İlgili görev:** F3-T4 — Her ajan aksiyonu için gerekçe kaydı + kullanılan bağlam kaynakları + geri alma planı ("uçuş kayıt cihazı"). Spec dosyası: `docs/specs/F3-E2/F3-T4-ajan-aksiyon-kayit-defteri.md` (bu ADR ile paralel olarak `docs-writer` tarafından yazılır) — `docs/PLAN.md` §"Epik F3-E2: Cam Kutu Otonomi (Kapsam K)" satırı bu ADR'nin tek plan kaynağı.
**İlgili plan referansı:** `docs/PLAN.md`, FAZ 3, Epik F3-E2'nin AÇILIŞ görevi (F3-T4/F3-T5/F3-T6'dan yalnızca F3-T4'ü kapsar). CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin ilk fıkrasını doğrudan tetikliyor: bu görev "Mimari Değişmezler"den birine — "Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar" — dokunuyor. **Bu ADR'yi öncekilerden ayıran nokta: bu değişmez proje kuruluşundan beri yalnızca DÜZYAZI olarak var, hiçbir kod onu ZORLAMIYOR/KAYDETMİYOR — bu, o değişmezi gerçekten GERÇEKLEŞTİREN İLK ADR'dir, yalnızca "ihlal etmeyen" değil.**

> Bu ADR, ADR-0035'in (F3-T1, Ajan Çalışma Zamanı), ADR-0036'nın (F3-T2, Skill SDK v1) ve ADR-0037'nin (F3-T3, Ajan-İnsan Etkileşimi) doğrudan mimari devamıdır. Her üçü de bu görevi önceden işaret etmişti: ADR-0035 §(i) "niyet/gerekçe/kaynak/geri-alma-planı alanları F3-T4'ün kapsamında ayrıca ele alınacak", ADR-0037 kendi "Mimari Değişmezlerle İlişki" bölümünde aynı cümleyi tekrarladı. **Bu ADR, ADR-0037'nin `executeSkill`'in sabit sırasını (registry-arama → `checkPermission` → `executeAgentAction`) veya ADR-0037'nin `decide()`'ı TEK boğaz noktası olarak sabitleyen Karar (f)'ini YENİDEN AÇMAZ — ikisini de OLDUĞU GİBİ TÜKETİR, yalnızca ikisinin de zaten ÜRETTİĞİ sonuçların ÜZERİNE bir KAYIT katmanı ekler.**
>
> Aşağıdaki (a)-(i) maddelerinden hiçbiri insana yeniden sorulmadı — Plan Mode oturumunda alınan 2 insan kararı (birleşik tek kayıt defteri, salt-okunur frontend görüntüleyici dahil edilmesi) zaten aynen kayıt altına alınıyor; kalan somut tasarım detayları bu ADR'nin kendi sorumluluğu (CLAUDE.md "Çalışma Ritüeli").

## Bağlam

Keşif, bu görevi doğrudan besleyen dört emsal ile İKİ kategorik olarak farklı, birleştirilmesi gereken izlenebilirlik şekli ortaya koydu (tam dosya:satır referanslarıyla doğrulandı):

1. **`ProposedAction`** (`apps/server/src/ai/parse-command.ts:26-40`) CLAUDE.md sözleşmesine neredeyse 1:1 eşlenen alanlara ZATEN sahip: `{actionId, type, intent, rationale, resources: string[], rollbackNote, params}`. Ama `rationale`/`rollbackNote` AI'nın yazdığı SERBEST METİN düzyazı — hiçbir zaman ayrıştırılmıyor/doğrulanmıyor/yürütülmüyor. `resources: string[]` DOĞRULANMAMIŞ (bunların gerçek nesne/yorum/toplantı id'leri olduğuna dair hiçbir kontrol yok). Bunlar `command_proposals.actions` (jsonb dizisi) içinde `actionId`'ye göre anahtarlanmış yaşıyor — ama `executeDecidedAction`'ın gerçek mutasyonları yalnızca PAYLAŞILAN bir `causationEventId`'yi (birlikte karara bağlanan HER aksiyonun ortak olduğu `ActionsDecided` olayının kendi id'si) taşıyor, yani "bu belirli oluşturulan görev"den "bu belirli aksiyonun rationale/resources/rollbackNote'una" güvenilir bir SAKLANMIŞ bağlantı yok — `actionId`'ye göre proposal'ın jsonb'ini yeniden ayrıştırmak ve çakışma olmamasını ummak gerekirdi. `executeReconfigureAgentPermissions` (satır 876-916) `causationEventId`'yi `grant`/`revoke`'a hiç TAŞIMIYOR bile — bu aksiyon tipi için bugün SIFIR izlenebilirlik var. Doğrudan kod okunarak doğrulandı: `executeDecidedAction`'ın switch'inde (satır 759-801) `executeAssignPeople` (satır 777, yalnızca 4 argüman) ve `executeReconfigureAgentPermissions` (satır 794-800, yalnızca 4 argüman) `causationEventId`'yi ALMAYAN TEK İKİ dal.

2. **`agent_action_executions`** (`apps/server/src/db/schema/agent-action-executions.ts`, `AgentResourceLimitsService.recordAgentAction`'ın yazdığı, `apps/server/src/agent-runtime/agent-resource-limits.service.ts`): `{id, workspaceId, agentIdentifier, actionType, outcome, durationMs, occurredAt}` — saf muhasebe, sıfır gerekçe/kaynak/geri-alma. Mention→beceri yolunun yazdığı TEK ŞEY bu. Bu tablo AYRICA `AgentResourceLimitsService.assertActionRateNotExceeded`'ın DB-destekli hız-sınırı SAYIM sorgusunun (satır 128-150) performans-kritik dayanağı — şeması bu ADR'de DEĞİŞTİRİLMEZ.

3. **`AgentActionResult<T>`** (`packages/agent-runtime/src/run-in-agent-sandbox.ts`): `{outcome:'success', value}|{outcome:'timeout'}|{outcome:'failure', error}` — burada da rationale/kaynak/geri-alma yuvası yok.

4. **`MentionActionWorker.runOnce()`** (`apps/server/src/comments/mention-action-worker.service.ts`) `executeSkill`'i çağırdıktan SONRA `row.workspaceId`/`row.commentId`/`row.objectId`/`row.agentIdentifier`/`executionResult`'in TAMAMINA aynı anda sahip TEK gerçek çağıran nokta — bu, otonom yol için ledger-yazma sorumluluğunun doğal olarak nereye ait olduğunu belirler (bkz. Karar d).

**İki kategorik olarak farklı provenance şekli:**

- **İnsan-kararlı yol** (`decide()` → `executeDecidedAction`): rationale/resources/rollbackNote ZATEN var (düzyazı olarak), bir insan onayından ÖNCE bir AI önericisi tarafından yazılmış, yürütme-anındaki actor GERÇEK onaylayan insan.
- **Otonom yol** (mention → beceri çalıştırma): HİÇBİR ŞEY yok, yürütme-anındaki actor ajanın KENDİSİ (`{type:'agent', id: agentIdentifier}`), bir `CommentAdded` olayıyla tetiklenir, tasarım gereği İKİNCİ bir insan `decide()` adımı YOK (ADR-0037 Karar d — mention→beceri çalıştırma KASITLI olarak ikinci bir insan onayıyla kapılanmaz, yalnızca ajanın KENDİ izin manifestosuyla).

**Uyulması gereken yönetişim sınırı (ADR-0037'den):** `decide()` governance-hassas/geri-alınabilir-izin-veren aksiyonlar için TEK boğaz noktası olarak KALMALI — F3-T5'in gelecekteki otonomi kadranı "muhtemelen `decide()`'ı BYPASS ETMEYİ değil, NE ZAMAN gerekli olduğunu DEĞİŞTİRMEYİ isteyecektir." Bu ADR'nin kayıt defteri tasarımı İKİNCİ bir karar yüzeyi YARATMAZ — bu bir KAYIT mekanizmasıdır, bir ONAY mekanizması DEĞİL. Otonom bir aksiyonun rationale/resources/rollback-plan'ının kaydı yürütmeden SONRA/SIRASINDA olur, ASLA önce bir kapı olarak değil (otonom aksiyonlar için kapı zaten `checkPermission`, değişmeden kalır).

**İnsan kararları (Plan Mode oturumunda alındı, bu ADR onları icat etmiyor, aynen kayıt altına alıyor):**

1. Birleşik tek kayıt defteri: HEM `decide()`-yürütülen aksiyonlar HEM mention→beceri otonom çalıştırmaları TEK yeni olay-kaynaklı tablo/servise yazar.
2. Salt-okunur bir frontend görüntüleyici dahil edilir — "Uçuş Kayıt Cihazı" paneli, `AutomationHistoryPanel.tsx`'in düz-liste-diyalogsuz konvansiyonunu yansıtır, her kaydın niyet/gerekçe/kaynaklar/geri-alma-planını listeler. Bu, F3-T1'in "v0 yalnızca-backend" emsalinden bir kapsam sapmasıdır — Karar (h) bunu bu Epik'in çekirdek vaadi (şeffaflık) olarak gerekçelendirir.

Çözülmesi gereken merkezi soru (bu ADR'nin görevi): yeni tip/mantığın nerede yaşayacağı (a), birleşik kaydın somut şekli (b), `decide()`-yürütülen yolun bu deftere NASIL yazacağı (c), mention→beceri otonom yolun bu deftere NASIL yazacağı (d), okuma RBAC'ı (e), kaynaklar[] doğrulama yaklaşımı (f), F3-T6'ya karşı açık kapsam sınırı (g), frontend dahil edilme gerekçesi (h), ve geçmişe dönük backfill duruşu (i).

## Karar

### (a) Yerleşim — `packages/agent-runtime/`'a YENİ dosyalar, YENİ bir paket DEĞİL

Yeni saf tipler `packages/agent-runtime/src/agent-action-record.ts` (`AgentActionRecord`, `ActionProvenance`, `ActionResourceReference`, `RollbackPlan`, `AgentActionOutcome` + küçük saf fabrika yardımcıları: `objectResource(objectId)`, `commentResource(commentId)`, vb.) ve `packages/agent-runtime/src/agent-action-record-events.ts` (event payload zod şemaları, ADR-0035 §(j)'nin ISO-8601-string-in-jsonb konvansiyonunu izler) olarak eklenir; `packages/agent-runtime/src/index.ts`'ten dışa aktarılır.

**Gerekçe:** Bu paket ZATEN `AgentPermissionManifest`/`evaluateManifestGrant`/`runInAgentSandbox`'ı barındırıyor — aynı "ajan çalışma zamanı kavramları" kategorisinde TEK bir yeni varlık için `packages/automation`'ın kanıtlanmış bağımsız-paket iskeletini ÜÇÜNCÜ kez tekrarlamak (ADR-0035'in zaten yaptığı gibi) gereksiz kapsam olurdu. Servis-katmanı mantığı (DB/event-store gerektiren) ise `apps/server/src/agent-runtime/agent-action-records.service.ts`'e eklenir — `AgentPermissionManifestsService`/`AgentResourceLimitsService` ile AYNI dizin, AYNI saf-tip/servis bölünmesi.

### (b) Birleşik kaydın somut şekli — `AgentActionRecord`

```ts
export type ActionProvenance = 'decided' | 'autonomous';

export type AgentActionOutcome = 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';

/** Bir kaynağın TÜRÜ + somut kimliği — çıplak string DEĞİL. `external`,
 * yapısal olarak çözülemeyen (ör. AI'nın bahsettiği bir Slack kanalı adı
 * gibi) bir kaynağı SESSİZCE atmak yerine AÇIKÇA etiketlemek için var. */
export type ActionResourceReference =
  | { kind: 'object'; objectId: string }
  | { kind: 'comment'; commentId: string }
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'agent'; agentIdentifier: string }
  | { kind: 'external'; label: string };

export interface RollbackPlan {
  /** `'delete'` oluşturulan bir object/comment için; `'revertFieldValue'`
   * bir alan-değeri ipucu uygulaması için; `'revokePermission'` bir grant
   * için; `'manual'` yapısal bir ters-işlem KAYDEDİLEMEDİĞİNDE (ör. bir
   * revoke'un öncesi durumu bu defterde saklanmıyor); `'none'` hiçbir
   * mutasyon olmadığında (ör. `rejected`/`failed`). */
  kind: 'delete' | 'revertFieldValue' | 'revokePermission' | 'manual' | 'none';
  targetResource?: ActionResourceReference;
  description: string;
}

export interface AgentActionRecord {
  id: string; // ULID
  workspaceId: string;
  provenance: ActionProvenance;
  actor: Actor; // 'decided' → gerçek onaylayan insan; 'autonomous' → {type:'agent', id: agentIdentifier}
  actionType: string; // 'decided' → ProposedAction.type; 'autonomous' → skillId
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: AgentActionOutcome;
  resultRef: ActionResourceReference | null; // asıl mutasyonun sonucu (ör. oluşturulan görev)
  causationEventId: string | null; // 'decided' → ActionsDecided olayının id'si; 'autonomous' → null (bu yolda böyle bir olay yok)
  occurredAt: Date;
}
```

`AgentActionOutcome`, iki farklı çıktı sözlüğünü (`DecideActionResult.status`: `'executed'|'failed'|'partially_executed'|'rejected'` ve `AgentActionResult.outcome`: `'success'|'timeout'|'failure'`) TEK bir sözlüğe eşler: `executed`/`success` → `succeeded`; `partially_executed` → `partially_succeeded`; `failed`/`timeout`/`failure` → `failed`; `rejected` → `rejected`. **`timeout`'un ayrı bir dal OLMAMASI bilinçli** — `timeout` zaten `MentionActionWorker`'ın kendi retry mantığında ayrı işleniyor (Karar d), kayıt defterinde ekstra bir ayrım eklemek gerçek bir tüketici olmadan kapsam şişirirdi.

### (c) `decide()`-yürütülen yol — HER `executeXxx` KENDİ kaydını YAZAR, jsonb yeniden-ayrıştırma İCAT EDİLMEZ

Her `executeXxx` metodu (`executeCreateTask`, `executeGenerateSubtasks`, `executeAssignPeople`, `executeCreateTaskFromMeeting`, `executeCreateTaskFromTrigger`, `executeReconfigureAgentPermissions`), kendi `DecideActionResult`'ını belirledikten HEMEN SONRA, `AgentActionRecordsService.record(...)`'ı KENDİ ZATEN SAHİP OLDUĞU somut değerlerle (oluşturulan nesnenin gerçek id'si, `action.params.parentObjectId`, `causationEventId`, vb.) çağırır — `command_proposals.actions` jsonb'ini `actionId`'ye göre SONRADAN yeniden ayrıştırmaya HİÇ gerek kalmaz, çünkü kayıt tam olarak mutasyonun kendi yürütüldüğü yerde, doğru veriyle yazılır. Bu fact #1'in tarif ettiği kırılgan-yeniden-ayrıştırma yolunu KODLANMADAN ÖNLER — bugün böyle bir yeniden-ayrıştırma kodu YOK, bu ADR'nin görevi onun hiç yazılmasını gereksiz kılmak.

`executeAssignPeople`/`executeReconfigureAgentPermissions` imzalarına `causationEventId` EKLENİR (bugün eksik olan tek iki dal, fact #1) — SADECE ledger-yazımı için; `grant`/`revoke`'un kendi imzası DEĞİŞMEZ.

Ledger-yazımı `AgentResourceLimitsService.recordAgentAction`'ın AYNI best-effort/asla-fırlatmaz sözleşmesini izler: `AgentActionRecordsService.record()` kendi try/catch'i içinde çalışır, hata durumunda yalnızca loglar — `DecideActionResult`'ın kendisini ASLA etkilemez. `rejected`/`failed` sonuçlar DA kaydedilir (yalnızca `executed`/`partially_executed` değil) — şeffaflık hedefi "yalnızca başarılı aksiyonlar" değil, "bir insanın reddettiği veya başarısız olan bir aksiyon önerisi" de denetim açısından anlamlı bir gerçektir.

`command_proposals` tablosu/şeması bu ADR'de HİÇ DEĞİŞMEZ — yeni ledger EK bir kayıt, `command_proposals`'ın YERİNE geçen bir şey değil.

### (d) Mention→beceri otonom yol — `MentionActionWorker` kendi ledger-yazımını yapar, `executeSkill` DEĞİŞMEZ

`AgentResourceLimitsService.recordAgentAction`/`agent_action_executions` AYNEN KORUNUR, DEĞİŞTİRİLMEZ — bu tablo `assertActionRateNotExceeded`'ın performans-kritik SAYIM sorgusunun dayanağı olarak kalır (Karar bu iki tabloyu birleştirmemek — bkz. Alternatifler). Yeni ledger tablosu bunun YERİNE geçmez, daha zengin bir KARDEŞ tablodur.

Yeni kaydı `SkillExecutionService.executeSkill`'in İÇİNE EKLEMEK yerine `MentionActionWorker.runOnce()`'a eklenir: `executeSkill` çağrısından SONRA, `row.commentId`/`row.objectId`/`row.agentIdentifier`/`executionResult` zaten elde iken, `AgentActionRecordsService.record(...)` çağrılır (best-effort, mevcut retry/backoff/mark-done mantığını ASLA etkilemez — kendi try/catch'i içinde). **Gerekçe:** ADR-0037 `executeSkill`'in sabit sırasını (registry-arama → `checkPermission` → `executeAgentAction`) AÇIKÇA "yeniden AÇILMAZ" diye sabitledi; `executeSkill`'in imzasını genişletmek (kaynak/niyet/gerekçe parametreleri eklemek) bu sabitlenmiş sözleşmeyi gereksiz yere genişletirdi, üstelik `executeSkill`'in bugün TEK gerçek çağıranı `MentionActionWorker` olduğundan (ADR-0037), bunu jenerik hale getirmek varsayımsal gelecekteki çağıranlar için önden mühendislik olurdu (bu kod tabanının ADR-0035 §(c)'de zaten reddettiği bir desen).

Somut alanlar: `provenance:'autonomous'`, `actor:{type:'agent',id:agentIdentifier}`, `actionType:'answer-question'`, `resources:[{kind:'object',objectId:row.objectId},{kind:'comment',commentId:row.commentId}]`, `causationEventId: null` (bu yolda bir `ActionsDecided` olayı YOK — alanın `null` olabilir OLMASININ TEK nedeni bu). `intent`/`rationale` SABİT şablon dizeleridir (`FORBIDDEN_LAST_ERROR`/`TIMEOUT_LAST_ERROR`'ın AYNI sabit-dize disiplinini izler) — ör. `intent: 'Bir yorumdaki @mention'a yanıt verildi'`, `rationale: 'Ajan, kendi izin manifestosu kapsamında bu nesnedeki bir mention'a otomatik yanıt verdi (ikinci bir insan onayı adımı yok, ADR-0037 Karar d).'` — ham `body`/`answer` metni GÖMÜLMEZ (CLAUDE.md "kullanıcı verisini log'a yazma" ruhuna uyumlu, gerçi bu bir log değil workspace'in kendi denetim kaydı; yine de şablonlanmış tutmak gerçek metni ikinci bir yerde çoğaltmaktan kaçınır — asıl metin zaten `object_comments`'te duruyor). Başarıda `resultRef:{kind:'comment',commentId:reply.id}`, `rollbackPlan:{kind:'delete', targetResource:{kind:'comment',commentId:reply.id}, description:'Ajanın yanıt yorumunu sil.'}`; başarısızlıkta `resultRef:null`, `rollbackPlan:{kind:'none', description:'Hiçbir mutasyon oluşmadı.'}`.

### (e) Okuma RBAC'ı — member+, workspace-genelinde

`AgentActionRecordsService.list(workspaceId, callerRole)` member+ — `AutomationHistoryPanel`'in beslediği Command Proposals listesinin ve Agent dizini `list`'in (ADR-0037 §b) AYNI member+ okuma konvansiyonunu izler. DM'lerin (ADR-0037 §e) `req.user.id === userId` kişisel kısıtlaması BURADA UYGULANMAZ — bu defter kişisel değil, workspace-genelinde bir ajan-aksiyon denetim kaydıdır (`AutomationTriggers`in "asla kişisel değil" ilkesiyle aynı kategori).

### (f) `resources[]` doğrulama yaklaşımı

`ProposedAction.resources: string[]`'in AI-yazımı serbest metni HİÇBİR ZAMAN ledger'ın `resources: ActionResourceReference[]`'ına DOĞRUDAN aktarılmaz/yeniden-yorumlanmaz — bu, doğrulanmamış düzyazıyı yapılandırılmış bir kaynak-referansıymış gibi göstermenin YANLIŞ güven kazandıracağı gerekçesiyle KASITLI. Bunun yerine HER `executeXxx`/`MentionActionWorker` çağrı noktası kendi ledger kaydının `resources[]`'ını KENDİ ZATEN BİLDİĞİ somut id'lerden (oluşturduğu nesnenin id'si, `action.params.parentObjectId`, mention'ın `objectId`/`commentId`'si, yetki verilen/geri alınan `agentIdentifier`) yapısal olarak İNŞA EDER. AI'nın orijinal `intent`/`rationale` düzyazısı (kendisi zaten yetki taşımayan, salt açıklayıcı metin) ledger'a AYNEN kopyalanır — ADR-0034/ADR-0037'nin "AI-yazımı bir öneri TEK BAŞINA yeterli yetki olarak ASLA güvenilmez" ilkesinin burada tekrarı: düzyazı görüntüleme amaçlı kalır, hiçbir zaman yapılandırılmış kaynak/yetki kaynağı olarak KULLANILMAZ.

### (g) Kapsam DIŞI — F3-T6'ya karşı açık sınır (KAYIT ≠ YÜRÜTME)

Bu görev SADECE kayıt yapar. `AgentActionRecordsService` YALNIZCA `record`/`list`/`get` sağlar — **`revert`/`undo` metodu YOK, ters-olay üretimi YOK, hiçbir gerçek geri-alma mutasyonu bu ADR'nin kapsamında YAZILMAZ.** `RollbackPlan`, reversal'ın YAPISAL, makine-tarafından-okunabilir bir TARİFİDİR (`kind` + hedef kaynak + açıklama) — bu tarifi gerçekten ÇALIŞTIRMAK F3-T6'nın ("tek tık geri alma: ters olay üretimiyle atomik geri sarma") sorumluluğudur. F3-T6 bu ADR'nin `AgentActionRecord.rollbackPlan`/`.resources[]`'ını kendi GİRDİSİ olarak tüketecek — ama bu ADR o tüketiciyi İNŞA ETMEZ.

Çoklu-kaynaklı aksiyonlar için (ör. `generateSubtasks`'ın birden fazla alt görevi) `RollbackPlan.targetResource` TEKİL kalır (opsiyonel) — tam liste `resources[]`'tan okunur, `description` bunu düzyazıyla açıklar (ör. "Oluşturulan tüm alt-görev nesnelerini ve `parentChild` ilişkilerini sil; kesin id'ler için `resources[]`'a bakın"). Bu, N-kaynaklı bir aksiyon için tam orkestrasyonlu bir geri-alma YAPISI İCAT ETMEKTEN KAÇINIR — bu tür orkestrasyon YİNE F3-T6'nın kapsamı.

**`reconfigureAgentPermissions`'ın `'revoke'` dalı için de aynı ilke geçerli:** bu ADR revoke'un öncesi manifesto durumunu SNAPSHOT'LAMAZ, dolayısıyla yapısal bir ters-işlem TARİF EDİLEMEZ — `RollbackPlan.kind:'manual'`, `description:'Önceki manifestoyu elle yeniden ver; bu defter revoke-öncesi durumu saklamıyor.'` Bu bilinçli bir v0 sınırlaması (YAGNI) — gerçek bir ihtiyaç doğarsa, revoke-öncesi manifesto durumunu snapshot'lamak ayrı bir karar/genişletme gerektirecektir.

### (h) Frontend dahil edilme gerekçesi (insan kararı, aynen kayıt + gerekçelendirme)

F3-T1'in "v0 yalnızca-backend" emsali (ADR-0035 §h) `AgentPermissionManifest`in o anki durumuna özgüydü: `agentIdentifier` "bugün geliştirici/sistem düzeyinde bir kavram... gerçek son-kullanıcıya anlamlı bir arayüz sunacak kadar somut DEĞİL" (ADR-0035 §h'nin kendi gerekçesi). **Bu ADR'nin kaydı KATEGORİK OLARAK farklı bir olgunluk seviyesinde doğuyor:** her `AgentActionRecord` VAR OLAN, insan-okunabilir bir mutasyonun (bir görev oluşturuldu, bir izin verildi, bir mention'a yanıt verildi) niyet/gerekçe/kaynak/geri-alma açıklamasını taşıyor — ertelemek, Epik F3-E2'nin ("Cam Kutu Otonomi") KENDİ BAŞLIK VAADİNİ (şeffaflık) belirsiz sayıda gelecekteki görev boyunca karşılıksız bırakırdı. Yeni salt-okunur panel `apps/web/src/views/shared/FlightRecorderPanel.tsx`, `AutomationHistoryPanel.tsx`'in düz-liste-diyalogsuz konvansiyonunu BİREBİR izler: her satırda niyet, gerekçe, kaynaklar (etiket listesi), geri-alma-planı açıklaması, actor, `occurredAt`, çıktı rozeti (`succeeded`/`partially_succeeded`/`failed`/`rejected`). Yeni `useAgentActionRecordsQuery(workspaceId)` hook'u `useProposalsQuery`'yi yansıtır. Hiçbir düzenleme/aksiyon butonu YOK (salt-okunur) — F3-T6 gelene kadar "geri al" butonu İCAT EDİLMEZ.

### (i) Geçmişe dönük backfill duruşu — YOK, defter yalnızca BUNDAN SONRAKİ aksiyonları kapsar

Mevcut `command_proposals`/`agent_action_executions` satırları için HİÇBİR backfill/geriye-dönük-türetme işi YAPILMAZ — bu ADR'nin migration'ı canlıya çıktıktan SONRA gerçekleşen aksiyonlar için kayıt tutmaya başlar. **Bu açıkça, örtük bırakılmadan kayda geçiriliyor:** Flight Recorder paneli BOŞ başlar ve yalnızca yeni etkinlikle büyür; geçmiş kararlı-aksiyonlar KENDİ mevcut görünümlerinden (Command Proposals geçmişi) hâlâ görülebilir, ama geçmiş mention-yanıtları için (o zaman `agent_action_executions`'ın hiç rationale/kaynak taşımadığı) YENİDEN İNŞA EDİLECEK hiçbir şey YOK. **Gerekçe:** `command_proposals.actions`'ın serbest-metin `rationale`/`rollbackNote`'unu bugünkü yapılandırılmış `ActionResourceReference[]`/`RollbackPlan`'a GÜVENİLİR biçimde dönüştürecek deterministik bir kural YOK (fact #1'in tarif ettiği TAM OLARAK bu — kırılgan, çakışma-riskli bir yeniden-yorumlama); sahte-kesinlikli bir backfill yazmak, hiç backfill yapmamaktan DAHA KÖTÜ bir denetim riski olurdu.

## Somut Şekiller

```ts
// packages/agent-runtime/src/agent-action-record.ts
export type ActionProvenance = 'decided' | 'autonomous';
export type AgentActionOutcome = 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';

export type ActionResourceReference =
  | { kind: 'object'; objectId: string }
  | { kind: 'comment'; commentId: string }
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'agent'; agentIdentifier: string }
  | { kind: 'external'; label: string };

export interface RollbackPlan {
  kind: 'delete' | 'revertFieldValue' | 'revokePermission' | 'manual' | 'none';
  targetResource?: ActionResourceReference;
  description: string;
}

export interface AgentActionRecord {
  id: string;
  workspaceId: string;
  provenance: ActionProvenance;
  actor: Actor;
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: AgentActionOutcome;
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
  occurredAt: Date;
}
```

```ts
// apps/server/src/db/schema/agent-action-records.ts
export const agentActionRecords = pgTable(
  'agent_action_records',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provenance: varchar('provenance', { length: 20 }).notNull(), // 'decided' | 'autonomous'
    actor: jsonb('actor').notNull(),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    intent: text('intent').notNull(),
    rationale: text('rationale').notNull(),
    resources: jsonb('resources').notNull(), // ActionResourceReference[]
    rollbackPlan: jsonb('rollback_plan').notNull(),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    resultRef: jsonb('result_ref'), // ActionResourceReference | null
    causationEventId: uuid('causation_event_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_action_records_workspace_occurred_idx').on(table.workspaceId, table.occurredAt),
  ],
);
```

Migration: `00XX_*.sql`, mevcut en yeni migration'ın devamı olan ilk boş numara — down script'iyle birlikte (CLAUDE.md: "Migration'ı down script'i olmadan yazma").

Servisler: `AgentActionRecordsService` (`record`/`list`/`get`, `AgentResourceLimitsService.recordAgentAction`'ın best-effort-asla-fırlatmaz + kayıt-başına-taze-stream deseni), event tipi `AgentActionRecorded`, stream tipi `'agent-action-record'`.

**RBAC özeti:** Ledger okuma (`list`/`get`) = member+, workspace-genelinde (kişisel kısıtlama YOK); ledger yazma = HİÇBİR HTTP uç noktası yok, yalnızca dahili servis çağrıları (`executeXxx`'ler ve `MentionActionWorker`) yazar.

## Alternatifler ve Reddedilme Gerekçeleri

- **`command_proposals.actions` jsonb'ini `actionId`'ye göre `decide()`-sonrası yeniden ayrıştırmak.** Reddedildi (Karar c) — çakışma-riskli, kırılgan; her `executeXxx`'in KENDİ zaten bildiği somut değerlerle kaydı YAZMASI hem daha basit hem daha güvenilir.
- **`agent_action_executions`'ı yeni ledger'a GENİŞLETMEK/BİRLEŞTİRMEK (ayrı tablo yerine).** Reddedildi (Karar d) — `agent_action_executions` `assertActionRateNotExceeded`'ın performans-kritik SAYIM sorgusunun dayanağı; şemasını zenginleştirmek o sorgunun basitliğini/hızını riske atardı, üstelik hız-sınırı sayımı `provenance`/`rationale` gibi alanlara hiç ihtiyaç duymuyor.
- **Ledger-yazımını `SkillExecutionService.executeSkill`'in İÇİNE genelleştirmek.** Reddedildi (Karar d) — ADR-0037 `executeSkill`'in sabit sırasını AÇIKÇA yeniden açılmaz ilan etti; `executeSkill`'in TEK gerçek çağıranı bugün `MentionActionWorker` olduğundan (ADR-0037), bunu jenerik parametrelerle genişletmek varsayımsal gelecekteki çağıranlar için önden mühendislik olurdu.
- **`resources[]`'ı AI'nın orijinal `ProposedAction.resources: string[]` düzyazısından türetmek.** Reddedildi (Karar f) — doğrulanmamış serbest metne yapılandırılmış bir kaynak-referansı görünümü vermek YANLIŞ güven kazandırırdı; her çağrı noktası kendi bildiği somut id'lerden inşa eder.
- **F3-T4'ün KENDİSİNİN gerçek bir geri-alma/undo uç noktası sağlaması.** Reddedildi (Karar g) — bu F3-T6'nın kapsamı; bu ADR yalnızca YAPISAL bir `RollbackPlan` TARİFİ kaydeder, hiçbir ters-mutasyon YÜRÜTMEZ.
- **Revoke-öncesi manifesto durumunu snapshot'layıp `revoke` için yapısal bir ters-işlem tarif etmek.** Reddedildi (Karar g) — v0 için gereksiz kapsam (YAGNI); `kind:'manual'` yeterli, gerçek bir ihtiyaç doğarsa ayrı bir genişletme gerektirir.
- **Frontend'i F3-T6'ya (gerçek geri-alma UI'ı geldiğinde) ertelemek.** Reddedildi (Karar h) — Epik'in başlık vaadi (şeffaflık) belirsiz sayıda görev boyunca karşılıksız kalırdı; F3-T1'in v0-backend-only emsali burada UYGULANMAZ çünkü bu kaydın olgunluk seviyesi (zaten insan-okunabilir mutasyonlara bağlı) F3-T1'in henüz-somut-olmayan `agentIdentifier` kavramından kategorik olarak farklı.
- **Geçmiş `command_proposals`/`agent_action_executions` satırları için backfill yazmak.** Reddedildi (Karar i) — güvenilir bir deterministik dönüşüm kuralı yok; sahte-kesinlikli bir backfill hiç backfill yapmamaktan daha kötü bir denetim riski olurdu.

## Mimari Değişmezlerle İlişki

- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** **Bu ADR bu değişmezi yalnızca "ihlal etmeyen" değil, gerçekten GERÇEKLEŞTİREN İLK ADR'dir** — `AgentActionRecord`'un dört alanı (`intent`, `rationale`, `resources`, `rollbackPlan`) bu cümlenin dört bileşenine BİREBİR karşılık gelir, hem `decide()`-yürütülen hem otonom mention→beceri yolu için gerçekten YAZILIR (yalnızca düzyazı olarak var olmaktan çıkıp somut, sorgulanabilir bir kayda dönüşür). `docs/PLAN.md`'nin "şema hook + CI eval ile zorlanır" ifadesindeki CI-eval zorlaması bu ADR'nin kapsamı DIŞINDA — bu ADR şemayı/kaydı kurar, derleme-zamanı/CI-zamanı zorlama ayrı, gelecekteki bir görev/karar gerektirir.
- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** `agent_action_records` `AgentActionRecorded` olaylarının salt bir projeksiyonu — `agent_action_executions`'ın AYNI (olay-kaynaklı-defter) kategorisinde, ADR-0035'in zaten kurduğu emsalin devamı.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR hiçbir export uç noktasına dokunmuyor.
- **Hassas veri sınıflarının buluta ham gönderilmemesi.** Bu ADR hiçbir yeni AI-sağlayıcı çağrısı eklemiyor — mevcut `parseCommand`/`answerQuestion` çağrı yollarının SONUÇLARINI kaydediyor, kendisi bir AI çağrısı yapmıyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- CLAUDE.md'nin kuruluştan beri düzyazı olarak var olan "Ajan aksiyonları..." değişmezi artık HEM `decide()`-yürütülen HEM otonom mention→beceri aksiyonları için GERÇEK, sorgulanabilir bir kayıtla destekleniyor.
- `executeReconfigureAgentPermissions`/`executeAssignPeople`'ın bugün SIFIR olan `causationEventId` izlenebilirliği (fact #1) kapatıldı.
- Epik F3-E2'nin başlık vaadi (şeffaflık) F3-T4'ün kendisinde, F3-T6'yı beklemeden, salt-okunur bir panel ile kullanıcıya görünür hale geliyor.
- `agent_action_executions`'ın hız-sınırı sorumluluğu HİÇ dokunulmadan korunuyor — yeni ledger onun YERİNE geçmiyor, riski/performans profilini bozmuyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- Gerçek geri-alma/undo YOK (Karar g) — `RollbackPlan` yalnızca YAPISAL bir tarif; F3-T6 bunu gerçekten çalıştıracak ayrı bir görev.
- CI-eval şema-zorlaması YOK (PLAN.md'nin "şema hook + CI eval ile zorlanır" ifadesinin CI-eval kısmı) — bu ADR şemayı/kaydı kurar, derleme-zamanı zorlama ayrı bir gelecekteki karar.
- Geçmiş aksiyonlar için backfill YOK (Karar i) — defter yalnızca bu ADR'nin migration'ından SONRAKİ aksiyonları kapsar, kasıtlı ve açıkça kayda geçirilmiş bir sınırlama.
- Çoklu-kaynaklı aksiyonlar (`generateSubtasks`) ve `reconfigureAgentPermissions`'ın `revoke` dalı için `RollbackPlan.targetResource`/yapısal ters-işlem eksik/tekil kalıyor (Karar g) — tam N-kaynaklı orkestrasyon ve revoke-öncesi snapshot'lama F3-T6'nın veya ayrı bir gelecekteki genişletmenin kapsamı.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E2/F3-T4-ajan-aksiyon-kayit-defteri.md`) `docs-writer` ile paralel yazılıyor. Bu ADR'nin onayı üzerine PR1'e (`packages/agent-runtime` saf domain: `AgentActionRecord`/`ActionResourceReference`/`RollbackPlan` tipleri + olay şemaları) `test-writer` ile başlanır:

```
docs/adr/ADR-0038-ajan-aksiyon-kayit-defteri.md'deki Karar (a)-(i)'yi ve
docs/specs/F3-E2/F3-T4-ajan-aksiyon-kayit-defteri.md'nin Kabul Kriterleri'ni temel alarak, F3-T4
PR1 (packages/agent-runtime saf domain: AgentActionRecord/ActionResourceReference/RollbackPlan
tipleri, AgentActionRecorded olay şeması) için test-writer ile başarısız testleri yaz.
```
