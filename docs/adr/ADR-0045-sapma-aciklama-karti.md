# ADR-0045: Sapma Açıklama Kartı — Reaktif, Agregat-Yalnızca-Girdili, Kalıcı AI Açıklaması (Epik F3-E4'ün SON Görevi)

**Durum:** Kabul edildi — bu görevin PLAN.md çıpası (`docs/PLAN.md:294`) tek bir madde cümlesinden ibaret ("F3-T11: Sapma anında ajan destekli kök neden analizi kartı"), ADR-0044'ten (F3-T10) bile daha zayıf. Bu boşluk nedeniyle üç en-yük-taşıyan, PLAN.md'den doğrulanamayan ürün kararı (tetikleme modeli, veri hassasiyeti, kalıcılık) Plan Mode oturumunda bir `AskUserQuestion` turuyla insana soruldu ve İNSAN TARAFINDAN karara bağlandı — aşağıda **İnsan kararları** bölümünde AYNEN kayıtlıdır, mimarın çıkarımı DEĞİLDİR. Geri kalan tüm kararlar ((a)-(i)) mimarın kendi çıkarımı, F3-T7→T10 zincirinin emsal deseninden ve gerçek koddan doğrulanmıştır.
**Tarih:** 2026-09-12
**İlgili görev:** [F3-T11 — Sapma anında ajan destekli kök neden analizi kartı](../specs/F3-E4/F3-T11-sapma-aciklama-karti.md). `docs/PLAN.md` satır 294. Epik F3-E4'ün (Plan-Gerçek Motoru, Kapsam N) İKİNCİ ve SON görevi — F3-T10 (ADR-0044, `main`'e merge edildi) sonrası.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin HER İKİ fıkrasını da tetikliyor: (1) bu karar `docs/adr/ADR-0029-hibrit-ai-veri-siniflandirmasi.md`'nin dört-kademeli sınıflandırmasıyla doğrudan gerilim yaratıyor — ADR-0029 "ham sayısal iş değerleri"ni AÇIKÇA sınıflandırmıyor, bu ADR o boşluğu somut bir bağlamda kapatıyor (bkz. Karar i); (2) `packages/artifacts`/`apps/server/src/artifacts`/`apps/server/src/ai`'a YENİ bir AI-çıktı kontratı (`DeviationExplanationContent` şeması) ve `artifact` nesne modeline YENİ kalıcı alanlar dayatıyor.

> Bu ADR, ADR-0044'ün kendi "Mimari Değişmezlerle İlişki" bölümünün AÇIKÇA öngördüğü noktayı kapatıyor: _"F3-T11 (AI-destekli kök-neden analiz kartı, AYRI gelecekteki görev) bu sözleşmeye [ADR-0029'un dört-kademeli hassas-veri sınıflandırması] TABİ olacak İLK Plan-Gerçek bileşeni olabilir."_ F3-T7→F3-T10 zincirinin SIFIR-AI'a doğru azalan bağımlılık eğilimi (ADR-0044 Bağlam #9) burada TERSİNE döner — bu, o zincirin AI-gateway'i YENİDEN getiren İLK görevidir, ama İnsan kararı 2'nin agregat-yalnızca kısıtı sayesinde ADR-0029'un Kademe 1/2'sinin GEREKTİRDİĞİ hiçbir ek-onay-yüzeyini TETİKLEMEZ.

## Bağlam

**F3-T10'un baseline/sapma altyapısı (bu görevin tepki vereceği sinyal, doğrudan koddan doğrulandı):**

1. `packages/artifacts/src/compute-query-aggregate.ts:16-36`(reprise, ADR-0044 Karar e) — `computeQueryAggregate(rows, aggregateFn, targetFieldKey?): number | null`, SAF, sıfır I/O. `packages/artifacts/src/compute-deviation.ts:15-25` (ADR-0044 Karar f) — `computeDeviation({capturedValue, currentValue}): {delta, percentChange, direction}`, `capturedValue===0` ise `percentChange: null`.
2. `apps/server/src/artifacts/baselines.service.ts:38-96` — `BaselinesService.capture()`, **SIFIR AI-gateway bağımlılığı** (`ObjectsService`'in yalnızca `'query'|'create'|'setFieldValues'` dar-Pick'i). `apps/server/src/artifacts/baselines.controller.ts:36-89` — `POST /workspaces/:workspaceId/artifacts/baselines` TEK HTTP yüzeyi; `requireActor`/`requireRole` private-helper deseni, `SessionAuthGuard`+`WorkspaceMembershipGuard` (member+) DIŞINDA ek gate YOK.
3. `apps/server/src/objects/objects.service.ts:413-434` — `ObjectsService.get(workspaceId, objectId, callerRole): Promise<ObjectWithFieldValues>`, `objects_view`'dan TEK satır okuyup RBAC-filtrelenmiş `fieldValues` döner, bulunamazsa/görünmezse `NotFoundError` (fail-closed) — bu görevin, bir baseline `artifact` nesnesinin KENDİ saklı `capturedValue`/`aggregateFn`/`targetFieldKey`/`querySpec`'ini okumak için ihtiyaç duyduğu TEK yeni okuma yolu, YENİ bir metot GEREKMİYOR.
4. `apps/web/src/views/shared/BaselineViewer.tsx:1-111` — `useObjectQuery`+`parseQuerySpec`+istemci-taraflı `postObjectsQuery` çağrısıyla yakalanan/güncel/fark değerlerini React ile DOĞRUDAN render eder (`ArtifactViewer`/iframe KULLANMAZ), poll YOK (mount'ta bir kez + elle "Yenile"). `nextCursor !== undefined` ise `data-testid="baseline-more-rows-warning"` banner'ı gösterir.
5. **Sunucu-tarafı HİÇBİR yeniden-kontrol/tespit mekanizması YOK** (ADR-0044 Bağlam #11, aynen geçerli) — 13 cron/scheduler dosyasının HİÇBİRİ "baseline" referans vermiyor, hiçbir `DeviationDetected`-benzeri event/webhook/bildirim yok. Bir sapma bugün YALNIZCA tarayıcının kendi render edilmiş `computeDeviation()` çıktısında EPHEMERAL olarak var.

**Mevcut AI-orkestrasyon desenleri (3 kategori, doğrudan koddan doğrulandı):**

6. **Yapılandırılmış-aksiyon çıkarımı** (JSON+zod+1-retry+allowlist): `compileWidgetQuery` (`apps/server/src/artifacts/compile-widget-query.ts:143-177`) — `renderCompileWidgetQueryPrompt`+`tryCompileQuerySpec`(JSON.parse→`querySpecSchema.safeParse`→`validateCompiledQuerySpec` allowlist)+`complete()` yardımcı fonksiyonu ile 1-retry, `WidgetsService.generate()` (`widgets.service.ts:81-160`) içinde `AIUsageService.withWorkspaceAILock` ile sarmalanmış. `generateArtifact` (`apps/server/src/artifacts/generate-artifact.ts:76-106`) — AYNI JSON+zod(`artifactContentSchema`)+1-retry deseni, ama allowlist YOK (serbest içerik, yalnızca şema-doğrulama).
7. **"AI gösterilen veriyi açıklıyor/muhakeme ediyor"** — `answerQuestion` (`apps/server/src/ai/answer-question.ts:45-60`), `apps/server/src/qa/qa.service.ts:48-64` (`QAService.answer`): girdi `passages: {objectId,title,snippet}[]` (RBAC-filtrelenmiş, `TOP_K=5`), çıktı `{answer:string, sources}` — SERBEST-BİÇİM DÜZYAZI, HİÇBİR çıktı-şeması/zod-doğrulaması/retry-döngüsü YOK. `passages.length===0` ise sağlayıcıyı HİÇ ÇAĞIRMADAN sabit bir string'e kısa-devre yapıyor (`EMPTY_PASSAGES_ANSWER`, satır 42-48) — "boştan hallüsinasyon üretme" maliyet-koruması, bu ADR'nin Karar (h)'sinin doğrudan emsali.
8. `apps/server/src/ai/select-ai-model.ts:41-48` — `selectAIModel({outputType}): string`, kapalı bir string-union (`'text'|'select'|'qa'|'command'|'triggerSuggestion'|'artifact'|'widgetQuery'`), her yeni AI-üretim görevi bu union'a KENDİ değerini EKLEYEREK genişletmiş (F1-T14→F3-T8 arası 6 örnek) — `'select'` DIŞINDA her `outputType` `CLAUDE_SONNET_5`'e yönlendiriliyor (satır 47).
9. `apps/server/src/artifacts/artifacts.module.ts:56-77` — `ArtifactsController`+`WidgetsController`+`BaselinesController` AYNI modülde, `BaselinesService` `useFactory`+`inject:[ObjectsService]` ile kablolanmış (satır 72-77), `WidgetsService` AYNI desenle ama 4 collaborator'la (`AIUsageService`,`ObjectsService`,`FieldDefinitionsService`,`AI_PROVIDER`) kablolanmış (satır 61-71).

**ADR-0029'un dört-kademeli hassas-veri sınıflandırması** (`docs/adr/ADR-0029-hibrit-ai-veri-siniflandirmasi.md`, tam okundu):

10. **Kademe 0** — ham biyometrik ses/görüntü. **Kademe 1** — ham kişisel-tanımlayıcı metin (görev başlığı/açıklaması, doküman gövdesi, mesajlar — belirli bir kişinin DOĞRUDAN, dönüştürülmemiş yazdığı/söylediği şey), ek onay ekranı GEREKMEZ (zaten entegre sağlayıcıya). **Kademe 2** — türetilmiş/özetlenmiş metin. **Kademe 3** — metadata (`objectId`, zaman damgaları, ENUM'lar, alan ANAHTARLARI — değerleri değil, olay TİPİ adları); kural: "veri yapının/varlığın kendisini tanımlar, İÇERİĞİNİ değil."
11. **Kritik boşluk:** ADR-0029'un Kademe 3 örnekleri arasında SAYISAL İŞ DEĞERLERİ (bir baseline'ın `capturedValue`/`currentValue`'su gibi — bir işin agregat sonucu, bir kişinin doğrudan yazdığı metin DEĞİL) AÇIKÇA yer almıyor. Bu ADR'nin Karar (i)'si bu boşluğu, ADR-0029'un KENDİSİNİ değiştirmeden, somut bir bağlamda YORUMLAYARAK kapatıyor.

## Karar

### (a) Yerleşim — `apps/server/src/artifacts/` (`apps/server/src/ai/` DEĞİL)

Yeni AI-orkestrasyon kodu `apps/server/src/artifacts/explain-deviation.ts` (saf, DB'siz orkestratör — `compileWidgetQuery.ts`/`generate-artifact.ts` ile BİREBİR aynı katman) + `apps/server/src/artifacts/baseline-explanation.service.ts` (`BaselineExplanationService`, dar-Pick+`useFactory` deseni) olarak eklenir.

**Neden `apps/server/src/ai/`'ın (`answerQuestion`'ın kendi yerleşimi) DEĞİL:** `answerQuestion` bilinçli olarak jenerik/özellik-agnostiktir — herhangi bir workspace içeriğine karşı arama-tabanlı bir RAG akışıdır, hiçbir tek özelliğe (widget/artifact/baseline) ait DEĞİLDİR, bu yüzden `apps/server/src/ai/`'da (özellik-nötr AI-altyapı klasörü) yaşar. Bu görevin AI akışı ise TAM TERSİNE, YALNIZCA bir `artifact`(`artifactType==='baseline'`) nesnesinin KENDİ saklı alanlarına (`capturedValue`/`aggregateFn`/`querySpec`) karşı çalışan, o nesne tipine SIKI SIKIYA bağlı bir orkestratördür — `compileWidgetQuery`'nin (widget `artifact`'larına özel) ve `generateArtifact`'ın (genel `artifact`'lara özel) izlediği TAM AYNI "özelliğe-özel AI orkestratörü, o özelliğin SAHİBİ olan klasörde yaşar" ilkesi burada da geçerli. `BaselinesService`'in KENDİSİ `apps/server/src/artifacts/`'ta yaşadığından, onun AI-destekli kardeşinin de AYNI klasörde yaşaması tutarlılığı korur.

### (b) AI çağrısının şekli — hafif yapılandırılmış JSON + zod + 1-retry, `{summary, possibleCauses}` — ne `answerQuestion`'ın serbest-metni, ne `generateArtifact`'ın tam `ArtifactContent`'i

```ts
// packages/artifacts/src/deviation-explanation.ts (YENİ, saf tip+şema)
import { z } from 'zod';

export const deviationExplanationSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    possibleCauses: z.array(z.string().min(1).max(500)).min(1).max(5),
  })
  .strict();

export type DeviationExplanationContent = z.infer<typeof deviationExplanationSchema>;
```

**Neden `answerQuestion`'ın "şema/retry YOK, serbest düzyazı" deseni DEĞİL:** Bir "kart" (spec'in kendi kelimesi, PLAN.md satır 294) frontend'de İKİ görsel açıdan ayrı bölge ister — kısa bir açıklama paragrafı + taranabilir bir "olası nedenler" listesi (bkz. Karar g). Serbest bir string'den bu iki bölgeyi GÜVENİLİR biçimde ayrıştırmak (ör. bir regex/heuristik ile "ilk cümle özet, geri kalanı madde listesi" varsaymak) kırılgan bir UI-katmanı sorunu yaratırdı — TAM OLARAK `compileWidgetQuery`/`generateArtifact`'ın YAPI dayatarak çözdüğü sınıf bir problem.

**Neden `generateArtifact`'ın tam `ArtifactContent`'i (title+keyfi `sections[]`) DEĞİL:** Bir sapma açıklaması yapısal olarak SABİT iki alanlıdır (bir özet + bir neden listesi) — `ArtifactContent`'in `heading`/`paragraph`/`list`/`table`/`imagePlaceholder` gibi 5 keyfi section-türünü desteklemesi burada aşırı-mühendislik olurdu, `renderArtifactHtml`'in HİÇBİR zaman çağrılmayacağı bir bağlamda (Karar g, kart React ile DOĞRUDAN render edilir, `ArtifactViewer`/iframe YOK — `BaselineViewer`'ın KENDİSİ zaten bu deseni izliyor).

**Model yönlendirmesi:** `select-ai-model.ts`'in `SelectAIModelInput.outputType` union'ına YENİ bir değer eklenir: `'deviationExplanation'`, `'select'` DIŞINDAKİ her outputType ile AYNI şekilde `CLAUDE_SONNET_5`'e yönlendirilir — bir sapmanın olası nedenlerini agregat sayılardan çıkarsamak `'select'`in kapalı-seçim niteliğinde DEĞİL, `'qa'`/`'command'` gibi açık-uçlu muhakeme. Bu, `AIUsageService`'in KENDİ metot imzalarına HİÇBİR dokunuş GEREKTİRMEZ (Kapsam Dışı'nın son maddesiyle tutarlı) — yalnızca `select-ai-model.ts`'in kapalı union'ına, her önceki AI-üretim görevinin (F1-T14→F3-T8, 6 örnek) yaptığı GİBİ, katkısal bir değer eklenir.

**Retry:** `compileWidgetQuery`/`generateArtifact`'ın AYNI "ilk yanıt başarısızsa TAM OLARAK 1 kez daha dene, ikisi de başarısızsa `parseError:true` dön" deseni — üçüncü bir deneme YOK.

### (c) Girdi promptunun tam şekli — YALNIZCA agregat + sorgu metadata'sı, HİÇBİR ham satır/nesne verisi

```ts
// apps/server/src/artifacts/explain-deviation.ts
export interface ExplainDeviationInput {
  provider: AIProvider;
  objectType: ObjectType;
  aggregateFn: AggregateFn;
  targetFieldKey?: string;
  capturedValue: number;
  currentValue: number;
  deviation: DeviationResult; // { delta, percentChange, direction } -- @luminaos/artifacts
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

function renderExplainDeviationPrompt(
  input: Omit<ExplainDeviationInput, 'provider' | 'model' | 'recordUsage'>,
): string {
  const metricLabel =
    input.targetFieldKey !== undefined
      ? `${input.aggregateFn} of field "${input.targetFieldKey}"`
      : `${input.aggregateFn} (row count)`;
  const percentText =
    input.deviation.percentChange !== null
      ? `${input.deviation.percentChange.toFixed(1)}%`
      : 'not computable (baseline value was zero)';

  return [
    'A tracked metric baseline has deviated from its originally captured value.',
    'You are given ONLY the aggregate numeric summary below -- you have NO access to',
    'individual records, so do NOT invent specific examples, names, or row-level details.',
    'Explain, in plain language, what this change likely means and list 1-5 plausible causes.',
    'Respond with ONLY a JSON object (no surrounding text, no markdown fences) with exactly',
    'these fields:',
    '- summary: a short (1-3 sentence) plain-language explanation of the change',
    '- possibleCauses: an array of 1-5 short strings, each a plausible cause',
    '',
    `Object type: ${input.objectType}`,
    `Metric: ${metricLabel}`,
    `Captured (baseline) value: ${input.capturedValue}`,
    `Current value: ${input.currentValue}`,
    `Change: ${input.deviation.delta} (${percentText}), direction: ${input.deviation.direction}`,
  ].join('\n');
}
```

Bu, İnsan kararı 2'nin sınırladığı VERİ ZARFININ birebir kod karşılığıdır: `objectType`(metadata), `aggregateFn`(kapalı 7-değerli enum), `targetFieldKey`(alan ANAHTARI — değeri DEĞİL), `capturedValue`/`currentValue`/`delta`/`percentChange`/`direction`(sayısal agregat sonuçlar) — hiçbir nesne başlığı, açıklaması, veya `fieldValues` içeriği İÇERİLMEZ. **Alan ETİKETİ (`FieldDefinition.label`) BİLEREK dahil edilmiyor** (brief'in önerdiği "alan anahtarı/etiketi" ikilisinden yalnızca ANAHTAR seçildi) — bir üçüncü collaborator (`FieldDefinitionsService`) eklemenin getirisi (biraz daha okunaklı bir prompt, "estimatedDuration" yerine "Tahmini Süre") maliyetine (yeni bağımlılık, yeni hata yüzeyi: alan silinmiş/yeniden adlandırılmışsa lookup başarısız olabilir) değmiyor — `compileWidgetQuery`'nin KENDİSİ de ETİKETSİZ, ham `field.key`'leri AI'ya BAŞARIYLA gönderen kanıtlanmış bir emsal (madde 6). Bu, mimarın brief'in önerisinden BİLİNÇLİ bir sapmasıdır.

### (d) `artifact` nesne modeli genişlemesi — İKİ yeni alan (üçüncüsü zaman damgası), migration YOK

```ts
// apps/server/src/workspaces/workspaces.service.ts (diff, seedArtifactFields'a EKLENİR)

await this.defineSeedField(
  workspaceId,
  {
    key: 'explanationSummary',
    label: 'Explanation Summary',
    fieldType: 'longText',
    config: {},
    permissions: SEEDED_FIELD_PERMISSIONS,
  },
  ARTIFACT_OBJECT_TYPE,
);

// possibleCauses: string[] -- 14 FieldType'ın hiçbirinde "keyfi string dizisi"
// yok (multiSelect KAPALI bir seçenek kümesi varsayar, AI-üretimi serbest
// stringler için uygun DEĞİL) -- querySpec'in AYNI longText-JSON-stringify
// deseni (ADR-0042 Karar b) tekrar kullanılır.
await this.defineSeedField(
  workspaceId,
  {
    key: 'explanationCauses',
    label: 'Explanation Possible Causes',
    fieldType: 'longText',
    config: {},
    permissions: SEEDED_FIELD_PERMISSIONS,
  },
  ARTIFACT_OBJECT_TYPE,
);

await this.defineSeedField(
  workspaceId,
  {
    key: 'explanationGeneratedAt',
    label: 'Explanation Generated At',
    fieldType: 'datetime',
    config: {},
    permissions: SEEDED_FIELD_PERMISSIONS,
  },
  ARTIFACT_OBJECT_TYPE,
);
```

`explanationGeneratedAt` frontend'in "açıklama VAR mı" kontrolünü de sağlar (`explanationSummary !== undefined` ile eşdeğer ama bir zaman damgası ayrıca "ne zaman üretildi" bilgisini kullanıcıya gösterir — sapma o zamandan beri daha da değişmiş olabilir, kullanıcının bunu bilmesi gerekir). `artifactType`'a YENİ bir seçenek EKLENMİYOR (Karar b'nin `'baseline'`'ı ZATEN yeterli — bu üç alan `artifactType==='baseline'` için, `querySpec`'in tersi yönde, İSTEĞE BAĞLI ek bir alt-durumu temsil ediyor: "açıklaması istenmiş bir baseline" vs "henüz açıklaması istenmemiş bir baseline", ikisi de AYNI `artifactType`). Migration YOK — ADR-0041/0042/0044 Karar (b)'nin BİREBİR aynı gerekçesi (`field_values`/`objects_view` şeması hiçbir DDL değişikliği gerektirmez).

### (e) HTTP yüzeyi — YENİ `POST .../baselines/:id/explain`, `BaselinesController`'ın İKİNCİ rotası (yeni bir controller sınıfı DEĞİL)

```ts
// apps/server/src/artifacts/baselines.controller.ts (diff -- ikinci constructor param + ikinci rota)
@Controller('workspaces/:workspaceId/artifacts/baselines')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class BaselinesController {
  constructor(
    private readonly baselinesService: BaselinesService,
    private readonly baselineExplanationService: BaselineExplanationService, // YENİ
  ) {}

  @Post()
  async capture(...) { /* değişmedi */ }

  @Post(':id/explain')
  @HttpCode(HttpStatus.OK)
  async explain(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);
    const object = await this.baselineExplanationService.explain(workspaceId, actor, callerRole, id);
    return { object };
  }
}
```

**Neden `BaselinesController`'a İKİNCİ bir rota eklendi, YENİ bir controller sınıfı DEĞİL:** `ArtifactsController`/`WidgetsController`/`BaselinesController` ayrımı SERVİS-KATMANI ayrımını (farklı girdi/çıktı şekli, ADR-0044 Karar a) yansıtıyordu — burada HTTP-KAYNAĞI (`.../artifacts/baselines/:id`) AYNI, yalnızca İKİNCİ bir EYLEM (`/explain`) o kaynağa uygulanıyor; bu REST açısından "aynı kaynağa ikinci bir alt-eylem" deseni, ayrı bir controller sınıfı GEREKTİRMEZ. `BaselinesService`'in KENDİSİ (ADR-0044 Karar c'nin "SIFIR AI bağımlılığı" yatırımı) DEĞİŞTİRİLMİYOR — yeni AI-bağımlılığı TAMAMEN `BaselineExplanationService` adlı YENİ, AYRI bir sınıfa izole ediliyor (aşağıda), controller yalnızca İKİ bağımsız servisi enjekte eden ince bir HTTP kabuğu olarak kalıyor. **Request body YOK** — `id` URL parametresi + saklı `querySpec`/`aggregateFn`/`capturedValue`/`targetFieldKey` (Karar c'nin girdisi) TAMAMEN bu id'den okunuyor, hiçbir yeni DTO/zod şeması GEREKMİYOR.

```ts
// apps/server/src/artifacts/baseline-explanation.service.ts
export type BaselineExplanationObjectsService = Pick<
  ObjectsService,
  'get' | 'query' | 'setFieldValues'
>;
export type BaselineExplanationAIUsageService = WidgetAIUsageService; // AYNI dar-Pick tipi, yeniden kullanılır

export class BaselineExplanationService {
  constructor(
    private readonly aiUsageService: BaselineExplanationAIUsageService,
    private readonly objectsService: BaselineExplanationObjectsService,
    private readonly provider: AIProvider,
  ) {}

  async explain(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    baselineObjectId: string,
  ): Promise<ObjectWithFieldValues> {
    const baseline = await this.objectsService.get(workspaceId, baselineObjectId, callerRole);

    if (baseline.fieldValues.artifactType !== 'baseline') {
      throw new ValidationError('Object is not a baseline artifact.');
    }

    const querySpec = parseStoredQuerySpec(baseline.fieldValues.querySpec); // JSON.parse + querySpecSchema.safeParse
    if (querySpec === undefined) {
      throw new ValidationError('Stored querySpec could not be parsed.');
    }

    const queryResult = await this.objectsService.query(workspaceId, callerRole, querySpec);
    if (!('objects' in queryResult)) {
      throw new ValidationError('Unexpected grouped query result for a baseline (unsupported).');
    }

    const aggregateFn = baseline.fieldValues.aggregateFn as AggregateFn;
    const targetFieldKey =
      typeof baseline.fieldValues.targetFieldKey === 'string'
        ? baseline.fieldValues.targetFieldKey
        : undefined;
    const capturedValue = baseline.fieldValues.capturedValue as number;
    const currentValue = computeQueryAggregate(queryResult.objects, aggregateFn, targetFieldKey);

    // Karar (h): hesaplanamaz bir güncel değerle AI'ı ASLA ÇAĞIRMA.
    if (currentValue === null) {
      throw new ValidationError('Current aggregate value could not be computed for this baseline.');
    }

    const deviation = computeDeviation({ capturedValue, currentValue });

    const lockResult = await this.aiUsageService.withWorkspaceAILock(workspaceId, async () => {
      await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
      await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

      const model = selectAIModel({ outputType: 'deviationExplanation' });

      return explainDeviation({
        provider: this.provider,
        objectType: querySpec.objectType,
        aggregateFn,
        targetFieldKey,
        capturedValue,
        currentValue,
        deviation,
        model,
        recordUsage: (usage) =>
          this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
      });
    });

    const { content, parseError, message } = lockResult as ExplainDeviationResult;
    if (parseError || content === undefined) {
      throw new ValidationError(message ?? 'Deviation explanation generation failed.');
    }

    // 'owner'-bypass -- BaselinesService/WidgetsService'in AYNI deseni.
    return this.objectsService.setFieldValues(workspaceId, baseline.id, actor, 'owner', [
      { fieldKey: 'explanationSummary', value: content.summary },
      { fieldKey: 'explanationCauses', value: JSON.stringify(content.possibleCauses) },
      { fieldKey: 'explanationGeneratedAt', value: new Date().toISOString() },
    ]);
  }
}
```

RBAC: `BaselinesController`'ın MEVCUT `SessionAuthGuard`+`WorkspaceMembershipGuard` gate'i (member+) her iki rotaya da uygulanıyor — daha katı bir taban İCAT EDİLMİYOR (brief'in madde 5'inin "aksi bir gerekçe yoksa" koşulu karşılanıyor: gerekçe YOK, ADR-0041/0042/0044'ün AYNI tabanı korunuyor).

### (f) "Yeniden oluştur" davranışı — AYNI uç-noktaya tekrar POST, ÜZERİNE YAZMA, geçmiş YOK

`explain()`'in KENDİSİ idempotent-DEĞİL bir "yeniden çalıştır" eylemidir — `explanationSummary`/`explanationCauses`/`explanationGeneratedAt` her çağrıda `setFieldValues` ile ÜZERİNE YAZILIR (v0: tek-slot, versiyon geçmişi YOK — İnsan kararı 3'ün "yalnızca kullanıcı açıkça yeniden oluştur derse yeniden üretilir" ifadesinin en basit somutlaşması). Frontend AYNI mutasyonu (`useExplainDeviationMutation`) hem ilk-üretim hem yeniden-üretim için kullanır — buton etiketi `explanationSummary`'nin VAR/YOK olmasına göre "Açıklama iste" / "Yeniden oluştur" arasında değişir (Karar g). Her çağrı `AIUsageService`'in kota/bütçesini GERÇEKTEN TÜKETİR (İnsan kararı 3'ün maliyet-güvencesinin doğrudan sonucu: yalnızca GERÇEK talepte tüketilir, hiçbir arka-plan/otomatik yeniden-üretim YOK).

### (g) Frontend — `BaselineViewer`'a "Açıklama iste"/"Yeniden oluştur" butonu + kart render'ı

```tsx
// apps/web/src/views/shared/BaselineViewer.tsx (diff)
const explainMutation = useExplainDeviationMutation(workspaceId, artifactObjectId);
const explanationSummary =
  typeof object.fieldValues.explanationSummary === 'string'
    ? object.fieldValues.explanationSummary
    : undefined;
const explanationCauses = parseExplanationCauses(object.fieldValues.explanationCauses); // JSON.parse + z.array(z.string()).safeParse, LiveWidgetViewer/parseQuerySpec'in AYNI "bozuksa sessizce undefined dön" deseni

// ... mevcut capturedValue/currentValue/delta/percentChange render'ının ALTINA:
<Button
  data-testid="baseline-explain-button"
  disabled={explainMutation.isPending}
  onClick={() => explainMutation.mutate()}
>
  {explanationSummary !== undefined ? 'Yeniden oluştur' : 'Açıklama iste'}
</Button>;
{
  explainMutation.isPending ? <div data-testid="baseline-explain-loading">Açıklanıyor…</div> : null;
}
{
  explainMutation.isError ? (
    <EmptyState
      data-testid="baseline-explain-error"
      title="Açıklama üretilemedi"
      description="Kısa bir süre sonra tekrar deneyin."
    />
  ) : null;
}
{
  explanationSummary !== undefined ? (
    <div data-testid="baseline-explanation-card">
      <p data-testid="baseline-explanation-summary">{explanationSummary}</p>
      <ul>
        {(explanationCauses ?? []).map((cause, i) => (
          <li key={i} data-testid="baseline-explanation-cause">
            {cause}
          </li>
        ))}
      </ul>
    </div>
  ) : null;
}
```

`useExplainDeviationMutation`/`apiClient.explainDeviation` (`POST .../baselines/:id/explain`, body YOK) `useCaptureBaselineMutation`/`WidgetGenerationForm`'un AYNI mutation+pending+error UI deseni (Karar e'nin gerekçesi, brief madde 7). Mutasyon başarılı olduğunda `useObjectQuery`'nin kendi cache'i `queryClient.invalidateQueries` ile geçersiz kılınır (`ArtifactGenerationForm`'un AYNI "mutasyon sonrası ilgili GET'i geçersiz kıl" deseni) — böylece `explanationSummary` mevcut `object` render'ına YENİDEN-FETCH ile yansır, ayrı bir state yönetimi İCAT EDİLMEZ.

### (h) Fail-closed maliyet-koruması — hesaplanamaz bir güncel değerle AI ASLA çağrılmaz

`currentValue === null` (ör. `targetFieldKey` artık geçerli bir alan değil, ya da `min`/`max` sıfır satırlık bir sonuca uygulanmış) durumunda `BaselineExplanationService.explain()` `AIUsageService.withWorkspaceAILock`'a GİRMEDEN, sağlayıcıyı HİÇ ÇAĞIRMADAN `ValidationError` fırlatır — `answerQuestion`'ın `passages.length===0` kısayolunun (madde 7) AYNI "boştan/anlamsız girdiden hallüsinasyon üretme, üstelik BUNUN İÇİN kota harcama" disiplini.

### (i) ADR-0029'a resmi ek/açıklama — ham sayısal agregat değerler + sorgu alan anahtarları, Kademe 3'e (metadata) EN YAKIN sınıflandırılır

**Bu ADR, ADR-0029'un KENDİSİNİ değiştirmez** — ADR-0029'un dört kademesi, dört kuralı (Karar a/b), ve mevcut `ai-gateway` pratiğiyle uzlaşması (Karar c) AYNEN yürürlükte kalır. Bu ADR yalnızca, ADR-0029'un Kademe 3 tanımının ("veri yapının/varlığın kendisini tanımlar, İÇERİĞİNİ değil") somut örnek listesinde AÇIKÇA yer ALMAYAN bir veri türüne — bir işin HESAPLANMIŞ SAYISAL SONUCU (ör. bir baseline'ın `capturedValue`/`currentValue`'su, bir sorgunun agregat çıktısı) — bu görevin somut bağlamında bir YORUM getirir:

> **Ham sayısal iş-agregat değerleri (bir `QuerySpec` sonucunun `sum`/`avg`/`count`/`min`/`max` gibi bir indirgemesi) + o sorgunun ALAN ANAHTARLARI/etiketleri, Kademe 3'ün (metadata) ruhuna Kademe 1/2'den daha yakın sınıflandırılır — bu ADR'nin AI'ya gönderdiği veri Kademe 3'ün ÜZERİNE ÇIKMAZ.**

**Gerekçe:** ADR-0029'un Kademe 1/2 ayrımı "bu içerik belirli bir kişinin doğrudan yazdığı/söylediği bir METNİ mi taşıyor" sorusuna dayanır (madde 10) — bir SAYI, tanım gereği hiçbir anlatı/kimlik-taşıyan içerik TAŞIMAZ (`42` sayısının kendisi hiçbir "kim ne dedi" bilgisi içermez, `computeAggregate`'in kendisi zaten `values: unknown[]`'ı TEK bir sayıya İNDİRGEYEREK olası her türlü kimlik-taşıyan ayrıntıyı kaybeder — bu İNDİRGEME, ADR-0029 Kademe 2'nin "dönüştürme fonksiyonunun sonucu" tanımına da yakındır, ama Kademe 2 hâlâ METİN varsayar, bir SAYI değil). Alan ANAHTARLARI (`targetFieldKey`) zaten ADR-0029'un Kademe 3 tanımının kendi, birebir örneği ("alan ANAHTARLARI, değerleri değil"). Bu nedenle: **agregat SAYI + alan ANAHTARI + `aggregateFn`(kapalı enum) + delta/yüzde(türetilmiş aritmetik)** hiçbiri Kademe 1'in "belirli bir kişinin doğrudan yazdığı metin" kriterini karşılamaz — bu ADR'nin Karar (c)'sinin ürettiği prompt bu sınıflandırmanın DIŞINA HİÇBİR ZAMAN ÇIKMAZ (hiçbir nesne başlığı/açıklaması/fieldValues içeriği prompt'a girmez, İnsan kararı 2'nin kesin sınırı).

**Sonuç:** ADR-0029'un Kademe 1 kuralının gerektirdiği "yeni bir onay ekranı" (Karar b, madde 32) BU GÖREV İÇİN GEREKMEZ — mevcut workspace-politikası (bir `ai` alan tanımı OLUŞTURMANIN zaten açık bir rıza eylemi olduğu ilkesiyle AYNI kategori: bu AI-üretim yüzeyinin KENDİSİNİN var olması, işlevin doğasını açıkça ortaya koyar) yeterlidir. **Bu, ADR-0029'un GELECEKTEKİ her okuyucusu için resmi bir emsal oluşturur:** bir işin/sorgunun ham SAYISAL agregat sonucunu (bir nesnenin içeriğini DEĞİL) bir AI sağlayıcısına göndermek, Kademe 3 muamelesi görür.

## Alternatifler ve Reddedilme Gerekçeleri

- **Yerleşim: `apps/server/src/ai/`.** Reddedildi (Karar a) — `compileWidgetQuery`/`generateArtifact`'ın "özelliğe-özel AI orkestratörü, o özelliğin sahibi olan klasörde yaşar" ilkesi burada da geçerli; `answerQuestion`'ın jenerik/özellik-agnostik doğası bu görevin AI akışına UYMUYOR.
- **AI çıktı şekli: `answerQuestion`'ın serbest-metin deseni.** Reddedildi (Karar b) — bir "kart" için gereken iki-bölgeli yapıyı (özet+neden-listesi) frontend'de güvenilir biçimde ayrıştırmak için kırılgan bir metin-parse katmanı gerektirirdi.
- **AI çıktı şekli: `generateArtifact`'ın tam `ArtifactContent`'i.** Reddedildi (Karar b) — 5 keyfi section-türü, sabit iki-alanlı bir açıklama kartı için aşırı-mühendislik; `renderArtifactHtml`'in HİÇBİR ZAMAN çağrılmayacağı bir bağlam.
- **Alan etiketlerini (`FieldDefinition.label`) de prompt'a dahil etmek (`FieldDefinitionsService`'i üçüncü bir collaborator olarak eklemek).** Reddedildi (Karar c) — marjinal okunabilirlik kazancı, yeni bağımlılık/hata-yüzeyi maliyetine değmiyor; `compileWidgetQuery` ham anahtarları AI'ya BAŞARIYLA gönderen kanıtlanmış bir emsal.
- **`possibleCauses`'ı `multiSelect` `FieldType` olarak saklamak.** Reddedildi (Karar d) — `multiSelect` KAPALI bir seçenek kümesi varsayar (config'te önceden tanımlı `options`), AI-üretimi SERBEST stringler için yapısal olarak uygun DEĞİL; `querySpec`'in KENDİSİNİN ZATEN kurduğu `longText`-JSON-stringify deseni doğrudan yeniden kullanılıyor.
- **Yeni bir `BaselineExplanationController` sınıfı açmak.** Reddedildi (Karar e) — HTTP-kaynağı (`.../baselines/:id`) `BaselinesController`'ınkiyle AYNI, yalnızca ikinci bir alt-eylem (`/explain`); ayrı bir sınıf gereksiz bölünme yaratırdı. `BaselinesService`'in KENDİSİNE AI-bağımlılığı EKLEMEK de reddedildi — ADR-0044 Karar (c)'nin "SIFIR AI" yatırımını geriye dönük bozardı.
- **`explain()`'i idempotent/önbelleklenmiş yapmak (aynı girdi → önbellekten dön, AI'ı tekrar çağırma).** Reddedildi — İnsan kararı 3'ün "yalnızca AÇIKÇA istenirse yeniden üretilir" ifadesi zaten bunu karşılıyor (kullanıcı istemeden ASLA otomatik yeniden-üretim yok); bir önbellek katmanı EKSTRA karmaşıklık, gerçek bir talep olmadan.
- **Açıklama geçmişi/versiyonlama (her `explain()` çağrısının kendi kaydını tutması).** Reddedildi (v0 kapsamı) — İnsan kararı 3'ün önerdiği "en ucuz, tek-slot üzerine-yazma" modeliyle tutarlı; gerçek talep doğarsa AYRI bir gelecekteki genişleme (Açık Sorular).

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür."** `explain()`'in `setFieldValues` çağrısı TEK bir `FieldValueChanged` olay dizisi yazar (Karar e) — geriye dönük DEĞİŞTİRİLEMEZ; "yeniden oluştur" (Karar f) bir DÜZELTME değil, YENİ bir olay dizisidir (önceki açıklama olay-günlüğünde HÂLÂ görünür, yalnızca `objects_view` projeksiyonundaki GÜNCEL değer üzerine yazılır) — CLAUDE.md'nin "olaylar değişmezdir; düzeltme = yeni olay" ilkesiyle TUTARLI.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** ADR-0044'ün kendi öngörüsünün (Bağlam #422) AKSİNE, `explain()` HÂLÂ kullanıcının DOĞRUDAN, senkron, kullanıcı-tetiklemeli isteğinin sonucudur (İnsan kararı 1 — reaktif, proaktif DEĞİL) — `ProposedAction`/`decide()`/ledger akışının KAPSAMI DIŞINDA kalır, `WidgetsService.generate()`/`ArtifactsService.generate()`'ın AYNI kategorisi. Bu sözleşme yalnızca AJANIN KENDİ BAŞINA/proaktif olarak eyleme geçtiği durumlar için geçerlidir; burada AI yalnızca kullanıcının AÇIKÇA istediği bir açıklamayı ÜRETİYOR, bir aksiyon ÖNERMİYOR/UYGULAMIYOR.
- **Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz.** Açıklama alanları (`explanationSummary`/`explanationCauses`/`explanationGeneratedAt`) gerçek `field_values` satırları olduğundan, MEVCUT genel nesne-export yeteneği bunları OTOMATİK kapsar — bu ADR hiçbir export kısıtlaması İCAT ETMİYOR.
- **Hassas veri sınıfları buluta ham gönderilmez (ADR-0029).** Bu ADR'nin Karar (i)'si ADR-0029'un dört-kademeli sınıflandırmasına RESMİ bir ek getiriyor (yukarıda tam metin) — bu görev, F3-T7→F3-T10 zincirinin AI-gateway'i YENİDEN getiren İLK görevidir, ama İnsan kararı 2'nin agregat-yalnızca kısıtı sayesinde Kademe 1/2'nin gerektirdiği HİÇBİR ek-onay-yüzeyi TETİKLENMEZ — gönderilen veri Kademe 3'ün (metadata) ÜZERİNE ÇIKMAZ.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin Kapsam N vaadinin son parçası (bir sapma AI'nın MUHAKEMESİYLE açıklanabilir hale gelir) `compileWidgetQuery`/`generateArtifact`/`answerQuestion`'ın AYNI, test edilmiş JSON+zod+1-retry+`AIUsageService`-kota/kilit disiplini kullanılarak, hiçbir YENİ AI-orkestrasyon KATEGORİSİ İCAT EDİLMEDEN eklenir; ADR-0029'un o güne kadar boş bırakılmış bir kategorisi (ham sayısal agregat değerler) RESMİ olarak sınıflandırılır.

**Neyi erteliyoruz/kabul ediyoruz:**

- **Proaktif/zamanlanmış sapma-tespiti veya bildirim YOK** (İnsan kararı 1) — sıfır yeni sunucu-tarafı tespit altyapısı; kullanıcı ZATEN `BaselineViewer`'da bir sapma görmeden bu akış tetiklenmez.
- **AI'ya HİÇBİR ham satır/nesne verisi gösterilmez** (İnsan kararı 2) — daha "zengin" bir açıklama (ör. "şu 3 görev gecikti" gibi somut örnekler) bu v0'da MÜMKÜN DEĞİL; yalnızca agregat sayılardan çıkarsanan GENEL bir açıklama üretilir.
- **Açıklama geçmişi/versiyonlama YOK** (İnsan kararı 3 + Karar f) — her "yeniden oluştur" öncekini SİLER; bir "önceki açıklamalar" listesi gerçek talep doğarsa AYRI bir gelecekteki genişleme.
- **Alan etiketi (label) çözümlemesi YOK** (Karar c) — prompt yalnızca ham `targetFieldKey`'i kullanır, `FieldDefinitionsService` bağımlılığı EKLENMEDİ.
- **Yeni bir eşik-yapılandırma UI'ı YOK** — proaktif modelin bir parçası olurdu, reddedildi.

## İnsan kararları

Bu ADR'nin en-yük-taşıyan üç kararı, PLAN.md'nin bu görev için sağladığı TEK çıpanın (bir madde cümlesi) hiçbir somutlaştırma sağlamaması nedeniyle, Plan Mode oturumunda bir `AskUserQuestion` turuyla İNSANA soruldu ve İNSAN TARAFINDAN karara bağlandı — mimarın çıkarımı DEĞİLDİR, aşağıda AYNEN kayıtlıdır:

1. **Tetikleme modeli: REAKTİF, kullanıcı-başlatmalı.** Kullanıcı `BaselineViewer`'da ZATEN bir sapma görüyor, "Açıklama iste" butonuna basarak talep eder. SIFIR yeni sunucu-tarafı tespit altyapısı (cron/scheduled sweep/threshold-crossing event). F3-T9'un "sayfa açılışında otomatik AI analizi" reddiyle TUTARLI. **Reddedilen alternatif:** sunucu-taraflı eşik-aşımı tespiti + otomatik/proaktif kart üretimi — çok daha büyük kapsam (yeni scheduler, yeni event tipi, yeni maliyet-kontrolü).
2. **Veri hassasiyeti: AI'ya YALNIZCA agregat değerler + sorgu metadata'sı gösterilir.** Yakalanan/güncel SAYISAL değerler, delta/yüzde, `aggregateFn`, ve sorgunun alan ANAHTARLARI/etiketleri — HİÇBİR ham satır/nesne verisi (görev başlığı, açıklaması vb.) AI'ya GÖNDERİLMEZ. ADR-0029'un Kademe 3 (metadata) sınıflandırmasına en yakın, en güvenli seçim (Karar i'nin resmi ekiyle netleştirildi). **Reddedilen alternatif:** sapmaya sebep olan örnek satırların ham verisini de göstermek — bu epik-zincirinde İLK KEZ gerçek iş verisinin AI'ya gönderilmesi (Kademe 1) anlamına gelen bir seçim.
3. **Kalıcılık: üretilen açıklama SAKLANIR — baseline `artifact` nesnesine yeni bir alan.** Bir kez üretilip persist edilir, kullanıcı tekrar görüntüledikçe YENİDEN AI çağrısı tetiklenmez — yalnızca kullanıcı açıkça "yeniden oluştur" derse (Karar f). Maliyet-kontrolü açısından daha güvenli (`AIUsageService` kota/bütçesi her görüntülemede değil yalnızca gerçek talepte tüketilir). **Reddedilen alternatif:** `answerQuestion`'ın ephemeral deseni (hiçbir yerde persist edilmez, her istekte yeniden üretilir).

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E4/F3-T11-sapma-aciklama-karti.md`) yazılır. Bu ADR'nin onayı üzerine PR1'e (`packages/artifacts`'a `deviationExplanationSchema`/`DeviationExplanationContent` eklenmesi + `apps/server/src/artifacts/explain-deviation.ts`'in saf orkestratör kısmı — provider mock'lanarak birim test edilebilir) `test-writer` ile başlanır:

```
docs/adr/ADR-0045-sapma-aciklama-karti.md'deki Karar (a)-(i)'yi ve
docs/specs/F3-E4/F3-T11-sapma-aciklama-karti.md'nin Kabul Kriterleri'ni temel alarak, F3-T11
PR1 (packages/artifacts'a deviationExplanationSchema/DeviationExplanationContent eklenmesi +
apps/server/src/artifacts/explain-deviation.ts'in saf JSON+zod+1-retry orkestratörü --
provider mock'lanarak birim test edilebilir, sıfır DB/Nest bağımlılığı) için test-writer ile
başarısız testleri yaz.
```
