# ADR-0032: Tetikleyici/Koşul/Aksiyon Çekirdeği (Zamanlanmış Tetikleyiciler + Regex Koşullar)

**Durum:** Kabul edildi (Plan Mode oturumunda, bir `Plan` subagent pressure-test'iyle insan onayı zaten alındı — bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-02
**İlgili görev:** [F2-T15 — Tetikleyici/Koşul/Aksiyon Çekirdeği](../specs/F2-E4/F2-T15-tetikleyici-kosul-aksiyon-cekirdegi.md)
**İlgili plan referansı:** [ADR-0031](./ADR-0031-toplanti-saklama-tercihi-ve-aksiyon-onerisi.md) (F2-T14, `CommandsService.recordProposal()`'ın genelleştirildiği ve `createTaskFromMeeting`'in eklendiği emsal — bu ADR üçüncü çağıranı ekler), [ADR-0015](./ADR-0015-konusma-komutlari-ajan-aksiyon-sozlesmesi.md) (F1-T16, öner→onayla temel sözleşmesi), [ADR-0010](./ADR-0010-yinelenen-gorev-uretimi.md) (`ObjectsService.setFieldValues`'a gömülü tek inline-tetikleme emsali — bu ADR'nin (a) kararının reddettiği alternatif budur).

> Bu ADR, spec'in kendi "⚠️ MİMARİ-KARAR GEREKTİREN GÖREV" işaretinin (a)/(b) fıkralarına karşılık gelir: (a) reaktivite modeli event-sourcing mimari değişmeziyle doğrudan etkileşiyor, (b) `matches` operatörünün paylaşılan F1-T6 sözleşimine mi ekleneceği yoksa izole mi kalacağı gelecekteki görevlere dayatılan bir karar. Aşağıdaki (a)-(n) maddeleri, Plan Mode oturumunda `Plan` subagent'ının pressure-test'iyle netleşen kararların birebir kaydı — ADR-0030'un tek dosyada (a)'dan (j)'ye kadar birden fazla kararı topladığı emsal burada da izleniyor.

## Bağlam

Bir `explorer` dispatch'i + `Plan` subagent pressure-test'iyle doğrulanan mevcut durum (ayrıntılar spec'in "Mevcut Durum" bölümünde):

1. `packages/automation/` henüz yok.
2. Zamanlanmış iş için üç emsal (`calendar-sync-poller.service.ts`, `meeting-retention-sweeper.service.ts`, `context-graph-sync.worker.ts`) hepsi aynı elle-yazılmış `OnModuleInit`/`OnModuleDestroy`+`setInterval` desenini paylaşıyor; hiçbir yerde `@nestjs/schedule` yok.
3. `CommandsService.recordProposal()` (`commands.service.ts:273-310`) zaten genelleştirilmiş durumda — imzası `(workspaceId, actor, actions, sourceObjectId, command, parseError, message?)`; F2-T14'ün `proposeFromMeeting()`'i ikinci çağıranı, bu görev üçüncü çağıranı ekliyor.
4. `ProposedAction.type`'ın bugünkü hâli (`parse-command.ts:28`): `'createTask' | 'generateSubtasks' | 'assignPeople' | 'createTaskFromMeeting'`; `executeDecidedAction`'ın (`commands.service.ts`) exhaustive switch'i derleme-zamanında eksik case'i yakalıyor.
5. F1-T6'nın `FILTER_OPERATORS`'ı (`packages/shared/src/query/query-spec.ts:8`) sabit literal dizisi, `matches` yok; bu filtreler SQL predicate'lerine derleniyor (performans için).
6. Olay-tabanlı ("alan değiştiğinde") tetikleyiciler için genel bir abonelik noktası yok — tek emsal (task recurrence, ADR-0010) `ObjectsService.setFieldValues`'a gömülü, senkron bir çağrı.
7. `saved_views` şeması (ULID id + stream_id + workspace_id + jsonb spec + nullable owner_id + lifecycle) tetikleyici-tanımı-saklama için güçlü bir emsal; `packages/memory`'nin `core-objects`'e bağımlı olmayan bağımsız paket yapısı (deps: yalnızca `zod`, bkz. `packages/memory/package.json`) paket-yerleşimi kararı için doğrudan emsal.
8. `saved-views.service.ts:90,199`'un `hasAtLeastRole(callerRole, 'admin')` deseni (paylaşılan/workspace-genelinde config yazma = admin+) RBAC kararı için doğrudan emsal.

## Karar

### (a) Reaktivite modeli: periyodik `objects_view` polling, `ObjectsService`'e DOKUNULMAZ

Koşul-tetikleyicileri sabit 2 dakikalık aralıkta `objects_view`'ı tarar (elle-yazılmış `OnModuleInit`/`OnModuleDestroy`+`setInterval` deseni — `@nestjs/schedule` kullanılmaz, bu kütüphane kod tabanının hiçbir yerinde yok). `ObjectsService.setFieldValues`'a genel bir "tetikleyicileri değerlendir" kancası **eklenmez**. İki gerekçe:

1. `setFieldValues` zaten mimari-kritik: recurrence (ADR-0010), formula alanları, AI-refresh, arama-indeksi yan-etkileri tek sırada bu tek servisten zincirleniyor. Yeni bir genel "her tetikleyiciyi değerlendir" kancası eklemek onun blast radius'unu her gelecekteki tetikleyici-motoru hatasına karşı savunmasız kılar.
2. Bir tetikleyicinin ürettiği aksiyon YENİ bir nesne yazabilir, ve bu yeni nesne başka (veya aynı) bir tetikleyiciyi ateşleyebilir. Inline bir kanca bu durumda sınırsız özyinelemeli tetiklenme riski taşır (aksiyon → yeni nesne → aynı çağrı yığınında tekrar değerlendirme → potansiyel sonsuz zincir). Polling bu zinciri otomatik kırar: yeni nesne yalnızca BİR SONRAKİ poll tick'inde, temiz ve sınırlı bir geçişle değerlendirilir.

### (b) Dedup tasarımı: `automation_trigger_matches`, PK `(trigger_id, object_id)`, düşen-kenar yeniden-silahlandırma

Her poll tick'i, bir koşul-tetikleyicisi için mevcut eşleşen nesne-id kümesini hesaplar (kapsam: `workspaceId` + `objectType` + `lifecycle != 'deleted'`), önceki (saklanan) eşleşme kümesiyle diff'ler:

- **Yeni eşleşen** → `proposeFromTrigger` çağrılır + `automation_trigger_matches` satırı eklenir.
- **Artık eşleşmeyen** → satır silinir (kasıtlı "düşen kenar yeniden silahlandırır" semantiği — bir nesne eşleşmeyi bırakıp tekrar eşleşirse tekrar ateşlenebilir).
- **Hâlâ eşleşen** → no-op.

Bu, "her genuine geçişte bir kez ateşlenir" semantiğini garanti eder, "her poll tick'inde ateşlenir" değil.

### (c) `lastFiredAt` denormalize kolonu (zamanlanmış) vs sabit 2 dakikalık poll (koşullu)

Zamanlanmış tetikleyiciler kendi `lastFiredAt` kolonlarını `automation_triggers` üzerinde doğrudan taşır (denormalize) — "sırası geldi mi" kontrolü ucuz bir kolon karşılaştırmasıyla yapılır. Koşul-tetikleyicileri için poll aralığı sabit ve kullanıcı-yapılandırılamaz (2 dakika) — her tetikleyici için ayrı bir zamanlayıcı açmaz, tek bir `setInterval` tüm aktif koşul-tetikleyicilerini tek tick'te değerlendirir.

### (d) `matches` operatörü `packages/automation`'a İZOLE kalır, paylaşılan `FILTER_OPERATORS`'a EKLENMEZ

v0 zaten tek-koşullu (filtre ağacı yok) — `FilterCondition`'ı yeniden kullanmaya gerçek bir ihtiyaç yok. Daha kritik olarak, F1-T6'nın filtreleri SQL predicate'lerine derleniyor (performans için), bu motor ise satırı Node'a çekip JS `RegExp.test()` çalıştırmak zorunda (ReDoS azaltımının JS-tarafında yönetilebilir olması için, bkz. Karar e) — bunlar iki farklı çalıştırma modeli. "Yalnızca bir enum literal'i eklemek" gerçekte tek satırlık bir değişiklik DEĞİL: bağımsız olarak gözden geçirilmiş bir SQL-tarafı uygulaması da gerektirirdi. Bu, kalıcı olarak reddedilmiyor — gelecekte olası bir BİRLEŞTİRME olarak açıkça ertelenmiş bir karar.

### (e) ReDoS azaltımı: bağımlılıksız, 4-katmanlı savunma (`packages/automation/src/regex-safety.ts`)

`assertSafeRegexPattern(pattern, flags)`, HEM yazma-zamanında (tetikleyici oluşturma/güncelleme doğrulaması) HEM okuma-zamanında (değerlendiricide savunmacı yeniden-doğrulama — `commands.service.ts`'in ham bir DB düzenlemesinin yazma-zamanı kontrollerini atlayabileceği aynı gerekçeyle kendi okuma-zamanı yeniden-doğrulama disiplinini yansıtıyor) çağrılır:

1. **Desen uzunluk sınırı** — 200 karakter.
2. **Statik iç-içe-nicelik-belirteci reddi** — `(a+)+` gibi klasik catastrophic-backtracking şekillerini yakalayan bir reddet-listesi; kodda/testte açıkça "azaltım, garanti değil" olarak belgelenir (ReDoS tespiti genel olarak karar-verilemez).
3. **Değerlendirme-zamanı GİRDİ uzunluk sınırı** — test edilen alan değeri `.test()`'ten önce 5000 karaktere kırpılır. Bu ASIL YÜK TAŞIYAN savunmadır: katman (2)'yi atlatan bir desen için bile en kötü-durum patlamasını sınırlar.
4. **Bayrak izin-listesi** — yalnızca `i` kabul edilir; `g`/`m`/`s`/`u`/`y` reddedilir (boolean bir eşleşme testi için gerekli değiller; `g` özellikle stateful `lastIndex` ayak-tuzakları taşır).

### (f) Yeni aksiyon tipi: `createTaskFromTrigger`, ŞABLONLAMA YOK

`apps/server/src/ai/parse-command.ts`'in `ProposedAction.type` union'ına (bugün `'createTask' | 'generateSubtasks' | 'assignPeople' | 'createTaskFromMeeting'`) `'createTaskFromTrigger'` eklenir, `proposedActionSchema`'nın zod `z.enum(...)`'ına da aynı literal eklenir — ADR-0031 §e'nin `createTaskFromMeeting` ekleme desenini birebir tekrarlar. `executeDecidedAction`'ın exhaustive switch'ine (`commands.service.ts`) yeni bir `case 'createTaskFromTrigger'` eklenir.

`proposeFromMeeting`'in aksine bu KRİTİK ölçüde daha basit: hiçbir AI sağlayıcı çağrısı yok, hiçbir `AIUsageService` kota/bütçe kontrolü gerekmez — `params.title` tetikleyici-oluşturma-zamanında yazılan SABİT bir şablon dizesidir. v0'da AÇIKÇA `{{field}}` interpolasyonu/şablonlaması YOK (bu, kaçış/injection bir görev başlığına, silinen/yeniden-adlandırılan-alan referansı gibi ilgisiz bir alt-problem açar — kasıtlı olarak kapsam dışı, gerekirse gelecekteki ayrı bir karar).

Yeni sabit aktör `TRIGGER_ENGINE_ACTOR = { type: 'agent', id: 'trigger-engine' }`, `COMMAND_PARSER_ACTOR`/`MEETING_ACTION_EXTRACTOR_ACTOR`'dan ayrı (aynı denetlenebilirlik gerekçesi — hangi `ActionsProposed`'ın hangi kaynaktan geldiği `actor.id`'den ayrıştırılabilir).

Yeni `CommandsService.proposeFromTrigger(workspaceId, triggerId, sourceObjectId, actions)`, MEVCUT `recordProposal` özel yardımcısını DEĞİŞTİRMEDEN çağırır (bu yardımcı zaten F2-T14 sırasında tam olarak gelecekteki bir üçüncü çağıranı desteklemek için genelleştirilmişti):

```ts
const TRIGGER_ENGINE_ACTOR = { type: 'agent', id: 'trigger-engine' } as const;

async proposeFromTrigger(
  workspaceId: string,
  triggerId: string,
  sourceObjectId: string,
  actions: ProposedAction[],
): Promise<CommandsServiceParseResult> {
  return this.recordProposal(
    workspaceId,
    TRIGGER_ENGINE_ACTOR,
    actions,
    sourceObjectId,
    `[trigger] triggerId=${triggerId}`,
    /* parseError */ false, // hiçbir AI-parse yok, dolayısıyla parse hatası da yok
  );
}
```

`command` alanı sentetik, kısa bir dize taşır (ADR-0031 §f'nin `[meeting-action-extraction] meetingObjectId=...` deseninin birebir aynısı) — `parseError` her zaman `false`.

### (g) Eksik alan-tanımı: zarif bozulma, asla fırlatma

Bir koşul-tetikleyicisinin referans verdiği `objectType`/`fieldKey` çiftinin alan tanımı sonradan silinmişse, değerlendirici bunu "eşleşme yok, bu döngüde bu tetikleyiciyi atla" olarak ele alır — asla fırlatmaz, asla diğer tetikleyiciler için poll döngüsünü durdurmaz. Oluşturma-zamanında bilinmeyen çiftler reddedilir (yazma-zamanı doğrulama), ama alan tanımları tetikleyiciden bağımsız olarak silinebildiği için post-hoc zarif bozulma zorunludur.

### (h) RBAC: yazma admin+, okuma member+ — düz kural, ownership-branch YOK

Tetikleyici tanımı yazmaları (`POST`/`PATCH`/silme) `admin`+ gerektirir; okumalar (`GET`) `member`+ yeterlidir. `SavedViewsService.assertCanMutate`'in kişisel-vs-paylaşılan ayrımının (`saved-views.service.ts:191-202`) AKSİNE hiçbir ownership-branch karmaşıklığı yok — bir tetikleyici HER ZAMAN workspace-genelinde, asla kişisel değil. Doğrudan emsal: `saved-views.service.ts:90` ve `:199`'un `hasAtLeastRole(callerRole, 'admin')` deseni (paylaşılan/workspace-genelinde config yazma).

### (i) Paket yerleşimi: `packages/automation`, YENİ ve BAĞIMSIZ

`packages/memory`'nin bağımsız yapısını izler (deps: `zod`, `@luminaos/shared`, `ulid`) — `saved-views`'ın `core-objects`'e gömülü yapısının AKSİNE, `core-objects`'e HİÇBİR bağımlılık yok. Bu motor object/field-type makinesine ihtiyaç duymuyor, yalnızca kendine ait bir `Trigger` domain şekline (`trigger.ts`: discriminated `ScheduleSpec`/`ConditionSpec` union + `ActionTemplate`), saf komut fonksiyonlarına (`trigger-commands.ts`, `saved-view-commands.ts` deseni) ve olay-replay'ine (`trigger-replay.ts`, `saved-view-replay.ts` deseni) ihtiyaç duyuyor.

### (j) Anti-runaway güvenlik: `automation_trigger_matches` büyüme tavanı

Tek bir koşul-tetikleyicisinin poll tick'i, **N=50**'den fazla YENİ eşleşme satırı eklemeye çalışıyorsa bu tick reddedilir/loglanır (`Logger.warn`, yalnızca `triggerId`/eşleşme-sayısı — hiçbir nesne içeriği) — kötü-kapsamlanmış bir koşulun (ör. neredeyse-her-şeyi-eşleyen bir `objectType: 'task'` deseni) tek bir döngüde binlerce öneriyi sessizce spamlamasına karşı savunma.

**İnsan kararı (bu ADR'nin insan onayı sırasında netleşti):** reddedilen bir tick, tetikleyiciyi devre dışı BIRAKMAZ — tetikleyici `active` kalır ve bir SONRAKİ poll tick'inde aynı kontrol tekrar uygulanır (kalıcı olarak kötü-kapsamlanmış bir tetikleyici her tick'te tekrar reddedilir/loglanır, sonsuza kadar görünür kalır). Otomatik devre-dışı-bırakma (ör. "3 ardışık reddetmeden sonra `lifecycle: 'disabled'`") KASITLI OLARAK v0 kapsamı dışında bırakıldı — yeni bir lifecycle durumu + yeniden-etkinleştirme UI/API'si gerektirirdi, bu görevin kapsamını genişletirdi. Kötü-kapsamlanmış bir tetikleyiciyi düzeltmek/silmek admin'in elle sorumluluğunda kalır (log satırı bunu keşfedilebilir kılar).

### (k) Her eşleşen nesne için AYRI `proposeFromTrigger` çağrısı

Tek bir dev batch öneri YOK — her yeni-eşleşen nesne kendi `ActionsProposed` olayını alır (kendi `proposeFromTrigger` çağrısı). Bu, `decide()`'ın mevcut `MAX_DECISIONS_PER_CALL` sözleşmesini anlamlı tutar VE her nesnenin önerisini bağımsız onaylanabilir/reddedilebilir kılar — ADR-0015'in aksiyon-başına karar granülerliğiyle tutarlı.

### (l) `kind: 'scheduled' | 'condition'` — tip-seviyesinde discriminated union

Saklanan `spec` jsonb kolonunun şekli tip-seviyesinde ayrıştırılır: bir zamanlanmış tetikleyicinin spec'i asla sarkan bir `fieldKey`/`pattern` taşımaz, ve tersi de geçerli değildir (`packages/automation/src/trigger.ts`'in `ScheduleSpec`/`ConditionSpec` union'ı bunu derleme-zamanında garanti eder).

### (m) Tüm sorgular `workspaceId`'yi SQL `WHERE` seviyesinde sınırlar

`objects_view`/`automation_triggers` sorgularının hiçbiri cross-workspace fetch edip sonra JS'te filtrelemez — kapsam her zaman SQL predicate'inde.

### (n) Test hijyeni: `onModuleInit()` testlerde ASLA çağrılmaz

Yeni servisler (`TriggerSchedulerService`, `TriggerConditionEvaluatorService`) testlerde `onModuleInit()`'i hiç çağırmaz (canlı bir `setInterval`'ı test sürecine sızdırır) — yalnızca kendi doğrudan-çağrılabilir `runOnce()`/`evaluateOnce()` public metotları testlerde egzersiz edilir. Bu, `calendar-sync-poller.service.ts` ve `meeting-retention-sweeper.service.ts`'in zaten kurduğu konvansiyonun birebir devamı.

## Şema Taslağı

```ts
// apps/server/src/db/schema/automation-triggers.ts
export const automationTriggers = pgTable(
  'automation_triggers',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(), // 'scheduled' | 'condition'
    spec: jsonb('spec').notNull(), // discriminated ScheduleSpec | ConditionSpec
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }), // yalnızca 'scheduled' kullanır
    lifecycle: varchar('lifecycle', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('automation_triggers_workspace_id_lifecycle_idx').on(table.workspaceId, table.lifecycle),
    index('automation_triggers_workspace_id_kind_lifecycle_idx').on(
      table.workspaceId,
      table.kind,
      table.lifecycle,
    ),
  ],
);

// apps/server/src/db/schema/automation-trigger-matches.ts
export const automationTriggerMatches = pgTable(
  'automation_trigger_matches',
  {
    triggerId: varchar('trigger_id', { length: 26 }).notNull(),
    objectId: varchar('object_id', { length: 26 }).notNull(), // FK'siz, objects_view'a düz referans
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.objectId] })],
);
```

`objectId` kasıtlı olarak FK'siz — `saved-views`'ın kendi `sourceObjectId` alanları ve ADR-0030'un `meeting_details.objectId`'sinin `objects_view`'a FK'siz referans verme desenini izler (`objects_view` fiziksel bir tablo değil, bir projeksiyon).

## PR Bölünmesi

1. **PR1** — `packages/automation` paket iskeleti (`trigger.ts`/`trigger-commands.ts`/`trigger-replay.ts`/`regex-safety.ts`/`condition-evaluator.ts`) + unit testler + `automation_triggers`/`automation_trigger_matches` şeması + migration (down script dahil). Sunucu bağlama YOK.
2. **PR2** — `AutomationTriggersService`/`Controller`/`Projection` CRUD + `AutomationModule` + entegrasyon testleri (RBAC, cross-workspace CRUD izolasyonu).
3. **PR3** — `CommandsService.proposeFromTrigger` + `createTaskFromTrigger` tipi + `executeCreateTaskFromTrigger` + entegrasyon testleri.
4. **PR4** — `TriggerSchedulerService` (zamanlanmış tetikleyiciler) + entegrasyon testleri (periyodik ateşleme, `lastFiredAt` güncellemesi, per-tetikleyici try/catch izolasyonu).
5. **PR5** — `TriggerConditionEvaluatorService` (regex koşulları + match/diff dedup) + entegrasyon testleri (eşleşme/eşleşmeme, kenar-yeniden-tetikleme, cross-workspace izolasyonu, ReDoS-deseni reddi).

## Alternatifler ve Reddedilme Gerekçeleri

- **`ObjectsService.setFieldValues`'a inline bir "tetikleyicileri değerlendir" kancası eklemek.** Reddedildi (Karar a) — mevcut TEK emsal olsa da (ADR-0010'un recurrence'ı), bu servisin blast radius'unu her gelecekteki tetikleyici-motoru hatasına açar VE bir tetikleyicinin ürettiği aksiyonun yeni bir nesne yazıp başka bir tetikleyiciyi aynı çağrı yığınında ateşleyebileceği sınırsız özyinelemeli tetiklenme riskini taşır.
- **`matches` operatörünü paylaşılan `FILTER_OPERATORS`'a eklemek.** Reddedildi (Karar d) — F1-T6'nın filtreleri SQL'e derleniyor, bu motor Node'da JS regex çalıştırıyor; bu iki farklı çalıştırma modeli "tek satırlık enum eklemesi"ni bağımsız gözden geçirilmesi gereken bir SQL-tarafı uygulamasına dönüştürürdü. Gelecekte olası bir birleştirme olarak ertelendi, kalıcı olarak reddedilmedi.
- **Zaman-aşımlı/worker-thread'li regex çalıştırıcısı (ReDoS için).** Reddedildi (spec'in kendi Açık Soru 3'ünün önerisi, bu ADR'de onaylandı) — ekstra bir bağımlılık/karmaşıklık gerektirirdi; dependency-free 4-katmanlı statik+giriş-uzunluğu savunması (Karar e), özellikle katman (3)'ün giriş-uzunluğu sınırı, pratik ReDoS riskini kabul edilebilir bir düzeye indiriyor.
- **`createTask`'ı doğrudan yeniden kullanmak (yeni bir `createTaskFromTrigger` tipi açmadan).** Reddedildi — ADR-0031'in aynı gerekçesiyle tutarlı: `executeCreateTask` yalnızca `params.title` okuyor, gelecekte tetikleyici-özel alanlar eklenirse (bugün yok ama) sessizce kaybolurdu; ayrı bir tip izole bir blast radius sağlıyor.
- **`{{field}}` şablon interpolasyonunu v0'a dahil etmek.** Reddedildi (Karar f) — kaçış/injection bir görev başlığına ve silinen/yeniden-adlandırılan-alan referansı gibi ilgisiz bir alt-problem açar; sabit şablon metni v0 için yeterli.
- **Tek bir batch `ActionsProposed` olayında birden fazla eşleşen nesneyi bildirmek.** Reddedildi (Karar k) — `decide()`'ın aksiyon-başına onay/red granülerliğini bozar, `MAX_DECISIONS_PER_CALL` sözleşmesini anlamsızlaştırırdı.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** Tetikleyici TANIMLARININ kendisi olay-kaynaklıdır (`TriggerCreated`/`TriggerUpdated`/`TriggerDeleted`, `saved-view-commands.ts`/`saved-view-replay.ts` deseninin birebir aynısı) — `automation_triggers` bu olayların salt bir okuma-modeli projeksiyonudur. `automation_trigger_matches` ise SAF türetilmiş dedup-durumudur, bir doğruluk kaynağı DEĞİL: tamamen yeniden-inşa edilebilir (bir poll tick'i, mevcut eşleşen nesne kümesini `objects_view`'dan yeniden hesaplayıp bu tabloyu sıfırdan senkronize edebilir) — tablo yok edilse bile hiçbir bilgi kalıcı olarak kaybolmaz, yalnızca bir sonraki poll tick'i her mevcut eşleşmeyi "yeni" olarak yeniden değerlendirir. Bu, event log'un tek doğruluk kaynağı olma değişmezini ihlal etmez.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Tetikleyici-üretimli `ActionsProposed` olayları bu sözleşmeyi `ProposedAction`'ın VAR OLAN `intent`/`rationale`/`resources`/`rollbackNote` alan şekli üzerinden AYNEN taşır — yeni bir payload şekli İCAT EDİLMEZ, ADR-0015'in zaten kurduğu sözleşme dördüncü bir aksiyon-tipine (`createTaskFromTrigger`) genişler.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR hiçbir export uç noktasına dokunmuyor, bu değişmezle bir ilişkisi yok.

## İnsan Onayı (ADR taslağından sonra, implementasyondan önce)

- **Karar (j)'nin eşiği ve reddedilen-tick politikası:** N=50, sürekli logla — reddedilen bir tick tetikleyiciyi devre dışı bırakmaz, tetikleyici `active` kalır ve her sonraki tick'te aynı kontrol tekrar uygulanır. Otomatik devre-dışı-bırakma (ör. ardışık N reddetmeden sonra `lifecycle: 'disabled'`) kasıtlı olarak v0 kapsamı dışında bırakıldı.

## Sonuçlar

- `packages/automation` yeni, bağımsız bir domain paketi olarak açılır (`core-objects`'e bağımlı değil); gelecekteki otomasyon-ilişkili görevler (F2-T16, F2-T17) bu paketi genişletir.
- Koşul-tetikleyicileri gerçek-zamanlı DEĞİL, en fazla 2 dakikalık gecikmeyle çalışır — bu, mimari izolasyon için kabul edilen bir gecikme (F2-T14'ün sweeper'larıyla aynı ruh).
- `matches` operatörünün F1-T6'ya birleştirilmesi gelecekte ayrı bir karar/ADR gerektirir; bu ADR o kapıyı kapatmaz, yalnızca v0 kapsamını izole tutar.
- `packages/shared`'ın `FILTER_OPERATORS`'ı bu görevden ETKİLENMEZ — F1-T6'nın sorgu DSL'i/UI'ı değişmeden kalır.
- `CommandsModule`'ün `CommandsService`'i export etmesi ADR-0031 §g ile ZATEN sağlanmış durumda — bu ADR'nin `AutomationModule`'ünün `CommandsModule`'ü import edip `CommandsService`'i enjekte edebilmesi için ek bir değişiklik gerekmez.

---

**Sıradaki adım:** Bu ADR insan onayına sunulur. Onaylanırsa PR1'den başlayarak her PR için ayrı `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir:

```
Şu an F2-T15 PR1'e başlıyoruz: packages/automation paket iskeleti
(trigger.ts/trigger-commands.ts/trigger-replay.ts/regex-safety.ts/condition-evaluator.ts)
+ automation_triggers/automation_trigger_matches şeması+migration.
docs/adr/ADR-0032-tetikleyici-kosul-aksiyon-cekirdegi.md'deki Karar (a)-(n)'yi
uygulayarak test-writer ile başarısız testleri yaz.
```
