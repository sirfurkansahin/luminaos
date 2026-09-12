# ADR-0044: Evrensel Baseline/Sapma Motoru — Herhangi Bir Sorgunun Anlık Görüntüsü + Saf Sapma Hesaplayıcı (Epik F3-E4'ün İlk Görevi)

**Durum:** Kabul edildi — bu ADR'deki kararların neredeyse tamamı mimarın kendi çıkarımı (F3-T7/T8/T9'un tutarlı emsal zincirinden ve gerçek koddan doğrulandı), TEK istisna Karar (d)'nin "yalnızca mevcut bir `SavedView`'dan baseline yakala, ham/ad-hoc sorgu girişi YOK" kısıtı — mimar bunu kendi çıkarımı olarak önerdi AMA PLAN.md'de hiçbir açık çıpası olmadığını AÇIKÇA işaretleyip insana ikinci bir onay turunda sordu; insan mimarın önerisini (SavedView-only, Recommended seçenek) AYNEN onayladı — bu şimdi insan kararı 1 olarak kayıtlıdır (aşağıda İnsan kararları). `docs/PLAN.md`'nin Kapsam N için sağladığı tek somut çıpa üç satırdır (faz-haritası satırı, tek mimari cümle, `baseline_snapshot(query_id, t)` + fark motoru vizyon özeti) — geri kalan HER karar (a)-(k) mimarın kendi çıkarımı, F3-T7/T8/T9'un tutarlı emsal zincirinden ve gerçek koddan doğrulanmıştır. Kapsam önerisinin çağıran ajan tarafından sunulan 8 maddesi TAMAMI doğrulandı ve KABUL edildi (küçük düzeltmelerle, aşağıda işaretli) — hiçbiri reddedilmedi.
**Tarih:** 2026-09-12
**İlgili görev:** F3-T10 — "Evrensel baseline: herhangi bir sorgu/metrik/plan anlık görüntüsü + sapma hesaplayıcı". `docs/PLAN.md` satır 35 (Kapsam N faz-haritası), satır 55 (event-sourcing mimari cümlesi), satır 291-294 (görev listesi), satır 315 (`baseline_snapshot(query_id, t)` vizyon özeti). Epik F3-E4'ün (Plan-Gerçek Motoru) İLK görevi — F3-E3 (F3-T7/T8/T9, hepsi `main`'e birleşti) sonrası yeni bir epik.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin İKİNCİ fıkrasını tetikliyor: bu karar `packages/artifacts`, `packages/core-objects`, `apps/server/src/artifacts`, `apps/web`'e dayatılan YENİ bir veri şekli/kontrat tanımlıyor (`capturedValue`/`aggregateFn`/`targetFieldKey` alanlarının Postgres şekli, `computeQueryAggregate`'in kontratı, sapma-hesaplama fonksiyonunun şekli) VE PLAN.md'nin kendi mimari cümlesinin ("Plan-Gerçek motoru event sourcing ile kurulur") somutlaştığı ilk yer.

> Bu ADR, ADR-0041/0042'nin mimari devamı — `packages/artifacts`/`apps/server/src/artifacts`/`artifact` `ObjectType`'ını YENİDEN İCAT ETMEZ, üzerine EKLER. Bir `explorer` alt-ajanı PLAN.md'nin Kapsam N için ADR-0041/0042/0043'ün her birinden DAHA ZAYIF bir çıpaya sahip olduğunu (yalnızca 1 faz-satırı + 1 mimari cümle + 2 görev-madde + 1 vizyon-özeti satırı) doğruca koddan onayladı; bu ADR o boşluğu, F3-T7→T8→T9 zincirinin "en ucuz/en çok-yeniden-kullanılan seçeneği seç" düzenliliğini TEK rehber ilke olarak kullanarak dolduruyor.

## Bağlam

Doğrudan koddan doğrulandı (bu oturumda tekrar):

1. **`QuerySpec`/`querySpecSchema`** (`packages/shared/src/query/query-spec.ts:63-78`) — `{objectType(max100), filters(max50), sort?(max10), group?(max200), cursor?(max2000), limit?: number (max200)}`, `.strict()`. **`limit`'in MUTLAK üst sınırı 200'dür** — bu ADR'nin Karar (e)'sinde ele alınan gerçek bir doğruluk sınırı (bir sorgu 200'den fazla satırla eşleşiyorsa, `objects.service.ts:484`'ün `query()`'i `nextCursor` döner ama TEK bir çağrı asla 200'den fazla satır getirmez — sayfalar arası birleştirme YOK).
2. **`ObjectsService.query`** (`apps/server/src/objects/objects.service.ts:484`) — `POST /objects/query`'nin arkasında, `AIUsageService`'e HİÇ dokunmuyor, sıfır kota/bütçe kapısı. `QueryResult = {objects, nextCursor?} | {groups: [...]}` (satır 141-143) — `group` VARSA `nextCursor` bile YOK (sayfalama tamamen kapalı).
3. **`computeAggregate(fn: AggregateFn, values: unknown[]): number | null`** (`packages/core-objects/src/fields/formula/field-aggregations.ts:21`, `AggregateFn = 'sum'|'avg'|'min'|'max'|'count'|'countUnique'|'countEmpty'`, satır 11) — SAF, sıfır I/O, `packages/core-objects/src/index.ts:23`'ün `export * from './fields/formula/field-aggregations.js'` satırıyla PAKETİN KENDİ PUBLIC API'sinden zaten dışa açık (yeni bir iç-modül erişimi GEREKMİYOR). Bugüne kadar yalnızca rollup formül alanlarına (bir nesnenin KENDİ ilişkili değerlerine) karşı çağrılıyor — bir `QuerySpec` sorgusunun DÖNEN satırlarına karşı HİÇ çağrılmamış.
4. **`FieldType` union'ı** (`packages/core-objects/src/fields/field-type-registry.ts:13-27`) — TAM OLARAK 14 tip, **`number` DAHİL** (`buildValueSchema`'nın `number` dalı, satır 242-255, sınır YOKSA çıplak `z.number()` döner). ADR-0042'nin (Bağlam #9) `querySpec` için "hiçbir json tipi yok, `longText` tek seçenek" tespiti DOĞRUYDU ama bu ADR'nin TEK sayısal değeri için AYNI mantık GEÇERSİZ — `number` gerçek, doğru tip.
5. **`artifact` `ObjectType`** (`packages/core-objects/src/object-type-registry.ts:15`, `{titleRequired:true}`) + 5 seed alan (`apps/server/src/workspaces/workspaces.service.ts:199-277`, `seedArtifactFields`): `htmlContent`(`longText`), `themePreset`(`select`: kurumsal/canli/minimal), `generationPrompt`(`longText`), `artifactType`(`select`: presentation/dashboard/page/report), `querySpec`(`longText`, F3-T8 PR2 eklentisi, ADR-0042 Karar b). **Kritik, doğrudan yeniden kullanılabilir emsal (ADR-0042 Karar b, satır 72):** `querySpec` alanı HER `artifact` nesnesinde VAR ama yalnızca `artifactType==='dashboard'` iken ANLAMLI kullanılıyor — "alan her zaman var, kullanımı `artifactType`'a göre koşullu" deseni bu ADR'nin YENİ alanları için BİREBİR TEKRAR kullanılıyor (Karar b).
6. **`ArtifactType`** (`packages/artifacts/src/artifact-type.ts:1`) — `'presentation'|'dashboard'|'page'|'report'`, sıfır çalışma-zamanı davranışı DIŞINDA yalnızca `renderArtifactHtml`'in (`packages/artifacts/src/render-artifact-html.ts:84`) `artifactType==='presentation'` dalında bir CSS farkı (sayfa-sonu) — **`'baseline'` eklenmesi bu switch'i KIRMAZ** (yalnızca bir ternary, exhaustive değil); tek güncellenmesi gereken exhaustive yer `artifact-type.test.ts`'in kendi derleme-zamanı kanaryası (satır 20-35), triviyal.
7. **`WidgetsService`/`WidgetsController`** (`apps/server/src/artifacts/widgets.service.ts`/`widgets.controller.ts`, ADR-0042 Karar a/d/i) — `Pick<AIUsageService,...>`/`Pick<ObjectsService,'query'|'create'|'setFieldValues'>`/`Pick<FieldDefinitionsService,'list'>` DAR yapısal tipleriyle, Nest dekoratörsüz, `artifacts.module.ts`'de bir `useFactory` provider'ıyla kablolanan SAF sınıf — `widgets.service.test.ts`'in Nest-DI'sız/Testcontainers'sız düz-mock test harness'ini MÜMKÜN KILAN kasıtlı tasarım (satır 26-51'in kendi yorumu). **Bu ADR'nin `BaselinesService`'i AYNI dar-Pick+`useFactory` deseni izler** (Karar c) — ama `AIUsageService`/`AIProvider` HİÇ GEREKMEZ (madde 9).
8. **`ArtifactsModule`** (`apps/server/src/artifacts/artifacts.module.ts`) — `ArtifactsController`+`WidgetsController` AYNI modülde, AYNI `@Controller('workspaces/:workspaceId/artifacts/...')` ön-ek ailesinde, çakışmasız alt-yollarla (`POST` kök vs `POST widgets`) paralel sınıflar olarak yaşıyor — `BaselinesController`/`BaselinesService`'in AYNI modüle üçüncü bir kardeş olarak eklenmesi (Karar a) bu deseni GENİŞLETİYOR, YENİ bir modül İCAT ETMİYOR.
9. **AI-gateway'in HİÇ gerekmediği doğrulandı:** ADR-0041 (artifact: AI TÜM içeriği üretir) VE ADR-0042 (widget: AI YALNIZCA `QuerySpec`'i derler, TEK seferlik) her ikisi de bir AI çağrısı içeriyordu — bu ADR'nin baseline yakalaması bunların HİÇBİRİ DEĞİL. Kullanıcı `QuerySpec`'i ZATEN sahip (bir `SavedView`'dan, aşağıda madde 10) — hiçbir doğal-dil→yapı derlemesi GEREKMİYOR, dolayısıyla `BaselinesService`'in `AIUsageService`/`AIProvider`'a HİÇBİR bağımlılığı YOK (Karar c). Bu, epik-zincirinin "en ucuz seçeneği seç" düzenliliğinin EN AŞIRI ifadesi — F3-T7'nin (tam AI) → F3-T8'in (tek-seferlik AI) → bu görevin (SIFIR AI) doğrusal olarak azalan AI-bağımlılığı.
10. **`SavedView`** (`packages/core-objects/src/saved-views/saved-view.ts:13-28`) — `{id, workspaceId, objectType, name, querySpec: Omit<QuerySpec,'cursor'|'limit'>, ownerId, lifecycle,...}`, `GET /workspaces/:workspaceId/saved-views?objectType=...` üzerinden `useSavedViewsQuery(workspaceId, objectType)` (`apps/web/src/hooks/useSavedViewsQuery.ts:15-23`) ile ZATEN tüketiliyor. **`SavedView.querySpec` `group` alanını HARİÇ TUTMUYOR** (yalnızca `cursor`/`limit` hariç) — bir SavedView GRUPLANMIŞ olabilir, bu ADR'nin Karar (d)'sinin reddetmesi GEREKEN bir girdi.
11. **Nokta-zamanlı (point-in-time) event-store okuması YOK.** `apps/server/src/event-store/event-store.service.ts`'in `readStream`/`readByWorkspace`/`readAllFrom` metotlarının HİÇBİRİ bir üst sınır ("T zamanına kadar") desteklemiyor — yalnızca alt sınır (X'ten itibaren). `replayObject`/`replayFieldValues` (`packages/core-objects/src/replay.ts`) SAF fold'lar, çağıran ÖNCEDEN dilimlenmiş bir olay dizisi verirse "N. olaya kadar" replay YAPABİLİRLER ama hiçbir store metodu bugün bu dilimi SAĞLAMIYOR. **Sonuç: geriye-dönük baseline (geçmiş bir T anı için sonradan bir baseline yaratmak) v0'da desteklenmiyor** — baseline'lar yalnızca PROSPEKTİF (yakalama anında) oluşturulabilir.
12. **`document_snapshots`** (`apps/server/src/db/schema/document-snapshots.ts`, ADR-0011 §f) — "T anındaki durumu dondur" için TEK gerçek emsal, `(objectId, version)` anahtarlı, olay-günlüğünü tüketen BAĞIMSIZ bir projeksiyonla dolduruluyor, `objects_view`'ın jsonb'sinin DIŞINDA tutuluyor ("yalnızca doküman açıldığında gerekli, her liste okumasında değil"). Yapısal olarak İLGİLİ (bir "snapshot tablosu" fikri) ama bu ADR'nin baseline'ı bambaşka bir VERİ TÜRÜ (tek bir doküman'ın CRDT ikili verisi DEĞİL, bir sorgunun tek bir sayısal özeti) sakladığından, `document_snapshots`'ın KENDİSİ yeniden kullanılmıyor — yalnızca "yeni bir tablo yerine mevcut `artifact` altyapısını genişlet" tercihinin GENEL doğrulaması.
13. **Gantt Baseline özelliği bugün MEVCUT DEĞİL.** Repo çapında `baseline` için case-insensitive arama, bu ADR'nin kendi hazırlığı DIŞINDA hiçbir Gantt/timeline-özel "baseline" özelliği BULAMADI (yalnızca alakasız "availability baseline" değişken adları). PLAN.md satır 315'ün "Gantt Baselines bunun tek bir görünümü olur" cümlesi böylece bugün MİGRATE EDİLECEK bir özellik değil, gelecekte (Kapsam B'nin Gantt+Baseline görünümü inşa edildiğinde) bu motoru TÜKETECEK bir gelecekteki entegrasyon noktasını tarif ediyor — bu görevin kapsamı DIŞINDA (aşağıda Kapsam Dışı).

**Çağıran ajanın önerdiği 8 maddelik kapsamın doğrulama sonucu:** TÜMÜ kabul edildi, hiçbiri reddedilmedi. Madde 4 (istemci-taraflı, anlık-görüntü değil poll-on-mount) ve madde 7 (yeni HTTP uç-noktası GEREKLİ, önerinin kendi koşullu maddesi doğru öngörmüş) somutlaştırılırken küçük ama gerçek bir düzeltme eklendi: **madde 1'in "her yakalama kendi `artifact` nesnesidir" çerçevesi DOĞRU, ama önerinin kendisi `QuerySpec`'in NEREDEN geldiğini (AI mi, elle mi, mevcut bir `SavedView`'dan mı) belirtmemişti** — bu ADR'nin Karar (d)'si bunu SavedView-kaynaklı olarak sabitliyor (madde 10), önerinin doğrudan varsaymadığı ama zincirin "AI'ı azaltarak en ucuz yolu seç" mantığının doğal sonucu olan bir çıkarım.

## Karar

### (a) Yerleşim — `packages/artifacts`'a saf `computeQueryAggregate`/sapma hesaplayıcı EKLENİR (`@luminaos/core-objects` YENİ bağımlılık), `apps/server/src/artifacts/`'a `BaselinesService`/`BaselinesController` kardeş dosyaları, YENİ paket YOK

- **`packages/artifacts`'a EKLENİR** (saf, I/O'suz): `computeQueryAggregate(rows, aggregateFn, targetFieldKey?): number | null` (Karar e), `computeDeviation({capturedValue, currentValue}): {delta, percentChange, direction}` (Karar f). `packages/artifacts/package.json`'a **YENİ bir `dependencies` girdisi: `@luminaos/core-objects: workspace:*`** (`computeAggregate`/`AggregateFn` için) — bugüne kadar bu paket yalnızca `@luminaos/shared`+`zod`'a bağımlıydı (doğrulandı, `package.json:30-33`). Bu YENİ bir bağımlılık kenarı ama DÖNGÜSEL DEĞİL (`@luminaos/core-objects` `@luminaos/artifacts`'a hiçbir zaman bağımlı değil, yalnızca `@luminaos/shared`+`ulid`+`zod`'a) ve `computeAggregate` PAKETİN KENDİ public `index.ts`'inden (satır 23) ZATEN dışa açık — yeni bir iç-erişim İCAT EDİLMİYOR.
- **`apps/server/src/artifacts/`'a EKLENİR**: `baselines.service.ts` (Karar c), `baselines.controller.ts` (Karar g) — `artifacts.module.ts`'e ÜÇÜNCÜ kardeş controller/service olarak kayıtlı, `ArtifactsController`/`ArtifactsService`/`WidgetsController`/`WidgetsService`'i DEĞİŞTİRMEDEN.
- **`apps/web`'e YENİ kod, YENİ bağımlılık YOK** (`@luminaos/artifacts` ZATEN F3-T8'den beri `apps/web`'in bağımlılığı) — `computeDeviation` istemci tarafında da ÇAĞRILIR (Karar h), `renderArtifactHtml`'in AYNI "saf fonksiyon iki yerde tek kaynaktan tüketilir" deseni.

**Neden `BaselinesService`/`BaselinesController` `WidgetsService`/`WidgetsController`'a birleştirilmiyor:** ADR-0042 Karar (a)'nın AYNI gerekçesi — girdi şekli (`QuerySpec`'in AI'dan DEĞİL doğrudan bir `SavedView`'dan gelmesi, madde 9/10) ve çıktı şekli (bir HTML `artifact` DEĞİL, tek bir sayısal `capturedValue`) yeterince farklı; paylaşılan bir kod yolu ZORLAMAK `WidgetsService`'in test edilmiş F3-T8 davranışını dallandırma riskine sokardı.

**Neden `computeQueryAggregate`/`computeDeviation` `packages/core-objects`'e DEĞİL `packages/artifacts`'a konuluyor:** İki fonksiyon da `{title, fieldValues}` satır şeklini TÜKETİYOR — bu ZATEN `packages/artifacts`'ın `buildQueryResultTableSection`'ının (ADR-0042 Karar h) parametre tipi, `core-objects`'in KENDİ hiçbir tipi DEĞİL. `computeAggregate`'in KENDİSİ genel bir "değer listesini indirge" birincil işlevi (rollup formül alanları, `core-objects`'in gerçek bir iç kavramı) iken, `computeQueryAggregate` onu BİR `QuerySpec` sonucuna karşı SPESİFİK ÇAĞIRMA bağlamıdır — `deriveWidgetColumns`'ın `QuerySpec`'i `packages/shared`'e DEĞİL `packages/artifacts`'a TÜKETTİRMESİYLE (ADR-0042 Karar g) BİREBİR AYNI katmanlama mantığı. `computeDeviation` ise HİÇBİR paket-spesifik veri şekli TÜKETMEZ (`{capturedValue, currentValue}: {number,number}` → `{delta,percentChange,direction}`) — teorik olarak `packages/shared`'e de konabilirdi, ama bu ADR onu `computeQueryAggregate`'in HEMEN yanına, aynı "baseline hesaplama araç seti" dosyasına/modülüne koyuyor (tek bir tüketim noktası, `BaselinesService` VE `BaselineViewer.tsx`, ikisi de zaten `@luminaos/artifacts`'ı import ediyor).

### (b) `artifact` nesne modeli genişlemesi — ÜÇ yeni alan + `querySpec`'in yeniden kullanımı + `artifactType`'a 5. değer, migration YOK

```ts
// apps/server/src/workspaces/workspaces.service.ts (diff, seedArtifactFields'a EKLENİR)

// 1. artifactType'ın MEVCUT select seçenekleri listesine 5. değer eklenir:
{
  key: 'artifactType',
  label: 'Artifact Type',
  fieldType: 'select',
  config: {
    options: [
      { value: 'presentation', label: 'Sunum' },
      { value: 'dashboard', label: 'Dashboard' },
      { value: 'page', label: 'Sayfa' },
      { value: 'report', label: 'Rapor' },
      { value: 'baseline', label: 'Taban Çizgisi' }, // YENİ (Karar b)
    ],
  },
  permissions: SEEDED_FIELD_PERMISSIONS,
},

// querySpec (ZATEN VAR, F3-T8'den) -- HİÇBİR DEĞİŞİKLİK, aynen yeniden kullanılır.

// 2. YENİ: capturedValue -- gerçek `number` FieldType, JSON-stringify YOK.
await this.defineSeedField(workspaceId, {
  key: 'capturedValue',
  label: 'Captured Value',
  fieldType: 'number',
  config: {},
  permissions: SEEDED_FIELD_PERMISSIONS,
}, ARTIFACT_OBJECT_TYPE);

// 3. YENİ: aggregateFn -- computeAggregate'in KENDİ 7-değerli union'ı, select.
await this.defineSeedField(workspaceId, {
  key: 'aggregateFn',
  label: 'Aggregate Function',
  fieldType: 'select',
  config: {
    options: [
      { value: 'sum', label: 'Toplam' },
      { value: 'avg', label: 'Ortalama' },
      { value: 'min', label: 'Minimum' },
      { value: 'max', label: 'Maksimum' },
      { value: 'count', label: 'Sayım' },
      { value: 'countUnique', label: 'Benzersiz Sayım' },
      { value: 'countEmpty', label: 'Boş Sayım' },
    ],
  },
  permissions: SEEDED_FIELD_PERMISSIONS,
}, ARTIFACT_OBJECT_TYPE);

// 4. YENİ: targetFieldKey -- hangi alanın değerleri indirgeniyor (sum/avg/min/max
//    için ZORUNLU, count için isteğe bağlı -- Karar e), sabit bir enum DEĞİL
//    (hedef objectType'a göre değişir), düz metin.
await this.defineSeedField(workspaceId, {
  key: 'targetFieldKey',
  label: 'Target Field Key',
  fieldType: 'text',
  config: {},
  permissions: SEEDED_FIELD_PERMISSIONS,
}, ARTIFACT_OBJECT_TYPE);
```

Madde 4'ün (Bağlam) doğruladığı gibi `number` GERÇEK bir `FieldType`'tır — `capturedValue` bu yüzden `htmlContent`/`querySpec`'in `longText`-JSON-stringify desenini TEKRARLAMAZ, doğrudan `z.number()` olarak saklanır/doğrulanır (JSON round-trip riski YOK, `number` PostgreSQL jsonb'de zaten doğal olarak numeric). `htmlContent`/`themePreset`/`generationPrompt` baseline nesneleri için **HİÇ YAZILMAZ** (aşağıda Karar b'nin devamı, Alternatifler'de gerekçeli) — bu, `querySpec`'in ZATEN kurduğu "alan her `artifact`'ta var ama yalnızca ilgili `artifactType` için doldurulur" deseninin TERSİ değil, UÇ noktası: bazı alanlar bazı `artifactType`'lar için HİÇ doldurulmaz, HİÇBİR ihlal değil (fields optional, `field-type-registry.ts`'de hiçbir `required` bayrağı YOK, doğrulandı).

**`htmlContent`/`generationPrompt`/`themePreset` baseline'lar için neden YAZILMAZ (kasıtlı boşluk):** Bir baseline'ın "içeriği" AI-üretimi bir metin/tema DEĞİL, salt bir sayı + onu üreten sorgu tanımı. `BaselineViewer.tsx` (Karar h) `ArtifactViewer`'ın iframe+statik-HTML modelini KULLANMAZ — doğrudan React ile üç sayı (yakalanan/güncel/fark) render eder. Yakalama anında sahte bir "önizleme HTML'i" üretmek (`renderArtifactHtml`'i sahte bir `paragraph` section'la çağırarak) hiçbir gerçek tüketici olmayan ölü bir alan yazardı — üstelik YANILTICI olurdu: `LiveWidgetViewer`'ın statik `htmlContent`'i "canlı sorgu başarısız olursa GÖSTERİLECEK gerçek bir fallback" iken, bir baseline'ın dondurulmuş bir HTML'i "hâlâ güncel" izlenimi verirdi — oysa TÜM NOKTASI güncel değeri HER GÖRÜNTÜLEMEDE yeniden hesaplamak (Karar h). Bu yüzden boş bırakmak, sahte bir statik snapshot üretmekten DAHA doğru.

**Yazma-anı boyut sınırı gerekmiyor:** `capturedValue` bir `number` (sınırsız ama JS `number` aralığında doğal olarak sınırlı), `aggregateFn` kapalı 7-değerli enum, `targetFieldKey` bir gerçek `FieldDefinition.key`'e (`ObjectsService.query`'nin KENDİSİ tarafından, Karar e/g'de detaylandırıldığı gibi doğrulanan) referans — ADR-0042 Karar (b)'nin `querySpec` için gerektirdiği `MAX_SERIALIZED_QUERY_SPEC_LENGTH` türü bir savunma BURADA gerekmiyor (hiçbir alan yapısal olarak sınırsız DEĞİL).

### (c) `BaselinesService` — SIFIR AI bağımlılığı, dar-Pick+`useFactory` deseni

```ts
// apps/server/src/artifacts/baselines.service.ts
import { computeQueryAggregate } from '@luminaos/artifacts';
import type { AggregateFn, ObjectType, Role } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';
import type { Actor, QuerySpec } from '@luminaos/shared';

import type { ObjectWithFieldValues, ObjectsService } from '../objects/objects.service.js';

export interface CaptureBaselineServiceInput {
  title: string;
  querySpec: QuerySpec;
  aggregateFn: AggregateFn;
  targetFieldKey?: string;
}

/**
 * `WidgetsObjectsService`'in AYNI dar-Pick deseni (ADR-0042 Karar a,
 * `widgets.service.ts`'in kendi yorumu) -- `env.js`'in eager DATABASE_URL
 * doğrulamasını asla tetiklemeyen, Nest-DI'sız/Testcontainers'sız düz-mock
 * unit test'i mümkün kılan yapısal tip.
 */
export type BaselineObjectsService = Pick<ObjectsService, 'query' | 'create' | 'setFieldValues'>;

export class BaselinesService {
  constructor(private readonly objectsService: BaselineObjectsService) {}

  async capture(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    input: CaptureBaselineServiceInput,
  ): Promise<ObjectWithFieldValues> {
    // v0: flat sorgular ONLY -- computeQueryAggregate tek bir homojen
    // satır dizisi bekler, gruplanmış bir QueryResult'ın anlamlı bir
    // "tek skaler" indirgemesi YOK (Karar d).
    if (input.querySpec.group !== undefined) {
      throw new ValidationError('Baselines do not support grouped queries.');
    }

    const queryResult = await this.objectsService.query(workspaceId, callerRole, input.querySpec);

    if (!('objects' in queryResult)) {
      throw new ValidationError('Unexpected grouped query result for a baseline (unsupported).');
    }

    // computeQueryAggregate KENDİSİ targetFieldKey'in sum/avg/min/max/
    // countUnique/countEmpty için zorunlu olduğunu doğrular (Karar e) --
    // burada TEKRAR doğrulanmıyor, tek doğruluk kaynağı o fonksiyon.
    const capturedValue = computeQueryAggregate(
      queryResult.objects,
      input.aggregateFn,
      input.targetFieldKey,
    );

    const created = await this.objectsService.create(
      workspaceId,
      actor,
      { objectType: 'artifact' as ObjectType, title: input.title },
      callerRole,
    );

    // 'owner'-bypass -- ArtifactsService/WidgetsService'in AYNI deseni
    // (ADR-0041/ADR-0042): bu 5 alan yalnızca bu sistem akışınca yazılır,
    // hiçbir zaman doğrudan elle düzenleme değil.
    const fieldValues: { fieldKey: string; value: unknown }[] = [
      { fieldKey: 'artifactType', value: 'baseline' },
      { fieldKey: 'querySpec', value: JSON.stringify(input.querySpec) },
      { fieldKey: 'aggregateFn', value: input.aggregateFn },
      { fieldKey: 'capturedValue', value: capturedValue },
    ];

    if (input.targetFieldKey !== undefined) {
      fieldValues.push({ fieldKey: 'targetFieldKey', value: input.targetFieldKey });
    }

    return this.objectsService.setFieldValues(workspaceId, created.id, actor, 'owner', fieldValues);
  }
}
```

`ObjectsService.query`'nin KENDİSİ zaten `querySpec.filters`/`sort`/`group`'ta referans verilen HER alan anahtarını `isKnownObjectType`+`canViewField` ile doğruluyor (404 fail-closed, ADR-0042 Bağlam #2) — `compileWidgetQuery`'nin AI-hallüsinasyonuna karşı gerektirdiği `validateCompiledQuerySpec` allowlist katmanı BURADA GEREKMİYOR (madde 9): girdi AI'dan DEĞİL, kullanıcının ZATEN sahip olduğu bir `SavedView`'dan (Karar d) geliyor, dolayısıyla "hallüsine edilmiş alan" riski YOK — yalnızca `ObjectsService.query`'nin KENDİ doğal doğrulaması yeterli.

### (d) `QuerySpec`'in kaynağı — MEVCUT bir `SavedView`'dan türetilir, HİÇBİR yeni sorgu-oluşturucu UI İCAT EDİLMEZ

**En yük taşıyan karar, çağıran ajanın önerisinin belirtmediği ama zincirin mantığından çıkarılan nokta.** `BaselineCreationForm` (Karar h) kullanıcıya sıfırdan bir `QuerySpec` YAZDIRMAZ (ne AI-destekli `WidgetGenerationForm`'un prompt kutusu, ne ham bir JSON textarea) — bunun yerine `useSavedViewsQuery(workspaceId, objectType)`'ı (ZATEN var, `apps/web/src/hooks/useSavedViewsQuery.ts:15`) yeniden kullanarak workspace'in MEVCUT `SavedView`'larından birini seçtirir, `savedView.querySpec`+`savedView.objectType`'ı birleştirip TAM bir `QuerySpec` üretir (`{...savedView.querySpec, objectType: savedView.objectType}`), bunu `POST .../artifacts/baselines`'a gönderir.

**HTTP kontratı `SavedView`'a HİÇ referans VERMEZ** (`savedViewId` YOK) — yalnızca DÜZ bir `querySpec: QuerySpec` gövde alanı. Bu KASITLI bir ayrıştırma: bir baseline yakalandıktan SONRA kaynak `SavedView` silinir/düzenlenirse, ZATEN yakalanmış baseline'ın kendi kopyalanmış `querySpec`'i (Karar b'nin `querySpec` alanı) ETKİLENMEMELİDİR — bir `savedViewId` FK'sı bu izolasyonu KIRARDI (baseline'ın "kaynağı" sonradan değişen bir referans olurdu, `document_snapshots`'ın (Bağlam #12) "dondurulmuş kopya, canlı referans değil" ilkesiyle ÇELİŞirdi). Frontend `SavedView`'ı yalnızca BİR SEFERLİK bir `querySpec` ÖNERİSİ kaynağı olarak kullanır, backend'in KENDİSİ `SavedView`'ın varlığından HABERSİZDİR.

**v0 kısıtı (Kapsam Dışı'na da işlenir):** Kullanıcı henüz bir `SavedView` olarak kaydedilmemiş, ad-hoc bir sorguyu baseline'lamak isterse, v0'da ÖNCE o sorguyu bir `SavedView` olarak kaydetmesi gerekir (mevcut SavedView-oluşturma UI'ı, sıfır yeni kod) — baseline formunun kendisi HİÇBİR ham/serbest sorgu girişi SUNMAZ. Bu düşük riskli bir kısıt (bir SavedView oluşturmanın maliyeti sıfıra yakın, mevcut akış) ama bir ÜRÜN kararı niteliği taşıyabilir — Açık Sorular'da işaretlenmiştir.

### (e) `computeQueryAggregate` — saf, `QuerySpec` sonuç satırlarına karşı `computeAggregate`'i çağıran YENİ ince katman

```ts
// packages/artifacts/src/compute-query-aggregate.ts
import { computeAggregate } from '@luminaos/core-objects';
import type { AggregateFn } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';

/** `count` DIŞINDAKİ her AggregateFn -- bir hedef alanın DEĞERLERİNİ indirger,
 * dolayısıyla `targetFieldKey` ZORUNLUDUR. `count` TEK istisna: `targetFieldKey`
 * verilmezse "kaç satır eşleşti" (rows.length) döner -- kullanıcı sezgisiyle
 * EN ÇOK ÖRTÜŞEN v0 varsayılanı (çağıran ajanın önerisinin "en basit sayım
 * durumu" çerçevesini somutlaştırır). `targetFieldKey` verilirse `count` yine
 * de `computeAggregate`'e delege eder (o alanın BOŞ-OLMAYAN değer sayısı --
 * `rows.length`'ten FARKLI, kasıtlı bir ayrım).
 */
const FIELD_REQUIRED_AGGREGATE_FNS: ReadonlySet<AggregateFn> = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'countUnique',
  'countEmpty',
]);

export function computeQueryAggregate(
  rows: { title: string; fieldValues: Record<string, unknown> }[],
  aggregateFn: AggregateFn,
  targetFieldKey?: string,
): number | null {
  if (aggregateFn === 'count' && targetFieldKey === undefined) {
    return rows.length;
  }

  if (targetFieldKey === undefined) {
    throw new ValidationError('targetFieldKey is required for this aggregateFn', { aggregateFn });
  }

  const values = rows.map((row) =>
    targetFieldKey === 'title' ? row.title : row.fieldValues[targetFieldKey],
  );

  return computeAggregate(aggregateFn, values);
}
```

`FIELD_REQUIRED_AGGREGATE_FNS` KOD İÇİNDE dokümantasyon amaçlı tutulur ama fiili dallanma yalnızca `aggregateFn==='count' && targetFieldKey===undefined` kısayoluna dayanır (basitlik) — `sum`/`avg`/`min`/`max`/`countUnique`/`countEmpty` için `targetFieldKey===undefined` durumu `values`'in `row.fieldValues[undefined]` gibi anlamsız bir okumaya DÜŞMEDEN önce `ValidationError`'a çarpar (`targetFieldKey === 'title' ? ... : row.fieldValues[targetFieldKey]` satırı `targetFieldKey: string` tipini gerektirir, `undefined` durumu YUKARIDA zaten elenmiş olur — TypeScript'in kendisi bunu bir tip-daralması olarak KANITLAR, ek bir runtime kontrolü GEREKMEZ ötesinde).

**`title`'a referans verme deseni** `deriveWidgetColumns`/`buildQueryResultTableSection`'ın (ADR-0042 Karar g/h) AYNI özel-durumu — nesnenin KENDİ `.title`'ı `fieldValues` haritası İÇİNDE değil, ayrı bir üst-düzey alan.

**Sayfalama sınırı (Bağlam madde 1'in doğrudan sonucu, YENİ bir kısıt olarak burada açıkça belgelenir):** `computeQueryAggregate` yalnızca `ObjectsService.query`'nin TEK bir çağrısının döndürdüğü satırları görür — `querySpec.limit` (şema-hard-cap: 200) aşan bir eşleşme kümesi varsa, `sum`/`avg`/`count` vb. yalnızca İLK sayfa üzerinden hesaplanır, TÜM eşleşen kümeye karşı DEĞİL. Bu YENİ bir hata DEĞİL (widget'ın kendi `MAX_WIDGET_TABLE_ROWS=25` görüntüleme-kırpması ile AYNI kategori bir v0 sınırı) ama widget'tan FARKLI olarak burada kırpma yalnızca GÖRÜNTÜLEMEYİ değil HESAPLANAN SAYININ KENDİSİNİ etkiler — bu yüzden Karar (h)'nin `BaselineViewer`'ı, `queryResult.nextCursor !== undefined` olduğunda ("daha fazla eşleşen satır var, agregat TAMAMINI YANSITMIYOR") görünür bir uyarı gösterir. Hem yakalama (Karar c) hem karşılaştırma (Karar h) AYNI `querySpec`'i (dolayısıyla AYNI `limit`'i) kullandığından, sapma HESABININ KENDİSİ (Karar f) yine de TUTARLI kalır (iki taraf da AYNI kurala göre kırpılmış) — yalnızca MUTLAK değerler potansiyel olarak "gerçek toplam"dan küçük olabilir, sapma YÜZDESİ göreceli olarak hâlâ anlamlıdır.

### (f) `computeDeviation` — saf sapma hesaplayıcı, sıfır I/O

```ts
// packages/artifacts/src/compute-deviation.ts
export type DeviationDirection = 'up' | 'down' | 'unchanged';

export interface DeviationResult {
  delta: number;
  percentChange: number | null; // capturedValue === 0 ise null (sıfıra bölme YOK)
  direction: DeviationDirection;
}

export function computeDeviation(input: {
  capturedValue: number;
  currentValue: number;
}): DeviationResult {
  const delta = input.currentValue - input.capturedValue;
  const percentChange = input.capturedValue === 0 ? null : (delta / input.capturedValue) * 100;
  const direction: DeviationDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';

  return { delta, percentChange, direction };
}
```

`capturedValue===0` durumunda `percentChange` `null` döner (`Infinity`/`NaN` DEĞİL) — çağıran (Karar h'nin `BaselineViewer`'ı) bunu "yüzde hesaplanamaz" olarak AÇIKÇA göstermeli, sessizce `Infinity%` render ETMEMELİ. `computeAggregate`'in `null` dönüş deseni (boş veri kümesi) ile TUTARLI bir "hesaplanamaz durumu `null` ile işaretle, asla `NaN`/`Infinity` sızdırma" disiplini.

### (g) HTTP yüzeyi — YENİ `POST /workspaces/:workspaceId/artifacts/baselines`, karşılaştırma için YENİ uç-nokta YOK

```ts
// apps/server/src/artifacts/dto/capture-baseline.schema.ts
import { querySpecSchema } from '@luminaos/shared';
import { z } from 'zod';

const aggregateFnSchema = z.enum([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'countUnique',
  'countEmpty',
]);

export const captureBaselineSchema = z
  .object({
    title: z.string().min(1).max(200),
    querySpec: querySpecSchema,
    aggregateFn: aggregateFnSchema,
    targetFieldKey: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CaptureBaselineRequestInput = z.infer<typeof captureBaselineSchema>;
```

```ts
// apps/server/src/artifacts/baselines.controller.ts
@Controller('workspaces/:workspaceId/artifacts/baselines')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class BaselinesController {
  constructor(private readonly baselinesService: BaselinesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async capture(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(captureBaselineSchema)) body: CaptureBaselineRequestInput,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);
    const object = await this.baselinesService.capture(workspaceId, actor, callerRole, body);
    return { object };
  }
  // requireActor/requireRole: ArtifactsController/WidgetsController'ınkiyle BİREBİR aynı desen.
}
```

**Karşılaştırma (yakalanan vs güncel) için YENİ bir uç-nokta YOK** (çağıran ajanın önerisinin madde 7'sinin koşullu varsayımı DOĞRULANDI) — Karar (h) MEVCUT `POST /objects/query`'yi doğrudan kullanır, `LiveWidgetViewer`'ın (ADR-0042 Karar e) AYNI deseni. RBAC: `SessionAuthGuard`+`WorkspaceMembershipGuard` DIŞINDA hiçbir ek kapı — ADR-0041 Karar (g)/ADR-0042 Karar (i)'nin AYNI `member+` tabanı, daha katı bir gate İCAT EDİLMİYOR.

### (h) Frontend — `BaselineCreationForm` + `BaselineViewer`, karşılaştırma İSTEMCİ-TARAFLI, MOUNT'TA BİR KEZ (poll YOK)

```ts
// apps/web/src/hooks/useCaptureBaselineMutation.ts -- WidgetGenerationForm'un
// useGenerateWidgetMutation deseninin AYNISI, farklı endpoint/gövde.
```

```tsx
// apps/web/src/views/shared/BaselineViewer.tsx
export function BaselineViewer({ workspaceId, artifactObjectId }: BaselineViewerProps) {
  const objectQuery = useObjectQuery(workspaceId, artifactObjectId);
  const object = objectQuery.data?.object;
  const querySpec = parseQuerySpec(object?.fieldValues.querySpec); // AYNI parse+safeParse deseni, LiveWidgetViewer

  // POLL YOK -- mount'ta BİR KEZ çalışır (react-query'nin varsayılan
  // refetchInterval:false davranışı, LiveWidgetViewer'ın 45s refetchInterval'inin
  // AKSİNE), artı elle bir "Yenile" butonu (queryClient.invalidateQueries).
  const liveQuery = useQuery({
    queryKey: ['baselineComparison', workspaceId, artifactObjectId, querySpec],
    queryFn: () => postObjectsQuery(workspaceId, querySpec as QuerySpec),
    enabled: querySpec !== undefined,
  });

  if (object === undefined) return null;

  const capturedValue = object.fieldValues.capturedValue as number;
  const aggregateFn = object.fieldValues.aggregateFn as AggregateFn;
  const targetFieldKey = object.fieldValues.targetFieldKey as string | undefined;

  const currentValue =
    liveQuery.data !== undefined && 'objects' in liveQuery.data
      ? computeQueryAggregate(liveQuery.data.objects, aggregateFn, targetFieldKey)
      : undefined;

  const deviation =
    currentValue !== null && currentValue !== undefined
      ? computeDeviation({ capturedValue, currentValue })
      : undefined;

  const hasMoreRows =
    liveQuery.data !== undefined &&
    'nextCursor' in liveQuery.data &&
    liveQuery.data.nextCursor !== undefined;

  // ... capturedValue / currentValue / deviation.delta / deviation.percentChange
  // render'ı + hasMoreRows ise bir uyarı banner'ı (Karar e'nin sayfalama notu).
}
```

**Poll-on-mount, 45s `refetchInterval` DEĞİL (çağıran ajanın kendi önerdiği açık seçim noktası, burada mimarın kararı):** `LiveWidgetViewer`'ın kullanım deseni "sürekli açık bir dashboard paneli, taze veri BEKLENİYOR" iken bir baseline karşılaştırması "SABİT bir referans noktasına karşı NOKTA kontrolü" — kullanıcı bir baseline'ı AÇTIĞINDA "şu an ne durumdayız" sorusuna cevap arıyor, sürekli canlı bir sayaç İZLEMİYOR. Otomatik 45s polling burada hem GEREKSİZ sunucu yükü (her açık baseline sekmesi sürekli sorgulanır) hem YANLIŞ UX sinyali (bir sayının "canlı akıyormuş" gibi titreşmesi, oysa kullanıcı NOKTA-karşılaştırma bekliyor) üretirdi. Elle "Yenile" butonu (mevcut `queryClient.invalidateQueries` deseni, YENİ bir kütüphane GEREKMEZ) kullanıcıya kontrolü bırakır.

## Somut Şekiller

```ts
// packages/artifacts/src/artifact-type.ts (diff)
export type ArtifactType = 'presentation' | 'dashboard' | 'page' | 'report' | 'baseline';
```

```ts
// packages/artifacts/package.json (diff)
"dependencies": {
  "@luminaos/core-objects": "workspace:*",  // YENİ (Karar a)
  "@luminaos/shared": "workspace:*",
  "zod": "^4.4.3"
}
```

(Karar b/c/e/f/g/h'nin tam kod sketch'leri yukarıda Karar bölümünde — burada tekrarlanmıyor.)

Migration: **YOK gerekli** — `field_values`/`objects_view` şeması hiçbir DDL değişikliği gerektirmez (ADR-0041/0042 Karar b'nin BİREBİR aynı gerekçesi), yalnızca `workspaces.service.ts`'e 3 yeni seed satırı + `artifactType`'ın mevcut seed satırının `options` listesine 1 yeni giriş.

## Alternatifler ve Reddedilme Gerekçeleri

- **YENİ bir `baseline`/`plan` `ObjectType` yaratmak.** Reddedildi — `artifact`'ın TÜM RBAC/seed/render(?)/viewer altyapısını YENİDEN kurmak orantısız; `artifactType='baseline'` ZATEN F3-T7/T8'in kurduğu ayrımı BİREBİR taşıyor (Karar b).
- **`capturedValue`'yu `querySpec` gibi `longText`-JSON-stringify ile saklamak.** Reddedildi (Karar b) — `number` GERÇEK bir `FieldType`, ADR-0042'nin `querySpec` için `longText` seçme gerekçesi ("14 tipin hiçbirinde json yok") BURADA GEÇERSİZ (tek bir sayı, tam olarak `number`'ın kapsadığı şey).
- **Yakalama anında `htmlContent`'e statik bir metin/tablo önizlemesi yazmak (widget'ın "ilk anlık görüntü" desenini taklit ederek).** Reddedildi (Karar b) — hiçbir gerçek tüketici yok (`BaselineViewer` `ArtifactViewer`/iframe KULLANMIYOR), ÜSTELİK potansiyel olarak YANILTICI (dondurulmuş bir HTML, kullanıcıya "hâlâ güncel" izlenimi verebilir, oysa TÜM NOKTASI güncel değerin HER görüntülemede yeniden hesaplanması).
- **`QuerySpec`'i sıfırdan yazdıran bir görsel sorgu-oluşturucu veya AI-destekli NL→QuerySpec derlemesi (widget'ın deseni) inşa etmek.** Reddedildi (Karar d) — kullanıcı ZATEN bir `SavedView` aracılığıyla bir `QuerySpec`'e sahip olabilir; sıfırdan bir UI/AI-orkestratör inşa etmek, epik-zincirinin "en ucuz, en çok yeniden kullanılan seçeneği seç" düzenliliğine aykırı orantısız mühendislik olurdu.
- **Baseline'ı bir `SavedView`'a `savedViewId` FK'siyle referans vererek saklamak (kopyalamak yerine).** Reddedildi (Karar d) — bir baseline'ın "dondurulmuş" doğasını KIRARDI: kaynak `SavedView` sonradan silinir/düzenlenirse, ZATEN yakalanmış bir baseline'ın anlamı GERİYE DÖNÜK değişirdi (`document_snapshots`'ın "dondurulmuş kopya" ilkesiyle ÇELİŞirdi).
- **Karşılaştırmayı sunucu-taraflı, YENİ bir `POST .../baselines/:id/compare` uç-noktasıyla hesaplamak.** Reddedildi (Karar g/h) — mevcut `POST /objects/query` ZATEN sıfır-maliyetli, sınırsız-tekrar-çalıştırılabilir (ADR-0042 Bağlam #2); `computeQueryAggregate`/`computeDeviation`'ın SAF, sıfır-I/O doğası istemci tarafında ÇALIŞTIRILABİLİR olmasını (Karar a) GEREKSİZ kılan hiçbir ölçek/güvenlik endişesi YOK (sorgu sonucu ZATEN role-filtrelenmiş geliyor, agregasyon o VERİ üzerinde saf aritmetik).
- **Karşılaştırmayı `LiveWidgetViewer`'ın 45s `refetchInterval` polling desenini KOPYALAYARAK sürekli canlı tutmak.** Reddedildi (Karar h) — bir baseline karşılaştırması NOKTA-kontrolü semantiği taşır, sürekli-canlı bir dashboard DEĞİL; gereksiz sunucu yükü + yanlış UX sinyali.
- **`computeQueryAggregate`'in TÜM eşleşen satırları (sayfalama sınırını AŞARAK) toplaması için `nextCursor`'ı takip eden bir döngü inşa etmek.** Reddedildi (Karar e) — v0 minimalizmiyle TUTARLI bir sınır kabul edilir (widget'ın KENDİ `MAX_WIDGET_TABLE_ROWS` kırpmasıyla AYNI kategori); `hasMoreRows` uyarısı (Karar h) kullanıcıyı BİLGİLENDİRİR, sessizce YANLIŞ bir sayı ÜRETMEZ.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** PLAN.md'nin KENDİ mimari cümlesi ("event sourcing → baseline/sapma bedavaya yakın gelir") bu ADR'de İKİ katmanda gerçekleşir: (1) bir baseline'ın YAKALANMASI TEK bir `FieldValueChanged` olay dizisi yazar (Karar c, `setFieldValues` çağrısı) — geriye dönük DEĞİŞTİRİLEMEZ, tıpkı her domain olayı gibi; (2) "güncel gerçeklik" HİÇBİR YENİ olay yazmadan, `objects_view` projeksiyonunun (ZATEN olay-günlüğünden türetilmiş) BİR OKUMASI üzerinden hesaplanır (Karar h) — `LiveWidgetViewer`'ın "her yenileme SIFIR yeni olay yazar" ilkesiyle (ADR-0042 Mimari Değişmezler) BİREBİR aynı disiplin.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Baseline yakalama kullanıcının DOĞRUDAN, senkron isteğinin sonucu (`ArtifactsService`/`WidgetsService`'in AYNI kategorisi) — `ProposedAction`/`decide()`/ledger akışının KAPSAMI DIŞINDA, onay/otonomi-kademesi/geri-alma GEREKMİYOR. F3-T11 (AI-destekli kök-neden analiz kartı, AYRI gelecekteki görev) bu sözleşmeye TABİ olacak İLK Plan-Gerçek bileşeni olabilir — bu görev DEĞİL.
- **Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz.** Baseline gerçek bir `artifact` Lumina Object olduğundan, MEVCUT genel nesne-export yeteneği onu OTOMATİK kapsar — bu ADR hiçbir export kısıtlaması İCAT ETMİYOR.
- **Hassas veri sınıfları buluta ham gönderilmez (ADR-0029).** Bu ADR'nin en güçlü güvenlik özelliği: **SIFIR AI çağrısı** (madde 9) — hiçbir baseline verisi (ne `querySpec`, ne yakalanan/güncel değerler) HİÇBİR ZAMAN bir AI sağlayıcısına gönderilmez. F3-T11 (kök-neden analizi) bu güvenceyi DEĞİŞTİRECEK ilk görev olacaktır — kendi ADR'sinde ADR-0029'un dört-kademeli sınıflandırmasına TABİ olmalıdır, bu ADR'nin kapsamı DIŞINDA.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin Kapsam N vaadi (`baseline_snapshot(query_id, t)` + fark motoru) hiçbir yeni depolama alt sistemi, hiçbir yeni AI-gateway bağımlılığı, hiçbir yeni HTTP-polling altyapısı İCAT EDİLMEDEN, ADR-0041/0042'nin TÜM RBAC/seed/`artifact`-altyapısının ÜZERİNE kurulur; `computeAggregate`'in mevcut, test edilmiş SAF fonksiyonu YENİDEN YAZILMADAN yeni bir bağlamda (bir sorgunun TÜM sonuç kümesi) yeniden kullanılır.

**Neyi erteliyoruz/kabul ediyoruz:**

- **Geriye-dönük baseline oluşturma YOK** (Bağlam madde 11) — nokta-zamanlı event-store okuması bugün desteklenmiyor; bu bilinen, YENİ OLMAYAN bir sınır, bu görevde ÇÖZÜLMÜYOR.
- **Proaktif/zamanlanmış sapma uyarısı YOK** — F3-T9'un insan kararı 1'inin "sayfa açılışında otomatik AI analizi" reddiyle TUTARLI; F3-T11 (AYRI görev) AI-destekli kök-neden kartını sahiplenir.
- **En fazla `querySpec.limit` (şema-hard-cap 200) satır üzerinden agregasyon** (Karar e) — sayfalar-arası toplam agregasyon v0'da desteklenmiyor; `BaselineViewer`'ın `hasMoreRows` uyarısı bunu KULLANICIYA görünür kılar, sessizce YANLIŞ bir sayı ÜRETMEZ.
- **Ad-hoc (henüz bir `SavedView` olarak kaydedilmemiş) bir sorguyu doğrudan baseline'lamak YOK** (Karar d) — kullanıcı ÖNCE bir `SavedView` oluşturmalı; düşük maliyetli ama gerçek bir ek adım, Açık Sorular'da işaretli.
- **Tek-metrik/tek-sorgu baseline'lar** (v0: bir `QuerySpec` + bir `AggregateFn`, ÇOKLU metrik/kompozit baseline'lar YOK) — Kapsam Dışı.
- **Gantt Baselines'ın bu motoru tüketecek şekilde YENİDEN kablolanması bu görevde YAPILMIYOR** (Bağlam madde 13) — özellik bugün MEVCUT DEĞİL, gelecekteki bir görev/karar.

## İnsan kararları

Bu ADR'deki kararların neredeyse tamamı mimarın kendi çıkarımı — çağıran ajanın kendi 8 maddelik kapsam önerisi bir ÖNERİYDİ, dikte DEĞİLDİ, ve bu ADR'nin Bağlam/Karar bölümleri onu doğrulayıp (küçük düzeltmelerle, Karar d) mimarın KENDİ çıkarımı olarak resmileştirdi. TEK istisna, mimarın kendi çıkarımını insana AÇIKÇA sorup onay aldığı nokta:

1. **Karar (d)'nin "yalnızca mevcut bir `SavedView`'dan baseline yakala, ham/ad-hoc sorgu girişi YOK" kısıtı — insan tarafından onaylandı (Plan Mode oturumunda, ikinci bir AskUserQuestion turunda).** Mimarın gerekçesi (mevcut SavedView-oluşturma akışının maliyeti sıfıra yakın, yeni bir sorgu-oluşturucu UI inşa etmemek epik-zincirinin minimalizm düzenliliğiyle TUTARLI) insana sunuldu; insan "Yalnızca mevcut SavedView'dan (Recommended)" seçeneğini AYNEN onayladı, "SavedView + ham QuerySpec JSON'u ikinci yol" alternatifini reddetti. Bu ADR'nin PLAN.md'de hiçbir açık çıpası olmadığından (Bağlam'ın kendi tespiti), bu onay özellikle değerliydi — mimarın çıkarımı sağlam olsa da, PLAN.md'den doğrulanamayan bir ÜRÜN kararıydı. Reddedilseydi en ucuz düzeltme, `BaselineCreationForm`'a "SavedView seç" seçeneğinin YANINA bir "ham QuerySpec JSON'u yapıştır" ikinci bir yol eklemek olurdu (backend kontratı zaten DEĞİŞMEZ, yalnızca frontend'e ikinci bir girdi yolu eklenir) — bu onaylanmadığı için v0'da uygulanmayacak.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E4/F3-T10-evrensel-baseline-sapma.md`) yazılır. Bu ADR'nin onayı üzerine PR1'e (`packages/artifacts` genişlemesi: `computeQueryAggregate`, `computeDeviation`, `ArtifactType`'a `'baseline'` eklenmesi, `@luminaos/core-objects` YENİ bağımlılık — SIFIR I/O, tamamen birim-test edilebilir) `test-writer` ile başlanır:

```
docs/adr/ADR-0044-evrensel-baseline-sapma.md'deki Karar (a)-(h)'yi ve
docs/specs/F3-E4/F3-T10-evrensel-baseline-sapma.md'nin Kabul Kriterleri'ni temel alarak, F3-T10
PR1 (packages/artifacts genişlemesi: computeQueryAggregate, computeDeviation, ArtifactType'a
'baseline' eklenmesi -- sıfır I/O, mevcut computeAggregate/renderArtifactHtml'i DEĞİŞTİRMEDEN
yeniden kullanır) için test-writer ile başarısız testleri yaz.
```
