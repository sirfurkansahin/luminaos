# ADR-0042: Sorgu → Canlı Widget — Doğal Dil Sorgusunu Sabitlenebilir, Kendini Yenileyen Panele Derleme (Epik F3-E3'ün İkinci Görevi)

**Durum:** Kabul edildi — depolama modelinin YENİ bir `widget` `ObjectType` yerine MEVCUT `artifact` Lumina Object tipinin genişletilmesi olması [insan kararı 1], NL→sorgu derlemesinin YALNIZCA oluşturma anında, tek seferlik bir AI çağrısı olması ve her yenilemenin LLM'i asla yeniden çağırmaması [insan kararı 2], yenileme dağıtımının istemci-taraflı `react-query` `refetchInterval` polling'i olması, YENİ bir sunucu-push altyapısı (WebSocket/SSE) OLMAMASI [insan kararı 3], ve sabit bir yenileme aralığının (görünürlük+ön-plan koşullu) kullanılması [insan kararı 4] — dördü de bu Plan Mode oturumunda insan tarafından ÖNCEDEN dikte edildi (mimarın kendi çıkarımı DEĞİL, aşağıda ayrıca işaretlendi). Bunların ÜZERİNE inşa edilen somut mimari (NL→QuerySpec derleme orkestratörünün şekli, içerik-üretim ayrışması, render tekilliği, sütun türetme, boyut sınırları, HTTP yüzeyi) mimarın KENDİ çıkarımıdır, aşağıda Karar (a)-(j)'de ayrıca işaretlendi.
**Tarih:** 2026-09-11
**İlgili görev:** F3-T8 — "Sorgu → canlı widget": doğal dil sorgusunu sabitlenebilir, kendini yenileyen panel bileşenine derleme. `docs/PLAN.md` satır 288, FAZ 3, Epik F3-E3'ün (Kapsam L) İKİNCİ görevi — F3-T7 (Artifact boru hattı, ADR-0041, `main`'e tam birleşti)'nin DOĞRUDAN devamı.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin İKİNCİ fıkrasını tetikliyor: bu karar birden fazla pakete (`packages/artifacts`, `packages/core-objects`, `apps/server/src/artifacts`, `apps/web`) dayatılan yeni bir veri şekli/kontrat tanımlıyor (`querySpec` alanının Postgres şekli, NL→QuerySpec derleme kontratı, canlı-render tekilliği). Ayrıca ADR-0041 Karar (f)'nin AÇIKÇA bu göreve ERTELEDİĞİ "`dashboard` `artifactType`'ının canlı/kendini-yenileyen hale gelmesi" vaadini yerine getiriyor — F3-T7'nin STATİK-snapshot sınırının BİREBİR karşı tarafı.

> Bu ADR, ADR-0041'in mimari devamı — F3-T7'nin kurduğu `packages/artifacts`/`apps/server/src/artifacts`/`ArtifactViewer` altyapısını YENİDEN İCAT ETMEZ, üzerine EKLER. Bir `explorer` alt-ajanı, F1-T6'nın sorgu DSL'ini (`QuerySpec`, `POST /objects/query`, sıfır AI-maliyeti), F1-T9'un `SavedView`'ını (salt sorgu-yapılandırması, hiçbir "canlı" yeteneği yok), ADR-0041'in tüm render/güvenlik desenini, VE kod tabanında GERÇEK bir generic pub-sub/WebSocket-push mekanizmasının OLMADIĞINI (tek WS kanalı Yjs-özel, `apps/web`'de hiçbir `refetchInterval` emsalinin OLMADIĞINI) doğrudan koddan doğruladı. Bu ADR bu bulguların TAMAMINI mimarinin kendisi bir kez daha, bu görevin somut kapsamında, TEKRAR doğruladı (aşağıda alıntılanan satır numaralarıyla).

## Bağlam

Doğrudan koddan doğrulandı:

1. **`QuerySpec` (F1-T6, ADR-0009)** — `packages/shared/src/query/query-spec.ts`: `{objectType: string (max100), filters: FilterCondition[] (max50), sort?: SortSpec[] (max10), group?: string, cursor?: string (max2000), limit?: number (max200)}`, `.strict()` zod. `FilterCondition = {field(max200), operator (14 literal), value?: unknown}` — **`value` alanı `z.unknown()`, YAPISAL OLARAK SINIRSIZ** (satır 41) — bu ADR'nin Karar (h)'sinde ele alınan gerçek bir taşma yüzeyi.
2. **`POST /workspaces/:workspaceId/objects/query`** (`apps/server/src/objects/objects.controller.ts:104-114`, `ObjectsService.query` `objects.service.ts:484`) — salt parametrize-SQL, `AIUsageService`'e HİÇ dokunmuyor, hiçbir kota/bütçe kapısı yok — her çağrıda ucuz, sınırsız tekrar-çalıştırılabilir. **Kritik güvenlik davranışı (satır 484-530 doğrulandı):** `filters`/`sort`/`group`'ta referans verilen HER alan anahtarı, çağıranın `callerRole`'üne `canViewField` ile GÖRÜNÜR değilse — bilinmeyen bir alanla AYNI şekilde — `NotFoundError` (404) fırlatılır (satır 504-508, "hidden must be indistinguishable from undefined" yorumuyla). Ayrı olarak, dönen HER satırın `fieldValues`'i `toObjectWithFieldValues(row, definitions, callerRole)` (satır 640/688, `query()` içinde) ile AYRI AYRI role-filtrelenir — yani GÖRÜNTÜLENEN sütunlar rol-başına eksik olabilir (sessizce), ama FİLTRE/SIRALA/GRUPLA'da kullanılan bir alan rol-başına tamamen 404'e neden olabilir. Bu ikinci davranış `SavedView`'ın (madde 4) KENDİ paylaşılan `querySpec`'i için ZATEN var olan, bu ADR'nin İCAT ETMEDİĞİ bir risk — Karar (h)/Sonuçlar'da not edilir.
3. **`FieldDefinitionsService.list(workspaceId, objectType, callerRole)`** (`apps/server/src/fields/field-definitions.service.ts:166-185`) — bir `objectType`'ın AKTİF alan tanımlarını döner, `canViewField(definition.permissions, callerRole)` ile ZATEN role-filtrelenmiş. Bu, NL→QuerySpec derleyicisine "hangi gerçek alan anahtarlarına referans verebilirsin" bağlamını GÜVENLE (çağıranın rolüne göre ZATEN kısıtlanmış) sağlamanın hazır emsali.
4. **`SavedView`** (`packages/core-objects/src/saved-views/saved-view.ts:13-28`) — `{objectType, querySpec: Omit<QuerySpec,'cursor'|'limit'>, dateField?/startField?/endField?, ownerId, lifecycle}`, event-kaynaklı CRUD. **PURELY bir sorgu-yapılandırması** — hiçbir render/snapshot/yenileme alanı yok. En yakın emsal ("bir sorguyu sabitle"), ama kendisi bir widget DEĞİL.
5. **ADR-0041'in artifact boru hattı** (`main`'e tam birleşti, F3-T7 PR1/2/3):
   - `artifact` `ObjectType` (`packages/core-objects/src/object-type-registry.ts`, `titleRequired:true`), 4 seed alan: `htmlContent`(`longText`), `themePreset`(`select`: kurumsal/canli/minimal), `generationPrompt`(`longText`), `artifactType`(`select`: presentation/dashboard/page/report) — `apps/server/src/workspaces/workspaces.service.ts:199-260`'daki `seedArtifactFields`, `defineSeedField`'in `ConflictError`-yutan idempotent sarmalayıcısıyla.
   - `ArtifactContent`/`artifactContentSchema` (`packages/artifacts/src/artifact-content.ts`) — `{title, sections: ArtifactSection[]}`, section `kind ∈ {heading,paragraph,list,table,imagePlaceholder}`. **`table` kind ZATEN `{headers: string[] (max20, her biri max200), rows: string[][] (max100 satır, her satır max20 hücre, her hücre max500)}`** — bu ADR'nin canlı sorgu-sonucu tablosu için TAM ihtiyaç duyduğu şekil, YENİ bir section kind GEREKMİYOR (aşağıda Karar d).
   - `renderArtifactHtml` (`packages/artifacts/src/render-artifact-html.ts`) — SAF fonksiyon, sıfır I/O, her LLM/veri-kontrollü string'i `escapeHtml` ile interpolasyondan ÖNCE kaçırır (`<`/`>`/`&`/`"`/`'`). Node-özel HİÇBİR API kullanmıyor — tarayıcıda da ÇALIŞABİLİR (Karar e'nin temel dayanağı).
   - `generateArtifact` (`apps/server/src/artifacts/generate-artifact.ts`) — `parseCommand`'ın (madde 6) BİREBİR aynı JSON-prompt+zod-`safeParse`+1-retry+sentinel deseni, `MAX_ARTIFACT_HTML_LENGTH=200_000` çıktı sınırı.
   - `ArtifactsService.generate()` (`apps/server/src/artifacts/artifacts.service.ts:43-100`) — `AIUsageService.withWorkspaceAILock` İÇİNDE kota/bütçe-assert + provider çağrısı, kilit DIŞINDA `ObjectsService.create()` + `setFieldValues(..., 'owner', [...])` (sabit `'owner'` rolü — çağıranın GERÇEK `callerRole`'ü yalnızca `create()`'i gate'ler, bu iç yazma DEĞİL; satır 83-93'teki yorum bunun `guest`'in `ADR-0041 Karar g`'yi ihlal etmeden başarılı üretim yapabilmesi için KASITLI olduğunu belgeliyor).
   - `ArtifactViewer.tsx` (`apps/web/src/views/shared/ArtifactViewer.tsx`) — `<iframe srcDoc={htmlContent} sandbox="">`, BOŞ `sandbox`, hiçbir `allow-scripts` YOK — DEĞİŞTİRİLMEDEN bu ADR'de yeniden kullanılır.
   - `select-ai-model.ts` — `outputType ∈ {text,select,qa,command,triggerSuggestion,artifact}`, `'select'` HAIKU'ya, GERİ KALANI (açık-uçlu akıl yürütme) SONNET'e yönlendiriliyor (satır 39-41).
   - ADR-0041 Karar (f), satır 343-345: **"`dashboard` bu görevde KESİNLİKLE STATİK... F3-T8'in KENDİ mimari kararı."** — bu ADR o bekleneni yerine getiriyor.
6. **`parseCommand`** (`apps/server/src/ai/parse-command.ts:141-168`) — kanonik NL→yapılandırılmış-JSON şekli. **Kritik ek emsal (satır 60-76/121-133):** bare zod şeması GEÇSE bile, `tryParseActions` AYRICA `ALLOWED_PARSE_COMMAND_TYPES` iş-kuralı allowlist'iyle sonucu SÜZER — şema-geçerli-ama-yanlış-tip bir yanıtı REDDEDER (parse-başarısız sayar, retry tetikler). Bu ADR'nin Karar (c)'sinin "querySpec şema-geçerli ama gerçekte-var-olmayan/görünmez bir alana referans veriyor" durumunu AYNI şekilde ele almasının DOĞRUDAN emsali.
7. **Canlı-yenileme emsatleri:** `AIRefreshScheduler`/`SearchIndexEmbeddingScheduler` (`apps/server/src/ai/`, `apps/server/src/search/`) — SUNUCU-İÇİ, tarayıcıya HİÇ push etmeyen debounce zamanlayıcıları; `DoçCollabGateway` (`apps/server/src/docs/doc-collab.gateway.ts`) — Yjs-CRDT'ye ÖZEL binary protokol, genel bir pub-sub DEĞİL. `apps/web/src/hooks/*` altında HİÇBİR `refetchInterval` kullanımı YOK bugün (repo-çapında doğrulandı) — bu ADR bunu İLK KEZ tanıtıyor, `@tanstack/react-query`'nin (zaten kurulu bağımlılık, `useObjectsQuery.ts` satır 1) yerleşik bir özelliği olarak, YENİ bir kütüphane GEREKMEDEN.
8. **`apps/web`'in mevcut sorgu-tüketim altyapısı** — `postObjectsQuery`/`useObjectsQuery` (`apps/web/src/hooks/useObjectsQuery.ts:10-18`) ZATEN `POST /objects/query`'yi SARMALIYOR; canlı widget'ın yenileme çağrısı için **SIFIR yeni sunucu-uç-noktası gerekiyor** (Karar f). Ayrıca `apps/web/src/views/calendar/calendarQuery.ts:1`'in `@luminaos/shared`'dan `ValidationError`'ı (bir TİP değil, ÇALIŞMA-ZAMANI sınıfı) import ettiği doğrulandı — yani `apps/web`'in saf bir domain paketinden ÇALIŞMA-ZAMANI kod (yalnızca tip değil) tüketmesi ZATEN var olan bir desen; `packages/artifacts`'ın `renderArtifactHtml`'ini AYNI şekilde `apps/web`'e YENİ bir çalışma-zamanı bağımlılığı olarak eklemek (Karar e) bu deseni GENİŞLETİYOR, YENİ bir kategori İCAT ETMİYOR.
9. **`FieldType` union'ı** (`packages/core-objects/src/fields/field-type-registry.ts:13-27`) — TAM OLARAK 14 tip: `text|longText|number|checkbox|date|datetime|select|multiSelect|url|email|people|currency|formula|ai`. **HİÇBİR `json`/yapılandırılmış tip YOK** — `longText`'in `buildValueSchema`'sı (satır 214-217) sınırsız `z.string()` döner, `htmlContent`'in KENDİ şekli. Bu, `querySpec` alanı için `longText` (JSON-serialize edilmiş `QuerySpec`, `htmlContent`'in AYNI deposu) seçimini DOĞRULUYOR — daha "doğru" bir alternatif YOK.

**İnsan kararları (bu Plan Mode oturumunda alındı, mimarın çıkarımı DEĞİL):**

1. **Depolama modeli: MEVCUT `artifact` Lumina Object tipi genişletilir — YENİ bir `widget` `ObjectType` YARATILMAZ.** `seedArtifactFields`'ın AYNI 4-alan seed setine yeni bir alan (`querySpec`) eklenir, `artifactType==='dashboard'` olduğunda kavramsal olarak kullanılır (ama alan HER `artifact` nesnesinde var olur, diğer `artifactType`'lar için kullanılmaz — 4 alanın HERBİRİNİN `artifactType`'tan bağımsız her zaman var olduğu MEVCUT desenle AYNI). Gerekçe: sıfır migration, F3-T7'nin TÜM RBAC/seed/render/viewer altyapısını yeniden kurmak yerine ÜZERİNE inşa eder.
2. **NL→QuerySpec derlemesi: AI-gateway-güdümlü, TEK SEFERLİK, yalnızca widget-oluşturma ANINDA.** `parseCommand`'ın BİREBİR şekli: kullanıcının doğal-dil sorgusu → AI-gateway çağrısı → zod-doğrulanmış `QuerySpec` JSON yanıtı (1 retry, `generateArtifact`'ın AYNI retry deseni) → SAKLANAN şey bu `QuerySpec`'in KENDİSİ. Sonraki HER "yenileme" YALNIZCA saklı `QuerySpec`'i `POST /objects/query`'ye karşı yeniden çalıştırır — LLM ASLA yenilemede tekrar çağrılmaz. `AIUsageService`'in kota/maliyet kapısı YALNIZCA oluşturma anında geçerli, `ArtifactsService.generate()`'in AYNI kilit deseni gibi — yenilemeler düz, kapısız DB sorguları, sorgu-katmanının ZATEN sıfır-maliyet tasarımıyla TUTARLI.
3. **Yenileme dağıtımı: istemci-taraflı polling, react-query `refetchInterval`, MEVCUT ucuz `POST /objects/query` uç-noktasına DOĞRUDAN karşı — v0 için YENİ bir sunucu-push altyapısı (WebSocket/SSE) YOK.** Gerekçe: kod tabanında genel bir pub-sub emsali YOK (tek WS kanalı Yjs'e özel, yeniden kullanılabilir DEĞİL), bunu v0 için inşa etmek "bir sorguyu derle, göster, taze tut" özelliği için orantısız mühendislik; gerçek kullanım talep ederse AYRI bir gelecekteki ADR olabilir.
4. **Yenileme sıklığı: sabit aralık, widget monte/görünürken VE tarayıcı sekmesi ÖN PLANDAYKEN aktif** — `refetchInterval` (somut varsayılan seçilir, aşağıda Karar (e)) + `refetchIntervalInBackground: false`. Standart react-query davranışı, bu karar için sıfır yeni sunucu kodu gerektirmiyor.

**Çözülmesi gereken merkezi sorular:** paket/servis yerleşimi (a), `artifact` nesne modelinin genişletilmesi — yeni alanın Postgres şekli (b), NL→QuerySpec derleme orkestratörünün şekli + doğrulama katmanları (c), widget içeriğinin AI'dan MI yoksa gerçek sorgu satırlarından MI geldiği — üretim akışının kendisi (d), canlı yenileme mekanizması + render tekilliği (e/f), sütun türetme (g), boyut/satır sınırları — YENİ bir tehdit yüzeyine (kullanıcı-kontrollü canlı veri) karşı savunma (h), HTTP yüzeyi (i), düzenleme/regenerasyon kapsamı (j).

## Karar

### (a) Yerleşim — `packages/artifacts` genişler (saf yardımcılar), `apps/server/src/artifacts/`'a YENİ kardeş dosyalar, YENİ paket YOK

ADR-0041 Karar (a)'nın AYNI ikili bölünmesi korunur, YENİDEN İCAT EDİLMEZ:

- **`packages/artifacts`'a EKLENİR** (saf, I/O'suz, `renderArtifactHtml`'in kardeşleri): `deriveWidgetColumns(querySpec): string[]` (Karar g), `buildQueryResultTableSection(rows, columns): ArtifactSection` (Karar d), `MAX_WIDGET_TABLE_ROWS`/`MAX_WIDGET_TABLE_COLUMNS`/`MAX_WIDGET_CELL_LENGTH` sabitleri (Karar h). Hiçbiri YENİ bir bağımlılık gerektirmez (`@luminaos/shared`'ın `QuerySpec` TİPİ zaten import ediliyor olacak, `packages/shared` ZATEN `packages/artifacts`'ın bağımlılığı — ADR-0041 Karar a'da belgelendi).
- **`apps/server/src/artifacts/`'a EKLENİR** (ADR-0041 Karar a'nın "orkestratör app katmanında yaşar" mantığı AYNEN): `compile-widget-query.ts` (Karar c), `widgets.service.ts` (Karar d), `widgets.controller.ts` (Karar i) — `artifacts.module.ts`'e kayıtlı, `ArtifactsService`/`ArtifactsController`'ı DEĞİŞTİRMEDEN yanına eklenir.
- **`apps/web`'e YENİ bağımlılık:** `@luminaos/artifacts` (`workspace:*`) — bugüne kadar yalnızca `@luminaos/core-objects`/`@luminaos/shared`'dan TİP (ve `calendarQuery.ts`'in `ValidationError`'ı gibi ÇALIŞMA-ZAMANI kod) tüketen `apps/web`'in, `renderArtifactHtml`/`THEME_PRESETS`'i ÇALIŞMA-ZAMANINDA çağırması için (Karar e/f). `packages/artifacts` zaten framework-free/saf TS olduğundan (ADR-0041 Karar a), bunu `apps/web`'e bağımlılık olarak eklemek CLAUDE.md'nin "domain paketleri framework import edemez" kısıtını İHLAL ETMEZ — kısıt paketin KENDİ import ettiklerine dair, kimin ONU import ettiğine dair DEĞİL.

**Neden `WidgetsService`/`WidgetsController` `ArtifactsService`/`ArtifactsController`'a birleştirilmiyor (paralel, ayrı dosyalar):** Karar (d)'nin gerekçesiyle DOĞRUDAN bağlantılı — iki akışın ŞEKLİ yeterince farklı (widget'ın girdisi `objectType` gerektiriyor, `artifactType` seçimi GEREKTİRMİYOR her zaman `'dashboard'`; widget'ın "içeriği" AI'dan DEĞİL gerçek sorgu satırlarından geliyor) ki paylaşılan bir kod yolu ZORLAMAK, `ArtifactsService.generate()`'in test edilmiş, `main`'e birleşmiş F3-T7 davranışını dallandırma/regresyon riskine sokardı. `NestJS`, aynı `@Controller('workspaces/:workspaceId/artifacts')` ön-ekini PAYLAŞAN ama farklı alt-yollara (`POST` kökü vs `POST widgets`) sahip iki controller sınıfını sorunsuz destekler (rota çakışması yok) — bu yüzden `WidgetsController`'ın KENDİ sınıfı olması, tek bir devasa controller'a şişirilmiş yeni bir `@Post('widgets')` metodundan daha temiz.

### (b) `artifact` nesne modeli genişletmesi — TEK yeni alan (`querySpec`, `longText`), migration YOK

```ts
// apps/server/src/workspaces/workspaces.service.ts (diff, seedArtifactFields'a EKLENİR)
await this.defineSeedField(
  workspaceId,
  {
    key: 'querySpec',
    label: 'Query Spec',
    fieldType: 'longText',
    config: {},
    permissions: SEEDED_FIELD_PERMISSIONS,
  },
  ARTIFACT_OBJECT_TYPE,
);
```

Bağlam #9'un doğruladığı gibi 14 `FieldType`'ın hiçbirinde bir `json`/yapılandırılmış tip yok — `longText` (`htmlContent`'in KENDİ deposu) tek doğru seçim. Değer `JSON.stringify(querySpec)` olarak saklanır; okunduğunda (hem sunucunun kendi ilk-render'ında hem istemcinin her yenileme tick'inde) `JSON.parse` + `querySpecSchema.safeParse` ile round-trip edilir — `htmlContent`'in HİÇBİR ayrıştırma-şeması olmaması (o zaten HTML string'i) ile TEK fark bu; `querySpec`'in yapısal geçerliliği ÇALIŞMA-ZAMANINDA HER okunuşunda yeniden doğrulanır (savunma-derinliği: saklanan veri bozulursa/elle değiştirilirse sessizce yanlış bir sorgu ÇALIŞTIRILMAZ, `parse` başarısız olur, widget "geçersiz sorgu" hata durumuna düşer — Karar (i)'de detaylandırılır).

Diğer 4 alan (`htmlContent`/`themePreset`/`generationPrompt`/`artifactType`) DEĞİŞMEDEN kalır; bir widget oluşturulduğunda `artifactType='dashboard'` sabit değeriyle, `htmlContent` widget'ın İLK anlık görüntüsüyle (Karar d) doldurulur — böylece bir `artifact` listesinde/`GET /objects/:id`'de bir widget, hiçbir canlı bağlam olmadan görüntülense bile ANLAMLI bir statik önizleme gösterir (F3-T7'nin garantisini KORUR).

**Yazma-anı boyut sınırı:** `querySpec`'in serialize edilmiş JSON'u `MAX_SERIALIZED_QUERY_SPEC_LENGTH = 20_000` karakteri aşarsa `compileWidgetQuery` başarısızlık sinyali döner (Karar c/h) — `FilterCondition.value: z.unknown()`'ın (Bağlam #1) yapısal olarak sınırsız olması nedeniyle GEREKLİ; `querySpecSchema`'nın kendisi bu boyutu SINIRLAMIYOR, sorumluluk (ADR-0041 Karar b'nin `MAX_ARTIFACT_HTML_LENGTH`'ı gibi) orkestratörün KENDİSİNDE.

### (c) NL→QuerySpec derleme — `compileWidgetQuery`, `parseCommand`'ın deseni + iş-kuralı allowlist katmanı

```ts
// apps/server/src/artifacts/compile-widget-query.ts
import { querySpecSchema, type QuerySpec } from '@luminaos/shared';
import { isKnownObjectType, type FieldDefinition, type ObjectType } from '@luminaos/core-objects';

export interface CompileWidgetQueryInput {
  provider: AIProvider;
  prompt: string;
  objectType: ObjectType;
  availableFields: FieldDefinition[]; // callerRole ile ZATEN filtrelenmiş (FieldDefinitionsService.list)
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface CompileWidgetQueryResult {
  querySpec: QuerySpec | undefined;
  parseError: boolean;
  message?: string;
}

const MAX_SERIALIZED_QUERY_SPEC_LENGTH = 20_000;
const COMPILE_EXHAUSTED_MESSAGE =
  'AI response could not be compiled into a valid, referenceable query after retry';

function renderWidgetQueryPrompt(
  prompt: string,
  objectType: ObjectType,
  availableFields: FieldDefinition[],
): string {
  const fieldList = availableFields
    .map((f) => `- ${f.key} (${f.fieldType}): ${f.label}`)
    .join('\n');
  return [
    `Compile the natural-language request below into a JSON QuerySpec object against object type "${objectType}".`,
    'Respond with ONLY a JSON object (no surrounding text, no markdown fences) with exactly these fields:',
    `- objectType: MUST be exactly "${objectType}"`,
    '- filters: an array of {field, operator, value?} -- field MUST be one of the field keys listed below, or "title"',
    '- sort: OPTIONAL array of {field, direction: "asc"|"desc"}',
    'Do NOT include "group" or "cursor" -- this widget renders a flat table, not grouped data.',
    '',
    'Available fields:',
    fieldList,
    '',
    `Request: ${prompt}`,
  ].join('\n');
}

/**
 * `parseCommand`'ın `ALLOWED_PARSE_COMMAND_TYPES` desenini (bare zod GEÇSE
 * bile bir iş-kuralı allowlist'iyle SÜZME) izler: `objectType` tam istenen
 * tipe eşit mi, `group` YOK mu (v0 flat-only, Karar d), her filter/sort
 * `field` `availableFields`'in anahtar kümesinde (+ "title") mi -- hiçbiri
 * geçmezse bu bir "parse başarısız" sayılır (retry tetiklenir), SESSİZCE
 * budama/düzeltme YAPILMAZ (ADR-0041 Karar b'nin "kesilmiş çıktı, bozuk
 * markup'tan daha kötü" felsefesiyle TUTARLI).
 */
function validateCompiledQuerySpec(
  candidate: QuerySpec,
  objectType: ObjectType,
  allowedFieldKeys: ReadonlySet<string>,
): QuerySpec | undefined {
  if (candidate.objectType !== objectType) return undefined;
  if (candidate.group !== undefined) return undefined;
  if (JSON.stringify(candidate).length > MAX_SERIALIZED_QUERY_SPEC_LENGTH) return undefined;

  const referencedFields = [
    ...candidate.filters.map((f) => f.field),
    ...(candidate.sort ?? []).map((s) => s.field),
  ];
  const allAllowed = referencedFields.every(
    (field) => field === 'title' || allowedFieldKeys.has(field),
  );
  if (!allAllowed) return undefined;

  // limit clamp: benign, does NOT reject (Karar h) -- unlike an unknown
  // field (a sign of hallucination), an oversized limit is safely narrowed.
  const limit = Math.min(candidate.limit ?? MAX_WIDGET_TABLE_ROWS, MAX_WIDGET_TABLE_ROWS);
  return { ...candidate, limit };
}

export async function compileWidgetQuery(
  input: CompileWidgetQueryInput,
): Promise<CompileWidgetQueryResult> {
  const prompt = renderWidgetQueryPrompt(input.prompt, input.objectType, input.availableFields);
  const allowedFieldKeys = new Set(input.availableFields.map((f) => f.key));

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const tryOnce = (text: string): QuerySpec | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const result = querySpecSchema.safeParse(parsed);
    if (!result.success) return undefined;
    return validateCompiledQuerySpec(result.data, input.objectType, allowedFieldKeys);
  };

  const querySpec = tryOnce(await complete()) ?? tryOnce(await complete());

  if (querySpec === undefined) {
    return { querySpec: undefined, parseError: true, message: COMPILE_EXHAUSTED_MESSAGE };
  }

  return { querySpec, parseError: false };
}
```

`select-ai-model.ts`'e YENİ `outputType: 'widgetQuery'` eklenir, `'artifact'`/`'command'` ile AYNI mantıkla `CLAUDE_SONNET_5`'e yönlendirilir — serbest metni gerçek alan anahtarları/operatörlerine eşlemek `'select'`in kısıtlı-seçim kategorisinden ÇOK, `parseCommand`'ın açık-uçlu akıl yürütme kategorisine daha yakın.

### (d) Üretim akışı ayrışması — widget İÇERİĞİ AI'dan DEĞİL, gerçek sorgu satırlarından gelir; `generateArtifact` bu yolda HİÇ ÇAĞRILMAZ

**En yük taşıyan karar (ADR-0041 Karar c'nin bu görevdeki dengi).** `ArtifactsService.generate()`'in "AI TÜM içeriği üretir" modeli widget'lar için YANLIŞ model — bir dashboard widget'ının "içeriği" kullanıcının GERÇEK, canlı, kendi düzenleyebildiği veridir, AI'ın HAYAL ETTİĞİ bir metin DEĞİL. `WidgetsService.generate()` bu yüzden `ArtifactsService.generate()`'i ÇAĞIRMAZ, kendi paralel akışını izler:

```ts
// apps/server/src/artifacts/widgets.service.ts
@Injectable()
export class WidgetsService {
  constructor(
    private readonly aiUsageService: AIUsageService,
    private readonly objectsService: ObjectsService,
    private readonly fieldDefinitionsService: FieldDefinitionsService,
    @Inject(AI_PROVIDER) private readonly provider: AIProvider,
  ) {}

  async generate(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    input: { prompt: string; objectType: ObjectType; themePreset: ThemePresetName },
  ): Promise<ObjectWithFieldValues> {
    // 1. Rol-filtrelenmiş alan bağlamı -- compileWidgetQuery'nin allowlist'i
    //    için (Bağlam #3, Karar c).
    const availableFields = await this.fieldDefinitionsService.list(
      workspaceId,
      input.objectType,
      callerRole,
    );

    // 2. TEK AI çağrısı, kilit İÇİNDE (insan kararı 2) -- SADECE QuerySpec üretir.
    const { querySpec, parseError, message } = await this.aiUsageService.withWorkspaceAILock(
      workspaceId,
      async () => {
        await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
        await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);
        const model = selectAIModel({ outputType: 'widgetQuery' });
        return compileWidgetQuery({
          provider: this.provider,
          prompt: input.prompt,
          objectType: input.objectType,
          availableFields,
          model,
          recordUsage: (usage) =>
            this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
        });
      },
    );

    if (parseError || querySpec === undefined) {
      throw new ValidationError(message ?? 'Widget query compilation failed.');
    }

    // 3. Kilit DIŞINDA, düz, kapısız bir DB sorgusu (insan kararı 2/3) --
    //    ilk statik anlık görüntü için.
    const initialResult = await this.objectsService.query(workspaceId, callerRole, querySpec);
    const rows = 'objects' in initialResult ? initialResult.objects : [];

    // 4. SAF, kod-yazılı içerik üretimi -- AI BURADA YOK.
    const columns = deriveWidgetColumns(querySpec);
    const content: ArtifactContent = {
      title: input.prompt.slice(0, 200),
      sections: [buildQueryResultTableSection(rows, columns)],
    };
    const htmlContent = renderArtifactHtml(content, input.themePreset, 'dashboard');

    // 5. Persist -- ArtifactsService.generate()'in AYNI create+setFieldValues
    //    ('owner'-bypass, ADR-0041 satır 83-93) deseni, artı YENİ querySpec alanı.
    const created = await this.objectsService.create(
      workspaceId,
      actor,
      { objectType: 'artifact', title: content.title },
      callerRole,
    );
    return this.objectsService.setFieldValues(workspaceId, created.id, actor, 'owner', [
      { fieldKey: 'htmlContent', value: htmlContent },
      { fieldKey: 'themePreset', value: input.themePreset },
      { fieldKey: 'generationPrompt', value: input.prompt },
      { fieldKey: 'artifactType', value: 'dashboard' },
      { fieldKey: 'querySpec', value: JSON.stringify(querySpec) },
    ]);
  }
}
```

`renderArtifactHtml` ve `ArtifactViewer.tsx` HİÇ DEĞİŞMEZ — yalnızca `ArtifactContent.sections`'ın TEK section'ı artık AI'ın YAZDIĞI bir `paragraph`/`heading` DEĞİL, `buildQueryResultTableSection`'ın gerçek satırlardan İNŞA ETTİĞİ bir `table`. Bu, ADR-0041 Karar (c)'nin escaping garantisini (her hücre `escapeHtml`'den geçer) DEĞİŞTİRMEDEN MİRAS ALIR.

### (e) Canlı yenileme — istemci-taraflı `react-query` polling, YENİ sunucu uç-noktası YOK

```ts
// apps/web/src/hooks/useLiveWidgetQuery.ts
const WIDGET_REFRESH_INTERVAL_MS = 45_000; // insan kararı 4'ün "30-60s" aralığının ortası

export function useLiveWidgetQuery(
  workspaceId: string,
  querySpec: QuerySpec | undefined,
): UseQueryResult<QueryResult> {
  return useQuery({
    queryKey: ['liveWidget', workspaceId, querySpec],
    queryFn: () => postObjectsQuery(workspaceId, querySpec as QuerySpec),
    enabled: querySpec !== undefined,
    refetchInterval: WIDGET_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false, // insan kararı 4
  });
}
```

`postObjectsQuery` (Bağlam #8) DEĞİŞMEZ, `apps/server`'da SIFIR yeni kod yazılır bu karar için — mevcut `POST /objects/query`'nin kendi RBAC'ı (field-visibility filtrelemesi dahil, Bağlam #2) her poll'da ZATEN uygulanıyor, YENİDEN İCAT EDİLMİYOR. `useObjectsQuery`'nin KENDİSİ (diğer tüm çağıranlar için) DEĞİŞTİRİLMEZ — `useLiveWidgetQuery` YENİ, ayrı bir hook, `refetchInterval`'ı varsayılan DAVRANIŞ olarak sızdırmadan.

### (f) Render tekilliği — istemci `renderArtifactHtml`'i AYNI şekilde çağırır, YENİ bir escaping/şablon mantığı YAZILMAZ

```tsx
// apps/web/src/views/shared/LiveWidgetViewer.tsx
export function LiveWidgetViewer({
  workspaceId,
  artifactObjectId,
}: {
  workspaceId: string;
  artifactObjectId: string;
}) {
  const { data: objectData } = useObjectQuery(workspaceId, artifactObjectId);
  const object = objectData?.object;

  const querySpec = useMemo(() => {
    if (!object) return undefined;
    const raw = object.fieldValues.querySpec;
    if (typeof raw !== 'string') return undefined;
    const parsed = querySpecSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }, [object]);

  const { data: liveResult, isError } = useLiveWidgetQuery(workspaceId, querySpec);

  const htmlContent = useMemo(() => {
    if (!object) return undefined;
    if (querySpec === undefined) return object.fieldValues.htmlContent as string; // fallback: statik ilk anlık görüntü
    const rows = liveResult && 'objects' in liveResult ? liveResult.objects : [];
    const columns = deriveWidgetColumns(querySpec);
    const content: ArtifactContent = {
      title: object.title,
      sections: [buildQueryResultTableSection(rows, columns)],
    };
    return renderArtifactHtml(
      content,
      object.fieldValues.themePreset as ThemePresetName,
      'dashboard',
    );
  }, [object, querySpec, liveResult]);

  if (!htmlContent) return null;
  return <ArtifactViewer htmlContent={htmlContent} />;
}
```

`ArtifactViewer` DEĞİŞMEZ (Karar a'nın "apps/web'e yeni bağımlılık" gerekçesi burada somutlaşıyor). `deriveWidgetColumns`/`buildQueryResultTableSection`/`renderArtifactHtml`, sunucunun oluşturma-anı çağrısıyla (Karar d, adım 4) VE istemcinin HER yenileme tick'iyle çağrılan **AYNI, tek kaynaklı, saf fonksiyonlar** — escaping garantisi (ADR-0041 Karar c/d) iki kez YAZILMIYOR, bir kez.

### (g) Sütun türetme — `deriveWidgetColumns`, kod-only, AI'dan BAĞIMSIZ

```ts
// packages/artifacts/src/derive-widget-columns.ts
export const MAX_WIDGET_TABLE_COLUMNS = 8;

export function deriveWidgetColumns(querySpec: QuerySpec): string[] {
  const referenced = [
    'title',
    ...querySpec.filters.map((f) => f.field),
    ...(querySpec.sort ?? []).map((s) => s.field),
  ];
  return Array.from(new Set(referenced)).slice(0, MAX_WIDGET_TABLE_COLUMNS);
}
```

AI'ın `querySpec` DIŞINDA HİÇBİR ek "hangi sütunları göster" çıktısı üretmesi İSTENMEZ (kapsam dışı: "QuerySpec'in kendisine hiçbir şema değişikliği yapılmaz" kısıtına saygı — bu YENİ bir sarmalayıcı tip DEĞİL, saklanan tek şey saf `QuerySpec`'in kendisi). `title` HER ZAMAN ilk sütun (nesnenin KENDİ `.title`'ı, `fieldValues` İÇİNDE DEĞİL) — `buildQueryResultTableSection` bunu özel olarak ele alır.

### (h) Boyut/satır sınırları — YENİ bir tehdit yüzeyine (kullanıcı-kontrollü canlı veri) karşı savunma

ADR-0041 Karar (b)/(d)'nin escaping+boyut-sınırı disiplini, LLM çıktısı için tasarlandı — bu ADR'de girdi artık **herhangi bir workspace üyesinin kendi nesnesinin bir alanına yazdığı GERÇEK veri** (Bağlam'daki brief'in vurgusu: "saldırgan" artık AI'ın çıktısı değil, herhangi bir üyenin field-value düzenlemesi). `buildQueryResultTableSection` bu yüzden KENDİ sınırlarını uygular:

```ts
// packages/artifacts/src/build-query-result-table-section.ts
export const MAX_WIDGET_TABLE_ROWS = 25;
export const MAX_WIDGET_CELL_LENGTH = 500; // artifactSectionSchema'nın table.rows hücre sınırıyla TUTARLI

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, MAX_WIDGET_CELL_LENGTH);
  if (Array.isArray(value)) return value.map(String).join(', ').slice(0, MAX_WIDGET_CELL_LENGTH);
  return String(value).slice(0, MAX_WIDGET_CELL_LENGTH);
}

export function buildQueryResultTableSection(
  rows: { title: string; fieldValues: Record<string, unknown> }[],
  columns: string[],
): ArtifactSection {
  const limitedRows = rows.slice(0, MAX_WIDGET_TABLE_ROWS);
  return {
    kind: 'table',
    headers: columns,
    rows: limitedRows.map((row) =>
      columns.map((col) =>
        col === 'title' ? stringifyCell(row.title) : stringifyCell(row.fieldValues[col]),
      ),
    ),
  };
}
```

Her hücre `renderArtifactHtml`'in `escapeHtml`'inden AYNI şekilde geçer (Karar f) — bu fonksiyon KENDİSİ HTML üretmiyor, yalnızca `ArtifactSection`'ın (zaten `artifactContentSchema` tarafından max20/max100/max500 ile sınırlanan, Bağlam #5) veri şeklini dolduruyor. `MAX_WIDGET_TABLE_ROWS=25` AYRICA Karar (c)'nin `limit` clamp'ının değeridir — derleme-anı VE her yenileme-tick'i AYNI üst sınırı paylaşır.

### (i) HTTP yüzeyi — YENİ `POST /workspaces/:workspaceId/artifacts/widgets`, yenileme için YENİ uç-nokta YOK

```ts
// apps/server/src/artifacts/widgets.controller.ts
@Controller('workspaces/:workspaceId/artifacts/widgets')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class WidgetsController {
  constructor(private readonly widgetsService: WidgetsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async generate(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(generateWidgetSchema)) body: GenerateWidgetRequestInput,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);
    const object = await this.widgetsService.generate(workspaceId, actor, callerRole, body);
    return { object };
  }
  // requireActor/requireRole: ArtifactsController'ınkiyle BİREBİR aynı desen.
}

const generateWidgetSchema = z
  .object({
    prompt: z.string().min(1).max(4000),
    objectType: z.string().min(1).max(100), // isKnownObjectType ile WidgetsService içinde doğrulanır
    themePreset: z.enum(['kurumsal', 'canli', 'minimal']),
  })
  .strict();
```

RBAC: `SessionAuthGuard`+`WorkspaceMembershipGuard` DIŞINDA hiçbir ek kapı — ADR-0041 Karar (g)'nin AYNI `member+` tabanı (mimarinin tekrar icat etmediği, aynen taşıdığı bir karar). **Yenileme için YENİ bir `POST .../refresh` uç-noktası YOK** (insan kararı 3) — Karar (e)'nin mevcut `POST /objects/query`'yi doğrudan kullanması bunu gereksiz kılıyor. Okuma rotaları (`GET /objects/:objectId`, `POST /objects/query`) ADR-0041 Karar (h) gibi ZATEN mevcut, DEĞİŞMEDEN widget nesnelerini de kapsıyor.

### (j) Düzenleme/regenerasyon kapsamı — v0'da YOK, yalnızca sil+yeniden-oluştur

Bir widget'ın saklı `querySpec`'ini oluşturmadan SONRA düzenlemek (görsel sorgu oluşturucu VEYA yeni bir NL prompt'uyla regenerasyon) v0'da desteklenmiyor — ADR-0041'in KENDİSİNİN artifact'lar için bir "regenerate" uç-noktası SUNMAMASIYLA (yalnızca `POST` oluşturma var) TUTARLI bir minimalizm. Bir kullanıcının sorgusunu değiştirmek istemesi durumunda, mevcut widget silinir (genel nesne-silme, hiçbir yeni kod), yeni bir NL prompt'uyla YENİ bir widget oluşturulur. Gerçek bir "düzenle" ihtiyacı doğarsa, AYRI bir gelecekteki karar/görev gerektirir (CLAUDE.md: "hazır olmuşken kapsamı ekleme").

## Somut Şekiller

```ts
// packages/core-objects/src/object-type-registry.ts -- DEĞİŞİKLİK YOK (Karar b, insan kararı 1)
```

```ts
// apps/server/src/workspaces/workspaces.service.ts (diff) -- Karar (b)'nin kod parçası yukarıda
```

(Karar c/d/e/f/g/h/i'nin tam kod sketch'leri yukarıda Karar bölümünde — burada tekrarlanmıyor.)

Migration: **YOK gerekli** (Karar b, ADR-0041 Karar b'nin BİREBİR aynı gerekçesi) — `field_values`/`objects_view` şeması hiçbir DDL değişikliği gerektirmez, yalnızca `workspaces.service.ts`'e bir seed satırı.

## Alternatifler ve Reddedilme Gerekçeleri

- **YENİ bir `widget` `ObjectType` yaratmak.** Reddedildi (insan kararı 1) — `artifact`'ın TÜM RBAC/seed/render/viewer altyapısını YENİDEN kurmak, marjinal kavramsal saflık için orantısız; `artifactType='dashboard'` ZATEN ADR-0041'de bu ayrımı taşıyor.
- **Her yenilemede LLM'i yeniden çağırmak (ör. "veriyi özetle" tarzı bir canlı-AI-widget).** Reddedildi (insan kararı 2) — her 30-60 saniyede bir AI-maliyeti/kota tüketimi, "canlı widget"ın DOĞASI gereği sık-çalışan bir mekanizma için sürdürülemez; sorgu katmanının KENDİSİ ZATEN sıfır-maliyetli, LLM'i yalnızca BİR KEZ (derleme anında) kullanmak bu avantajı KORUR.
- **Gerçek sunucu-push (WebSocket/SSE) ile canlı yenileme.** Reddedildi (insan kararı 3) — kod tabanında yeniden kullanılabilir bir genel pub-sub emsali YOK (tek WS kanalı Yjs'e özel); v0 için inşa etmek orantısız mühendislik, gerçek talep doğarsa AYRI bir ADR.
- **`WidgetsService.generate()`'i `ArtifactsService.generate()`'in İÇİNE, `artifactType==='dashboard'` dalı olarak gömmek.** Reddedildi (Karar a/d) — iki akışın girdi şekli (`objectType` gereksinimi) VE içerik-kaynağı (AI vs gerçek sorgu satırları) yeterince farklı; paylaşılan bir kod yolu ZORLAMAK `ArtifactsService.generate()`'in test edilmiş F3-T7 davranışını dallandırma riskine sokardı.
- **Sunucu-taraflı bir `POST .../artifacts/:id/refresh` uç-noktası açıp her yenileme tick'inde `htmlContent`'i YENİDEN PERSİST ETMEK.** Reddedildi — bu, "widget monte/görünürken her 30-60s'de bir kalıcı bir `FieldValueChanged` olayı yazmak" anlamına gelirdi; bir widget uzun süre açık bırakıldığında olay-günlüğünü türetilmiş bir önbellek değeri için gereksiz yere şişirir (Mimari Değişmezler'deki "tek doğruluk kaynağı olay günlüğü" ilkesiyle GERİLİM yaratırdı — her poll GERÇEK bir domain olayı DEĞİL, yalnızca bir önbellek-yenileme). İstemci-taraflı render (Karar f), aynı görsel sonucu SIFIR yeni olay yazmadan verir.
- **Sütun listesini de AI'a ürettirmek (`QuerySpec`'i `{querySpec, displayFields}` gibi bir sarmalayıcıya genişletmek).** Reddedildi (Karar g) — kapsam dışı kısıtına ("QuerySpec'in kendisine şema değişikliği yok") en sıkı uyan okuma, saklanan TEK şeyin saf `QuerySpec` kalması; sütunlar `querySpec`'in KENDİ filters/sort alanlarından deterministik olarak türetilebiliyor, ek bir AI çıktısı/şema genişlemesi GEREKMİYOR.
- **`packages/artifacts`'ın render fonksiyonlarını `apps/web`'e taşımak/kopyalamak (paylaşılan paket yerine).** Reddedildi (Karar a/f) — escaping garantisini İKİ YERDE bakımı gereken iki ayrı implementasyona bölerdi; `packages/artifacts` zaten framework-free olduğundan `apps/web`'e bağımlılık olarak eklemenin hiçbir mimari engeli yok (Bağlam #8'in `calendarQuery.ts` emsali).
- **v0'da pinned widget'ın `querySpec`'ini düzenlemeyi desteklemek.** Reddedildi (Karar j) — ADR-0041'in KENDİSİ artifact'lar için "regenerate" sunmuyor; sil+yeniden-oluştur v0 için yeterli, gerçek ihtiyaç AYRI bir karar gerektirir.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** Widget'ın saklı `htmlContent`/`querySpec` alanları YALNIZCA oluşturma anında bir olay yazar (Karar d, adım 5) — her yenileme (Karar e/f) HİÇBİR olay YAZMAZ, salt bir OKUMA + istemci-taraflı türetilmiş render. Bu, ilkenin "her önbellek-tazeleme bir olay OLMALI" şeklinde YANLIŞ yorumlanmasını AÇIKÇA reddediyor — sunucu-taraflı bir refresh-endpoint alternatifinin (yukarıda reddedildi) tam olarak İHLAL EDECEĞİ şey buydu.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** ADR-0041'in KENDİ gerekçesiyle AYNI: widget oluşturma kullanıcının DOĞRUDAN, senkron isteğinin sonucu (`resolveAIFieldValue`/`generateArtifact` kategorisi), `ProposedAction`/`decide()`/ledger akışının KAPSAMI DIŞINDA — onay/otonomi-kademesi/geri-alma gerektirmez.
- **Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz.** Widget, gerçek bir `artifact` Lumina Object olduğundan, MEVCUT genel nesne-export yeteneği onu OTOMATİK kapsar — bu ADR hiçbir export kısıtlaması İCAT ETMİYOR.
- **Hassas veri sınıfları buluta ham gönderilmez (ADR-0029).** NL derleme prompt'u kullanıcının serbest-metin isteği + `availableFields`'ın anahtar/etiket/tip META-verisi (GERÇEK alan DEĞERLERİ DEĞİL) — `parseCommand`'ın KENDİ `command` string'i ile AYNI kategori, YENİ bir hassas-veri kanalı AÇILMIYOR. **Kritik ayrım:** widget'ın CANLI VERİSİNİN KENDİSİ (sorgu sonucu satırları) HİÇBİR ZAMAN AI'a gönderilmiyor (insan kararı 2 — derleme SADECE `QuerySpec`'i üretiyor, sonuçları DEĞİL) — bu ADR'nin en önemli güvenlik özelliği, "zaten getirilmiş veriyi özetle" (ADR-0041'in erteldiği, ADR-0029'un dört-kademeli sınıflandırmasına tabi olacak gelecekteki özellik) İLE KARIŞTIRILMAMALI.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin F3-T8 vaadi (doğal-dil sorgusunu sabitlenebilir, kendini-yenileyen bir panele derleme) hiçbir yeni depolama alt sistemi, hiçbir yeni sunucu-push altyapısı, hiçbir yeni escaping/render mantığı İCAT EDİLMEDEN, ADR-0041'in TÜM güvenlik/RBAC/render altyapısının ÜZERİNE kurulur; en kritik yeni risk (canlı, kullanıcı-kontrollü veri artık `htmlContent`'e akıyor) `renderArtifactHtml`'in AYNI escaping garantisini YENİDEN KULLANARAK (yeniden yazmadan) çözülür.

**Neyi erteliyoruz/kabul ediyoruz:**

- Gerçek sunucu-push (WebSocket/SSE) YOK (insan kararı 3) — v0 yenilemesi 45s'lik polling ile SINIRLI; gerçek talep doğarsa AYRI bir ADR.
- Widget'ın `querySpec`'i oluşturmadan SONRA düzenlenemez (Karar j) — yalnızca sil+yeniden-oluştur.
- Yalnızca DÜZ (flat, gruplanmamış) sorgular desteklenir (Karar c/d) — `QuerySpec.group` v0'da widget'lar için YASAK; grup-bazlı canlı widget'lar (ör. durum-bazlı sayaç panoları) AYRI bir gelecekteki genişleme.
- Tablo başına en fazla 8 sütun, 25 satır, hücre başına 500 karakter (Karar g/h) — daha zengin/geniş canlı görünümler (grafik, kart-görünümü) gelecekte `packages/artifacts`'a YENİ section-kind'lar eklenerek genişletilebilir, bugünkü `table`-only ile SINIRLI.
- **Bilinen, YENİ OLMAYAN bir sınır:** saklı `querySpec`'in filters/sort alanlarına referans veren bir alan, widget'ı GÖRÜNTÜLEYEN bir kullanıcının rolüne GİZLİ ise, `POST /objects/query` 404 döner (Bağlam #2) — widget o kullanıcı için TAMAMEN kırılır (yalnızca o sütun eksik GÖRÜNMEZ). Bu, `SavedView`'ın (Bağlam #4) paylaşılan `querySpec`'i için ZATEN var olan, bu ADR'nin İCAT ETMEDİĞİ bir risk — v0'da AYRICA ÇÖZÜLMÜYOR, gelecekte `SavedView`'la BİRLİKTE ele alınabilecek bir genel sorun olarak not edilir.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E3/F3-T8-sorgu-canli-widget.md`) yazılır. Bu ADR'nin onayı üzerine PR1'e (`packages/artifacts` genişlemesi: `deriveWidgetColumns`, `buildQueryResultTableSection`, ilgili sabitler — SIFIR I/O, tamamen birim-test edilebilir) `test-writer` ile başlanır:

```
docs/adr/ADR-0042-sorgu-canli-widget.md'deki Karar (a)-(j)'yi ve
docs/specs/F3-E3/F3-T8-sorgu-canli-widget.md'nin Kabul Kriterleri'ni temel alarak, F3-T8
PR1 (packages/artifacts genişlemesi: deriveWidgetColumns, buildQueryResultTableSection,
MAX_WIDGET_TABLE_ROWS/MAX_WIDGET_TABLE_COLUMNS/MAX_WIDGET_CELL_LENGTH sabitleri -- sıfır I/O,
mevcut renderArtifactHtml/artifactContentSchema'yı DEĞİŞTİRMEDEN yeniden kullanır) için
test-writer ile başarısız testleri yaz.
```
