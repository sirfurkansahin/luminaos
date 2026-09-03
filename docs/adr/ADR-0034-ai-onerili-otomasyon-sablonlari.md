# ADR-0034: AI Önerili Otomasyon Şablonları

**Durum:** Kabul edildi (Plan Mode oturumunda, bir `Plan` subagent pressure-test'i + İKİ insan-cevaplı `AskUserQuestion` turuyla — RBAC ve analiz-tetikleme kararları üzerine — insan onayı zaten alındı; bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-03
**İlgili görev:** [F2-T17 — AI Önerili Otomasyon Şablonları](../specs/F2-E5/F2-T17-ai-onerili-otomasyon-sablonlari.md)
**İlgili ADR referansları:** [ADR-0032](./ADR-0032-tetikleyici-kosul-aksiyon-cekirdegi.md) (F2-T15, bu görevin onaylanan önerileri dönüştürdüğü `AutomationTriggersService.create`/`createTrigger`'ın kaynağı), [ADR-0033](./ADR-0033-yeniden-kullanilabilir-webhooklar-otomasyon-gecmisi.md) (F2-T16, `CommandsService.listProposals`'ın bu görevin kullanım-deseni girdisinin bir kaynağı olması + RBAC-kararının kaynak-hassasiyetine-göre-değerlendirme emsali — bu ADR onun admin+/admin+ daha muhafazakâr emsalini BİLİNÇLİ olarak reddeder), [ADR-0031](./ADR-0031-toplanti-saklama-tercihi-ve-aksiyon-onerisi.md) (F2-T14, `CommandsService.recordProposal()`'ın genelleştirilmesi + AI-çağrı orkestratörü deseninin ikinci örneği), [ADR-0015](./ADR-0015-konusma-komutlari-ajan-aksiyon-sozlesmesi.md) (F1-T16, öner→onayla temel sözleşmesi + `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` payload sözleşmesi — bu ADR bu sözleşmeyi GENİŞLETMEZ, yalnızca aynı öner→onayla desenini yeni bir domaine uygular).

> Bu ADR, spec'in kendi "⚠️ MİMARİ-KARAR GEREKTİREN GÖREV" işaretinin (a)/(b) fıkralarına karşılık gelir: (a) yeni bir event-sourced varlık (`trigger_template_suggestions`) icat ediliyor — `command_proposals`'ın mimarisini yansıtan ama ona KATILMAYAN, gelecekteki "AI bir config-nesnesi önerir, insan onaylar" görevlerinin üzerine inşa edeceği bir sözleşim; (b) `packages/ai-gateway` üzerinden ÜÇÜNCÜ bir LLM-çağrı orkestratörü ekleniyor — kota/kilit/model-seçimi disiplinine yeni bir `outputType` ekliyor. Aşağıdaki (a)-(h) maddeleri, Plan Mode oturumunda `Plan` subagent'ının pressure-test'iyle ve iki `AskUserQuestion` turuyla netleşen kararların birebir kaydı — ADR-0030/ADR-0032/ADR-0033'ün tek dosyada birden fazla kararı harfle numaralandırma emsali burada da izleniyor.

## Bağlam

Bir `Explore` dispatch'i + `Plan` subagent pressure-test'iyle doğrulanan mevcut durum (ayrıntılar spec'in "Mevcut Durum" bölümünde):

1. `packages/automation/src/trigger.ts`/`trigger-commands.ts`'de hiçbir "draft"/"template"/"suggestion" kavramı yok — `createTrigger(input: {triggerId, workspaceId, name, spec: TriggerSpec}): TriggerEventDraft[]` SAF bir fonksiyon (DB yan etkisi yok, doğrular veya fırlatır). Bu, bir öneri onaylanırken YENİDEN KULLANILACAK tam olarak doğru validasyon noktası.
2. `AutomationTriggersService.create(workspaceId, actor, callerRole, {name, spec})` admin+ RBAC, GERÇEK caller `Actor`'ü kaydeder (`automation-triggers.service.ts:66-92`, doc-comment: "every write still records the real caller Actor"); `.list(workspaceId, callerRole)` member+, tam `Trigger[]` döner.
3. `CommandsService.listProposals` (ADR-0033 §b) member+ RBAC, `CommandProposalSummary`: `{id, workspaceId, command, sourceObjectId, actions, decisions, createdAt, decidedAt}`.
4. **Kritik mimari çatal:** `ProposedAction.type` (`parse-command.ts:28-33`) kapalı bir nesne-mutasyonu aksiyon tipleri kümesi (`createTask`/`generateSubtasks`/`assignPeople`/`createTaskFromMeeting`/`createTaskFromTrigger`) — `executeDecidedAction`'ın (`commands.service.ts:593-636`) exhaustive switch'i her zaman bir Lumina Object üretir/mutasyona uğratır. "Bir tetikleyici şablonu öner" tipi bu değişmezi bozar (bir tetikleyici oluşturmak nesne mutasyonu değildir) — bu yüzden bu görev YENİ, BAĞIMSIZ bir event-sourced varlık gerektiriyor.
5. AI-çağrı deseni (`parse-command.ts`/`extract-meeting-actions.ts`, ikisi de tam okundu): girdi arayüzü `{provider, <görev-özel girdi>, model?, recordUsage}` → zod şeması → saf `render*Prompt` → `complete()` closure → `tryParse*` (JSON.parse→safeParse→sunucu-taraflı fresh id) → orkestratör (bir kez dene, başarısızsa AYNI prompt'la bir kez daha dene, ikinci başarısızlıkta ASLA fırlatmayan bir sentinel döner: `{..., parseError: true, message}`).
6. Kota/kilit disiplini (`ai-usage.service.ts`, `commands.service.ts:229-249`): `withWorkspaceAILock` (Postgres advisory lock, TÜM kritik bölüm boyunca tutulur) → `assertAITokenQuotaNotExceeded` → `assertAICostBudgetNotExceeded` → `selectAIModel({outputType})` → provider çağrısı → `recordAIUsage`. Her iki kota kontrolü de provider çağrısından ÖNCE, tam olarak bir kez çalışır.
7. `selectAIModel({outputType: 'text'|'select'|'qa'|'command'}): string` — yalnızca `'select'` Haiku'ya, geri kalanı Sonnet'e yönlendirir.
8. `apps/server/src/automation/dto/create-trigger.schema.ts`'nin `triggerSpecSchema` (dosya-özel, export edilmemiş) discriminated-union'ı — DTO yalnızca JSON şeklini kontrol eder, iş-kuralı doğrulaması (pozitif-tamsayı `intervalMinutes`, regex güvenliği) `createTrigger`'a bırakılır. Bu şema bu görevde ÜÇÜNCÜ kez yeniden ihtiyaç duyulan discriminated union — dosyadan export edilip yeniden yazılması engellenir.
9. Kod tabanında hiçbir "kullanım deseni analizi"/"öneri motoru"/"şablon" özelliği yok (kapsamlı grep ile doğrulandı) — F2-T17 bunun ilki olacak.

## Karar

### (a) RBAC: `trigger_template_suggestions` member+ okuma, admin+ yazma — `AutomationTriggersService.list`'in emsalini yansıtır, `WebhookSubscriptionsService`'in admin+/admin+ emsalini BİLİNÇLİ reddeder

`TriggerSuggestionsService.list` member+, `.runAnalysis`/`.decide` admin+ gerektirir. Gerekçe: bir önerinin taşıdığı bilgi (aday `name`/`spec`/`rationale`) bilgi-hassasiyeti bakımından GERÇEK bir tetikleyici tanımıyla (`AutomationTriggersService.list`'in zaten member+ okumaya açtığı bilgi) AYNI kategoridedir — dışa-veri-akışının kendisinin bir ipucu olan bir webhook aboneliğinin hedef URL'sinden (ADR-0033 §g'nin admin+/admin+ gerekçesi) NİTELİKSEL olarak farklıdır. Bir öneri henüz gerçek bir tetikleyici bile değildir; onu göstermek bir workspace member'ına "gerçekleşmiş" bir tetikleyiciden daha az bilgi taşımaz, daha fazla değil.

### (b) Analiz tetikleme mekanizması: yalnızca isteğe bağlı (admin `POST .../analyze`), zamanlanmış poller YOK, workspace başına 15 dakikalık cooldown

`runAnalysis(workspaceId, actor, callerRole)` yalnızca bir admin'in doğrudan çağrısıyla çalışır — `TriggerSchedulerService`/`WebhookDeliveryWorker` benzeri bir arka-plan `OnModuleInit`+`setInterval` poller'ı YOK. Yeni `trigger_suggestion_analysis_state` tablosu (`workspaceId` PK + `lastRunAt`) her çağrıda kontrol edilir: `now() - lastRunAt < 15 dakika` ise çağrı `ConflictError`/`429`-benzeri bir hata ile reddedilir, `lastRunAt` GÜNCELLENMEDEN. Gerekçe: bu özelliğin hiçbir doğruluk/güncellik gereksinimi yok (bir öneri bir dakika sonra da üretilse, bir yıl sonra da üretilse fonksiyonel bir fark yaratmaz) — tüm workspace'leri kör bir aralıkla taramak (`TriggerSchedulerService`'in zamanlanmış-tetikleyici modeli) hiçbir kullanıcı bu özelliği hiç kullanmasa bile sürekli AI kota/maliyet harcaması demektir. Cooldown, bir admin'in "Şimdi analiz et" butonuna hızlı art arda basmasının (veya bir script'in) tek bir workspace'in kota/bütçesini gereksiz tüketmesini önler.

### (c) Yeni BAĞIMSIZ event-sourced varlık `trigger_template_suggestions` — `command_proposals`'a KATILMAZ

`ProposedAction.type` KAPALI bir nesne-mutasyonu aksiyon tipleri kümesidir ve `executeDecidedAction`'ın exhaustive switch'i HER zaman bir Lumina Object üretir/mutasyona uğratır (Bağlam madde 4). Bir tetikleyici-şablonu önerisinin "decide" sonucu "`AutomationTriggersService.create`'i çağır" — bir nesne mutasyonu DEĞİL — bu yüzden bu tipi `command_proposals`'a eklemek o switch'in kendi değişmezini bozar. Bunun yerine `trigger_template_suggestions`, `command_proposals`'ın mimarisini yansıtan (kendi stream tipi, `pending → approved|rejected` durum makinesi) ama ona KATILMAYAN, YENİ ve BAĞIMSIZ bir event-sourced varlıktır — `webhook_subscriptions`'ın düz-CRUD şeklinden (ADR-0033 §h) DEĞİL, çünkü bu varlığın GERÇEK bir tüketen durum-makinesi var (`command_proposals`'ınki gibi), bir webhook aboneliğinin "salt config"inin AKSİNE.

### (d) Şema: `TriggerTemplateSuggested`/`TriggerTemplateApproved`/`TriggerTemplateRejected` olayları + `trigger_template_suggestions` okuma-modeli

```ts
// Olaylar (yeni `trigger-template-suggestion` stream tipi)
interface TriggerTemplateSuggested {
  suggestionId: string;
  workspaceId: string;
  name: string;
  kind: 'scheduled' | 'condition';
  spec: TriggerSpec; // @luminaos/automation
  rationale: string;
}

interface TriggerTemplateApproved {
  suggestionId: string;
  createdTriggerId: string;
}

interface TriggerTemplateRejected {
  suggestionId: string;
}
```

```ts
// apps/server/src/db/schema/trigger-template-suggestions.ts
export const triggerTemplateSuggestions = pgTable(
  'trigger_template_suggestions',
  {
    id: varchar('id', { length: 26 }).primaryKey(), // ULID, business identity (= suggestionId)
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: varchar('kind', { length: 20 }).notNull(), // 'scheduled' | 'condition'
    spec: jsonb('spec').notNull(), // candidate TriggerSpec
    rationale: text('rationale').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
    // GERÇEK FK — automation_triggers fiziksel bir tablo (ADR-0033 §h'nin
    // webhook_deliveries.subscriptionId FK gerekçesinin aynısı), bir
    // projeksiyona (objects_view) verilen ADR-0032'nin objectId'sinin
    // BİLİNÇLİ FK'sizliğinin AKSİNE.
    createdTriggerId: varchar('created_trigger_id', { length: 26 }).references(
      () => automationTriggers.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    index('trigger_template_suggestions_workspace_id_status_idx').on(
      table.workspaceId,
      table.status,
    ),
  ],
);

// apps/server/src/db/schema/trigger-suggestion-analysis-state.ts
export const triggerSuggestionAnalysisState = pgTable('trigger_suggestion_analysis_state', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull(),
});
```

### (e) AI-çağrı tasarımı: SINIRLI özet (`summarize-usage-patterns.ts`) + üçüncü orkestratör (`suggest-trigger-templates.ts`) + yeni `outputType`/actor

**`apps/server/src/ai/summarize-usage-patterns.ts`** — saf fonksiyon, ASLA ham geçmiş dökümü göndermez:

```ts
export interface UsagePatternSummaryInput {
  activeTriggers: Trigger[]; // AutomationTriggersService.list() çıktısı
  decidedProposals: CommandProposalSummary[]; // CommandsService.listProposals() çıktısı
}

export interface UsagePatternGroup {
  actionType: string;
  outcome: 'approved' | 'rejected' | 'mixed';
  count: number;
  exampleCommands: string[]; // en fazla 3, her biri kırpılmış
}

export interface UsagePatternSummary {
  activeTriggerSummaries: string[]; // tetikleyici başına tek satır
  groups: UsagePatternGroup[]; // (actionType, outcome) gruplu/tally'li
}

export function summarizeUsagePatterns(input: UsagePatternSummaryInput): UsagePatternSummary;
```

`decidedProposals`'ı `(actionType, outcome)` çiftine göre gruplar, her grup için sayaç tutar, grup başına en fazla 3 temsili KIRPILMIŞ `command` metni örneği tutar, aktif tetikleyicileri tek-satırlık özetlere indirger. Bu, token maliyetini yüzlerce öneri olsa bile SINIRLI tutar — LLM'e giden prompt hiçbir zaman yüzden fazla satır taşımaz.

**`apps/server/src/ai/suggest-trigger-templates.ts`** — `parse-command.ts`'in BİREBİR aynı şekli (retry-once-then-sentinel, asla fırlamaz):

```ts
export interface SuggestTriggerTemplatesInput {
  provider: AIProvider;
  summary: UsagePatternSummary;
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface TriggerTemplateCandidate {
  name: string;
  rationale: string;
  spec: TriggerSpec;
}

export interface SuggestTriggerTemplatesResult {
  suggestions: TriggerTemplateCandidate[];
  parseError: boolean;
  message?: string;
}
```

Yanıt zod şeması, `create-trigger.schema.ts`'ten EXPORT edilen `triggerSpecSchema`'yı ÜÇÜNCÜ kez yeniden ihtiyaç duyulan discriminated union'ı bir daha yazmadan kullanır:

```ts
const candidateSuggestionSchema = z
  .object({ name: z.string().min(1), rationale: z.string().min(1), spec: triggerSpecSchema })
  .strict();

const suggestTriggerTemplatesResponseSchema = z
  .object({ suggestions: z.array(candidateSuggestionSchema).max(5) })
  .strict();
```

`selectAIModel`'in `outputType` union'ına `'triggerSuggestion'` eklenir, `'text'`/`'qa'`/`'command'`'ın AYNI bucket'ına (Sonnet) yönlendirilir — kullanım-deseninden yeni tetikleyici şablonu üretmek açık-uçlu bir muhakeme görevi, kısıtlı-seçim değil.

Yeni sabit aktör `TRIGGER_SUGGESTION_ACTOR = { type: 'agent', id: 'trigger-suggestion-engine' } as const` — `TRIGGER_ENGINE_ACTOR`'dan (zaten onaylanmış tetikleyicileri ATEŞLEYEN) KASITLI olarak ayrı, çünkü bu aktör yeni tetikleyici ÖNERİR, mevcut birini ateşlemez; `TriggerTemplateSuggested` olayında kaydedilir.

### (f) İki-katmanlı savunmacı yeniden-doğrulama — yanıt zod şeması iş-kuralı doğrulamasının YERİNE GEÇMEZ

`triggerSpecSchema` yalnızca JSON şeklini kontrol eder (alan tipleri, discriminant literal) — regex güvenliği, pozitif-tamsayı interval gibi iş kurallarını ASLA doğrulamaz. Bu, bir eksiklik değil, açıkça belgelenen bir tasarım kısıtıdır.

- **Katman 1 (öneri-anı, `runAnalysis` içinde):** her aday için SAF `createTrigger({triggerId: 'dry-run', workspaceId, name, spec})` bir try/catch içinde çağrılır — fırlayan HERHANGİ bir aday sessizce düşürülür (yapılandırılmış `Logger.warn`, HİÇBİR LLM içeriği loglanmaz), ASLA bir öneri olarak persist edilmez.
- **Katman 2 (onay-anı, `decide()`'ın approve dalı):** `automationTriggersService.create(workspaceId, actor, callerRole, {name, spec})` DEĞİŞTİRİLMEDEN çağrılır — mevcut admin+ RBAC'ın ve `createTrigger`'ın TAM validasyonunun %100'ünü yeniden kullanır. Bu bir defense-in-depth katmanı gibi bir şekilde yine başarısız olursa, öneri `'pending'` kalır — ASLA `'approved'` işaretlenmez, ASLA bozuk bir `automation_triggers` satırı yazılmaz.

### (g) Actor provenance kuralı: onaylanan tetikleyicinin actor'ü HER ZAMAN gerçek insan admin, ASLA AI değil

Bir önerinin onayından oluşan `automation_triggers` satırının actor'ü, `decide()`'ı çağıran GERÇEK onaylayan insan admin'dir — `TRIGGER_SUGGESTION_ACTOR` ASLA bu satıra actor olarak yazılmaz. AI-kaynaklı köken (yazarlık + `rationale`) SADECE `TriggerTemplateApproved.createdTriggerId`'nin öneriye geri bağlanmasıyla korunur — tetikleyicinin kendi denetim izi ASLA bir ajanın onu oluşturduğunu söyleyecek şekilde SAHTELENMEZ. Bu, `AutomationTriggersService.create`'in kendi doc-comment değişmezini ("every write still records the real caller Actor") birebir yansıtır.

### (h) Dedup + tavan: çalıştırma başına en fazla 5 öneri; aynı `(kind, spec)`'li bekleyen bir öneri atlanır; reddedilen öneriler KALICI OLARAK bastırılmaz (belgelenen, kabul edilmiş bir v0 sınırlaması)

Yanıt şeması zaten `.max(5)` ile sınırlı (Karar e). `runAnalysis`, persist etmeden ÖNCE her adayın `(kind, spec)`'ini workspace'in MEVCUT `'pending'` önerileriyle karşılaştırır — eşleşen bir aday atlanır (dedup). Daha önce REDDEDİLMİŞ bir öneri KASITLI olarak kalıcı bir "bastırma listesi"nde tutulmaz — aynı `(kind, spec)` gelecekteki bir analizde tekrar önerilebilir. Bu bir TODO değil, açıkça belgelenen, kabul edilmiş bir v0 kapsam sınırlamasıdır (spec'in kendi "Kapsam DIŞI" bölümü).

## Alternatifler ve Reddedilme Gerekçeleri

- **`trigger_template_suggestions`'ı `command_proposals`'a katmak (`ProposedAction.type`'a yeni bir literal eklemek).** Reddedildi (Karar c) — `executeDecidedAction`'ın exhaustive switch'inin kendi değişmezini (her case bir nesne mutasyonu üretir) bozardı; bir tetikleyici-şablonu önerisinin "decide" sonucu bir nesne mutasyonu değil, `AutomationTriggersService.create`'in bir çağrısı.
- **Zamanlanmış bir arka-plan poller'ı (ör. `TriggerSuggestionSchedulerService`, `TriggerSchedulerService`/`WebhookDeliveryWorker` deseni).** Reddedildi (Karar b) — bu özelliğin hiçbir doğruluk/güncellik gereksinimi yok; tüm workspace'leri kör bir aralıkla taramak, hiç kullanılmasa bile sürekli AI kota/maliyet harcaması demek olurdu. On-demand + cooldown yeterli.
- **Webhook aboneliklerinin admin+/admin+ RBAC emsalini (ADR-0033 §g) aynen kopyalamak.** Reddedildi (Karar a) — bir önerinin bilgi-hassasiyeti bir webhook aboneliğinin hedef-URL'sinden (dışa-veri-akışının ipucu) NİTELİKSEL olarak farklı, bir GERÇEK tetikleyici tanımıyla (zaten member+ okumaya açık) AYNI kategoride.
- **Onaylanan tetikleyicinin actor'ünü `TRIGGER_SUGGESTION_ACTOR` (AI) olarak kaydetmek.** Reddedildi (Karar g) — `AutomationTriggersService.create`'in "her yazma gerçek caller Actor'ünü kaydeder" değişmezini ihlal ederdi ve denetim izini sahtelerdi; provenance zaten `createdTriggerId` bağlantısıyla korunuyor.
- **Reddedilen bir öneriyi kalıcı olarak bastırmak (aynı `(kind, spec)`'in bir daha asla önerilmemesi).** Reddedildi (Karar h) — kalıcı bir bastırma-listesi mekanizması gerektirirdi (ne zaman/nasıl temizleneceği belirsiz); v0 gürültüsü olarak kabul edilen, açıkça belgelenmiş bir sınırlama tercih edildi.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** `trigger_template_suggestions` TAMAMEN olay-kaynaklıdır — `TriggerTemplateSuggested`/`TriggerTemplateApproved`/`TriggerTemplateRejected` olayları TEK doğruluk kaynağıdır, `trigger_template_suggestions` okuma-modeli tablosu bunların salt bir projeksiyonudur (`command_proposals`'ın kendi deseninin birebir aynısı). Bu değişmezle tutarlı, yeni bir istisna İCAT EDİLMEZ.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu ADR YENİ bir ajan-aksiyon TİPİ eklemiyor — ADR-0015'in `intent`/`rationale`/`resources`/`rollbackNote` payload şekli `ProposedAction`'a ÖZGÜ, `TriggerTemplateSuggested` bu şekli TAŞIMAZ (kendi `{suggestionId, workspaceId, name, kind, spec, rationale}` şekli var). Bu ADR, ADR-0015'in kurduğu ÖNER→ONAYLA DESENİNİ (davranışsal sözleşme, payload şekli değil) YENİ bir domaine (tetikleyici-şablonu önerileri) genişletiyor — desen aynı, sözleşme genişlemiyor, sadece bir dördüncü/beşinci uygulaması ekleniyor.
- **Hassas veri sınıflarının buluta ham gönderilmemesi.** `suggest-trigger-templates.ts`'nin LLM prompt'u `summarize-usage-patterns.ts`'nin ürettiği AGREGE özet-verisidir (gruplu/tally'li sayılar + en fazla 3 KIRPILMIŞ örnek komut metni + tek-satırlık tetikleyici özetleri) — ASLA ham işlem geçmişi/transkript dökümü DEĞİL. Bu, `summarize-usage-patterns.ts`'nin kendisinin UYMASI GEREKEN bir tasarım kısıtı olarak burada kaydedilir: fonksiyon hiçbir koşulda ham `command`/`params` alanlarının tamamını (yalnızca kırpılmış örnekleri) veya bir tetikleyicinin tam `spec`'ini (yalnızca tek-satırlık özetini) prompt'a sızdırmamalıdır.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR hiçbir export/dışa-aktarma uç noktasına dokunmuyor, bu değişmezle bir ilişkisi yok.

## Şema Taslağı

Bkz. Karar (d).

## PR Bölünmesi

1. **PR1** — `trigger_template_suggestions`/`trigger_suggestion_analysis_state` şeması + migration (down script dahil) + `create-trigger.schema.ts`'ten `triggerSpecSchema`'nın export edilmesi + `summarize-usage-patterns.ts` (saf, tam birim-test edilmiş: gruplama/tally/örnek-sınırı doğruluğu) + `suggest-trigger-templates.ts` (AI orkestratörü, sahte `AIProvider` ile retry/sentinel akışı birim-test edilmiş) + `selectAIModel`'in `'triggerSuggestion'` outputType genişlemesi. Sunucu servis/RBAC bağlama YOK.
2. **PR2** — `TriggerSuggestionsService`/`Controller`/`Projection`: `runAnalysis` (admin+, cooldown, dry-run filtre, dedup+tavan, `TriggerTemplateSuggested` kaydı, `AIUsageService` kota/kilit entegrasyonu), `list` (member+), `decide` (admin+, onayda GERÇEK `AutomationTriggersService.create` çağrısı, redde yalnızca durum güncellemesi) + entegrasyon testleri (RBAC, cross-workspace izolasyon, cooldown, güvensiz-spec'in öneri olarak bile persist edilmediği, onayın gerçek `automation_triggers` satırı + doğru actor ürettiği, reddin `automation_triggers`'a dokunmadığı).
3. **PR3** — Frontend: `TriggerSuggestionsPanel.tsx` (bekleyen önerileri listeler, "Şimdi analiz et" butonu, öneri-başına onay/red) + hook'lar + `App.tsx` bağlama.

## İnsan Onayı (ADR taslağından sonra, implementasyondan önce)

Aşağıdaki iki karar, Plan Mode oturumunda AYRI `AskUserQuestion` turlarında insana AÇIKÇA soruldu ve onaylandı:

- **Karar (a):** `trigger_template_suggestions` member+ okuma, admin+ yazma (`runAnalysis`+`decide`) — `AutomationTriggersService.list`'in emsalini yansıtır; `WebhookSubscriptionsService`'in (F2-T16) admin+/admin+ daha muhafazakâr emsali BİLİNÇLİ olarak reddedildi — insan onayladı.
- **Karar (b):** analiz çalıştırması yalnızca isteğe bağlı (admin "Şimdi analiz et" butonuna basar) + workspace başına 15 dakikalık cooldown; zamanlanmış bir arka-plan işi YOK — insan onayladı.

Diğer kararlar (c-h) Plan Mode oturumunun `Plan` subagent pressure-test'i sırasında netleşti (mevcut kod tabanı emsallerinden — `command_proposals`'ın mimarisi, `parse-command.ts`'in AI-çağrı deseni, `AutomationTriggersService.create`'in actor-kaydı değişmezi — doğrudan türetilebilir nitelikteydi), ayrı bir soru turu gerektirmedi.

## Sonuçlar

- `trigger_template_suggestions`, `command_proposals`'ın yanında YENİ, BAĞIMSIZ bir event-sourced varlık olarak açılır — `ProposedAction.type`'ın kapalı nesne-mutasyonu kümesi DEĞİŞMEZ, bu görevden ETKİLENMEZ.
- `apps/server/src/ai/`'de üçüncü bir orkestratör (`suggest-trigger-templates.ts`) açılır; `selectAIModel`'in `outputType` union'ı beşinci bir literal kazanır (`'triggerSuggestion'`), hepsi aynı Sonnet bucket'ına yönlendirilir.
- `create-trigger.schema.ts`'nin `triggerSpecSchema`'sı export edilerek İKİNCİ bir tüketicisi (`suggest-trigger-templates.ts`'nin yanıt şeması) kazanır — discriminated union üçüncü kez yeniden yazılmaz.
- Webhook abonelikleri (ADR-0033 §g) ile bu görevin RBAC'ı ARASINDAKİ fark, ADR-0032/ADR-0033'ün zaten gösterdiği "her hassas-config kaynağı kendi hassasiyet profiline göre değerlendirilmeli" ilkesinin ÜÇÜNCÜ örneğidir.
- Reddedilen-önerilerin kalıcı bastırılmaması gelecekte ayrı bir görev/karar olarak ele alınabilir; bu ADR o kapıyı kapatmaz.

---

**Sıradaki adım:** Bu ADR insan onayına sunulur. Onaylanırsa PR1'den başlayarak her PR için ayrı `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir:

```
Şu an F2-T17 PR1'e başlıyoruz: trigger_template_suggestions/trigger_suggestion_analysis_state
şeması+migration + create-trigger.schema.ts'ten triggerSpecSchema export'u +
summarize-usage-patterns.ts (saf, tam birim-test edilmiş) + suggest-trigger-templates.ts
(AI orkestratörü, retry/sentinel akışı birim-test edilmiş) + selectAIModel'in
'triggerSuggestion' outputType genişlemesi. docs/adr/ADR-0034-ai-onerili-otomasyon-sablonlari.md'deki
Karar (a)-(h)'yi uygulayarak test-writer ile başarısız testleri yaz.
```
