# ADR-0023: İçe/Dışa Aktarım — JSON-LD Şeması, Export Uç Noktası, Genel-Format İçe Aktarma Sihirbazı

**Durum:** Kabul edildi
**Tarih:** 2026-08-18
**İlgili görev:** [F2-T7 — İçe/Dışa Aktarım: Açık Şema (JSON-LD) + ChatGPT/Claude Bellek İçe Aktarma Sihirbazı](../specs/F2-E2/F2-T7-ice-disa-aktarim.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E2: Memory Passport" (F2-T7 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin fıkra **(b)**'si tetikliyor — bu görevin ürettiği JSON-LD şeması, tanım gereği LuminaOS'in dışına açılan ve gelecekteki görevlere (F2-T8'in erişim politikası manifestoları bellek segmentlerini bu şemaya göre tarif edebilir; F2-T12'nin MCP sunucusu bu şemayı dışarı sunabilir) dayatılan bir sözleşim tanımlıyor.

> Bu ADR'nin dört merkezi kararı — (a) içe aktarma kapsamının genel-format ile sınırlanması, (b) JSON-LD export'un `apps/server/src/memory/`'ye özel yeni bir uç nokta olarak kurulması (F1-T18'in `ExportService`'ine eklenmemesi), (c) `@context`'in `schema.org` terimleriyle mümkün olduğunca eşlenmesi, (d) toplu içe aktarmanın client-side döngü olması — spec'in (`F2-T7-ice-disa-aktarim.md`) "Açık Sorular" bölümündeki 1-4 numaralı sorulara insan tarafından plan onayında (`AskUserQuestion`) verilen yanıtlardır; bu ADR onları icat etmiyor, kod-seviyesi bir tasarıma döküyor. Kapsam-daraltma kararı (a), ADR-0016 §(d)'nin BlockNote'un belgelenmemiş şemasını reverse-engineer etmek yerine daha küçük/kanıtlanmış bir yol seçmesiyle AYNI türde bir risk-azaltma mantığını izliyor: ChatGPT/Claude'un gerçek, kararlı, herkese açık dokümante edilmiş bir bellek-export şemasına sahip olduğu bu oturumda doğrulanamadı, dolayısıyla böyle bir şemayı tahmin ederek bir ayrıştırıcı yazmak reddedildi.
>
> Bu ADR'nin kendi sorumluluğu, insan tarafından çoktan kapatılan bu dört yüksek-seviye kararı yeniden tartışmak değil: (1) `MemoryRecordJsonLd` tipinin ve `@context` nesnesinin TAM alan-alan tasarımı; (2) yeni export route'unun zod query-DTO'su; (3) HTTP yanıtının zarf (envelope) şekli; (4) alt-PR ayrıştırması.

## Bağlam

F2-T5'in CRUD API'si (`apps/server/src/memory/memory-records.controller.ts`, ADR-0022) hazır: `GET/POST/PATCH/DELETE /workspaces/:workspaceId/memory`, `POST` yalnızca tek bir `{content: string}` kaydı oluşturuyor — toplu oluşturma yok. `MemoryRecord = {id, workspaceId, userId, content, kaynakOlayId, createdAt, updatedAt, deletedAt}` (`packages/memory/src/memory-record.ts`). F2-T6'nın UI'ı (`apps/web/src/views/shared/MemoryPassportPanel.tsx`) mevcut kayıtları listeler/düzenler/siler/tekli-ekler; bu ADR'nin sihirbazı bu panelin yanına eklenir. F2-T5 PR3 zaten F1-T18'in genel export'una (`apps/server/src/export/`) `memoryRecords: MemoryRecord[]` alanını eklemiş durumda — bu, ADR-0022 Karar (g)'nin kapsamı, JSON-LD'den AYRI kalıyor.

Repoda hiçbir JSON-LD implementasyonu ve hiçbir içe aktarma mekanizması yok — bu görev repodaki ilk JSON-LD yüzeyini ve ilk içe aktarma akışını kuruyor.

Keşif iki bağlayıcı emsali doğruladı:

1. **ADR-0016 §(a) — "rol-gate yalnızca idari mutasyon için, okuma/export için asla."** Bu kural açıkça F1-T18'in ötesine geçen, "Faz 2+'nin export/okuma-şekilli tüm gelecekteki uç noktaları (Context Fabric, Memory Passport export'ları dahil)" için bağlayıcı olarak kayda geçirildi. Bu ADR'nin yeni `GET .../memory/export` route'u bu kuralı MİRAS ALIYOR, yeniden tartışmıyor: `SessionAuthGuard`+`WorkspaceMembershipGuard`, ek rol kontrolü yok.
2. **`memory-records.controller.ts`'in mevcut route/DTO/envelope kalıbı.** Dört route da `SessionAuthGuard`+`WorkspaceMembershipGuard`, kimlik her zaman `req.user.id`'den (ASLA body/param'dan); DTO'lar `apps/server/src/memory/dto/*.schema.ts`'te zod ile tanımlı ve `ZodValidationPipe` ile bağlanıyor (`.strict()` DEĞİL — self-service by construction, fazladan alan sessizce elenir); yanıtlar zarflı: `{record: MemoryRecord}` (create/edit), `{records: MemoryRecord[]}` (list). Controller'da şu an `GET /:id` route'u YOK — yeni `GET /export` sub-route'u hiçbir `:id`-parametreli route ile çakışmıyor.

Çözülmesi gereken merkezi sorular (spec'in Açık Soru 1-5'i insan onayıyla ÇOKTAN kapatıldı; bu ADR'nin görevi bunları kod-seviyesi bir tasarıma dökmek): (1) `@context`/`@type`/`@id`'nin tam şekli; (2) export query-DTO'sunun tam zod şeması; (3) yanıt zarfı; (4) alt-PR ayrıştırması.

## Karar

### (a) İçe aktarma kapsamı — yalnızca genel format, ChatGPT/Claude'a özel ayrıştırıcı YOK (insan onaylı, spec Açık Soru 3)

v1, `parseImportInput` (`apps/web`) adlı saf bir fonksiyonla üç girdi şeklini SIRAYLA tanır:

1. Elemanları LİTERAL `schema:text` anahtarı taşıyan bir JSON dizisi — tam-genişletilmiş (fully-expanded) bir JSON-LD üreticisi için ileriye-dönük bir kanca. **Uygulama notu (PR2'de doğrulandı):** `toMemoryRecordJsonLd`'nin (Karar c) gerçek çıktısı bu anahtarı LİTERAL OLARAK taşımaz — `@context` yalnızca semantik `content` teriminin `schema:text` IRI'sine eşlendiğini belirtir, emitted nesnenin kendi property adı hâlâ `content`'tir. Dolayısıyla bugünkü gerçek LuminaOS export'u bu şekli DEĞİL, şekil (2)'yi eşler — round-trip yine de kayıpsız çalışır, yalnızca hangi şeklin eşleştiği ADR'nin ilk yazımındaki varsayımdan farklı. Şekil (1) bu yüzden bugün hiçbir gerçek üretici tarafından tetiklenmeyen, zararsız bir ek kontrol olarak kalıyor.
2. Elemanları `content` alanı taşıyan bir JSON dizisi (`{content: string}[]`) — hem basit, format-agnostik bir "dış" JSON şekli HEM DE (yukarıdaki not gereği) LuminaOS'in kendi JSON-LD export'unun gerçek round-trip yolu.
3. Yukarıdakilerin hiçbiri değilse: düz metin, satır satır bölünür, boş satırlar elenir.

ChatGPT/Claude'a özel bir dosya-formatı ayrıştırıcısı YAZILMAZ — bu iki ürünün export şeması bu oturumda doğrulanamadı (bkz. üstteki blockquote). UI kopyası kullanıcıyı "ChatGPT/Claude'dan kopyaladığın metni buraya yapıştır" şeklinde yönlendirebilir; bu yönlendirme zaten şekil (3)'ün (serbest metin) doğal bir kullanım örneği, ayrı bir kod yolu gerektirmiyor.

### (b) JSON-LD export uç noktası — `apps/server/src/memory/`'ye özel yeni route, F1-T18'in `ExportService`'i GENİŞLETİLMİYOR (insan onaylı, spec Açık Soru 2)

`GET /workspaces/:workspaceId/memory/export?format=json-ld` — mevcut `MemoryRecordsController`'a (`apps/server/src/memory/memory-records.controller.ts`) yeni bir `@Get('export')` metodu olarak eklenir.

**Gerekçe:** F1-T18'in `ExportService`'i (`apps/server/src/export/`) genel workspace-çapında bir "her şeyi dışa aktar" akışı (`format=json|markdown|ical`); JSON-LD'nin asıl amacı Memory Passport'un taşınabilirliği (başka bir sisteme veya kullanıcının kendi arşivine) — kavramsal olarak F2-T5'in modülüne ait. `ExportService`'in genel `format` enum'unu bellek-özel bir kavramla ("json-ld" yalnızca Memory Passport'a anlamlı, `task`/`doc` nesnelerine değil) kirletmek yerine, ayrı bir uç nokta iki kavramı temiz tutuyor. RBAC: bu görevin bağlamdaki (1) numaralı emsalinin AYNISI — `SessionAuthGuard`+`WorkspaceMembershipGuard`, rol-gate yok.

### (c) `MemoryRecordJsonLd` tipi ve `@context` — tam alan-alan tasarım

`packages/memory/src/memory-record-json-ld.ts` (saf TypeScript, framework import YOK — CLAUDE.md'nin domain-paket kuralı, `packages/memory`'nin geri kalanıyla tutarlı):

```ts
export const MEMORY_RECORD_JSON_LD_CONTEXT = {
  schema: 'https://schema.org/',
  luminaos: 'https://luminaos.dev/vocab#',
  content: 'schema:text',
  createdAt: 'schema:dateCreated',
  updatedAt: 'schema:dateModified',
  kaynakOlayId: 'luminaos:kaynakOlayId',
} as const;

export interface MemoryRecordJsonLd {
  '@context': typeof MEMORY_RECORD_JSON_LD_CONTEXT;
  '@type': 'schema:Note';
  '@id': string; // `urn:luminaos:memory-record:${record.id}`
  content: string;
  createdAt: string; // ISO 8601 (record.createdAt.toISOString())
  updatedAt: string; // ISO 8601 (record.updatedAt.toISOString())
  kaynakOlayId: string;
}

export function toMemoryRecordJsonLd(record: MemoryRecord): MemoryRecordJsonLd {
  return {
    '@context': MEMORY_RECORD_JSON_LD_CONTEXT,
    '@type': 'schema:Note',
    '@id': `urn:luminaos:memory-record:${record.id}`,
    content: record.content,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    kaynakOlayId: record.kaynakOlayId,
  };
}
```

Alan-alan kararlar:

- **`@type: 'schema:Note'`** (`schema:CreativeWork` DEĞİL) — bir bellek kaydı kullanıcının kendine bıraktığı kısa, serbest-metin bir not; `schema.org/Note` bu semantiğe `CreativeWork`'ten (yaratıcı/yayınlanabilir eser anlamı taşıyan, daha geniş bir üst-tip) daha dar ve daha doğru karşılık geliyor.
- **`@id`: `urn:luminaos:memory-record:<id>`** — kaydın kendi `id`'sinden türeyen, çakışmasız, kalıcı bir URN. HTTP URL DEĞİL (ör. `https://luminaos.app/...`) — bu kayıtlar herkese açık, çözümlenebilir bir web adresinde yaşamıyor; URN, "bu benzersiz bir LuminaOS kaynağıdır" anlamını, var olmayan bir HTTP adresi icat etmeden taşıyor. Format `urn:luminaos:<kaynak-tipi>:<id>` deseni gelecekteki JSON-LD yüzeyleri (context-fabric düğümleri, F2-T12'nin MCP sunucusu) için de tekrarlanabilir bir kalıp bırakıyor.
- **`content` → `schema:text`, `createdAt` → `schema:dateCreated`, `updatedAt` → `schema:dateModified`** — doğrudan `schema.org` karşılıkları var, kendi sözlüğümüzü icat etmiyoruz (spec'in Açık Soru 1 önerisi).
- **`kaynakOlayId` → `luminaos:kaynakOlayId`** — `schema.org`'da karşılığı yok (LuminaOS'in event-sourced provenance kavramı); `https://luminaos.dev/vocab#` altında kendi ek terimimiz tanımlanıyor. Bu IRI'nin arkasında bugün çözümlenebilir bir doküman YOK (kapsam dışı — yalnızca sözdizimsel geçerlilik bu görevde hedefleniyor, spec'in Kapsam DIŞI §5'i ile tutarlı); gelecekte bir `docs-writer` görevi bu IRI'yi gerçek bir vocab sayfasına bağlayabilir.
- **`workspaceId`/`userId`/`deletedAt` DAHİL EDİLMİYOR** — `workspaceId`/`userId` LuminaOS'e özel dahili tanımlayıcılar, taşınabilir bir "bu benim notumdur" temsiline anlam katmıyor (üstelik export zaten çağıranın kendi kayıtlarıyla scoped, `list()` cross-user/cross-workspace izolasyonunu koruyor — ADR-0022 Karar f); `deletedAt` zaten `list()`'in `deletedAt IS NULL` filtresiyle export'a hiç girmiyor, alanın kendisini taşımanın anlamı yok.

### (d) Export route query-DTO'su — `apps/server/src/memory/dto/memory-record-export-query.schema.ts`

`memory-record-content.schema.ts`'in tam kalıbını izler (zod, `.strict()` DEĞİL, `ZodValidationPipe` ile bağlanır):

```ts
import { z } from 'zod';

/**
 * Validates `GET /workspaces/:workspaceId/memory/export` query params.
 * `format` bugün TEK bir literal (`'json-ld'`) — serbest bir `z.string()`
 * DEĞİL, ADR-0016 §(c)'nin `?format=` konvansiyonunu izleyerek gelecekte
 * ikinci bir format eklenirse (`z.enum(['json-ld', '...'])`) genişletilebilir
 * bırakılıyor, ama bugünden geçersiz bir format string'inin sessizce kabul
 * edilmesine izin vermiyor.
 */
export const memoryRecordExportQuerySchema = z.object({
  format: z.literal('json-ld'),
});

export type MemoryRecordExportQueryInput = z.infer<typeof memoryRecordExportQuerySchema>;
```

### (e) Yanıt zarfı — `{records: MemoryRecordJsonLd[]}`, bare array DEĞİL

Controller'ın MEVCUT konvansiyonu — `list()` zaten `{records: MemoryRecord[]}` döndürüyor — birebir korunuyor: `export()` `{records: MemoryRecordJsonLd[]}` döndürür.

**Gerekçe:** Bare bir dizi (`MemoryRecordJsonLd[]`) döndürmek, aynı controller içinde iki farklı GET route'unun (list vs. export) iki farklı yanıt şekli konvansiyonu taşımasına yol açardı — implementer/tüketici için sürpriz. Zarf ayrıca ileride sessiz-kırılma olmadan genişletilebilir (ör. `{records, exportedAt}` gibi bir üst-meta alanı gerekirse eklenebilir, dizi tüketicileri zaten `.records` erişimine yazılmış olacağından etkilenmez). JSON-LD'nin kendi `@context`/`@type`/`@id` alanları zaten HER kayıt seviyesinde (spec'in "her kayıt ... şeklinde JSON-LD uyumlu üretilir" ifadesiyle tutarlı, bkz. Karar c) — zarfın kendisi bir JSON-LD dokümanı olma iddiasında değil, sadece controller'ın HTTP yanıt taşıyıcısı.

### (f) Toplu içe aktarma — client-side döngü, yeni bir bulk endpoint YOK (insan onaylı, spec Açık Soru 4)

İçe aktarma sihirbazı (`apps/web`), `parseImportInput`'un ürettiği her öğe için F2-T6'nın mevcut `useCreateMemoryRecordMutation` hook'unun `mutateAsync`'ini AYRI AYRI çağırır, `Promise.allSettled` ile toplar. Her öğenin başarı/başarısızlık durumu AYRI AYRI izlenir ve kullanıcıya gösterilir (spec Kabul Kriterleri — sessizce yutulmaz). Yeni bir `POST /memory/bulk` endpoint'i YOK; içe aktarılan her kayıt F2-T5'in event-sourced `MemoryRecordAdded` akışından (mevcut `POST /workspaces/:workspaceId/memory`) geçer, doğrudan DB yazımı yok.

**Gerekçe:** Mevcut tekli-create API'sini genişletmeden, mekanik ve basit; büyük hacimli import'larda performans endişesi ortaya çıkarsa ayrı bir gelecekteki görev olarak bulk endpoint eklenebilir (spec'in Kapsam DIŞI §4'ü ile tutarlı).

## Alt-PR ayrıştırması

Mimari-kritik görev — CLAUDE.md'nin ±400 satır rehberliğine tabi. İki parça, sırayla bağımsız merge edilebilir:

- **PR1 — Backend (JSON-LD + export route):** `packages/memory/src/memory-record-json-ld.ts` (Karar c, `toMemoryRecordJsonLd` + birim testleri — sabit `@id`/`@type`/`@context` alanları, `content`/`createdAt`/`updatedAt`/`kaynakOlayId` eşlemesi), `apps/server/src/memory/dto/memory-record-export-query.schema.ts` (Karar d), `memory-records.controller.ts`'e `@Get('export')` metodu (Karar b/e — `SessionAuthGuard`+`WorkspaceMembershipGuard`, `req.user.id`'den `list()` çağrısı + `toMemoryRecordJsonLd` map), entegrasyon testleri (geçerli `@context`/`@type`/`@id`, cross-user/cross-workspace izolasyonun `list()`'ten miras alındığının doğrulaması — ADR-0022 Karar f'nin aynı garantisi, tombstone'lu kayıtların export'ta görünmediği).
- **PR2 — Frontend (import sihirbazı + export tetikleyici):** `apps/web`'de `parseImportInput` (Karar a, üç-şekil ayrıştırma + birim testleri), çok-adımlı içe aktarma sihirbazı bileşeni (yapıştır/yükle → önizleme → onay → `Promise.allSettled` ile `useCreateMemoryRecordMutation.mutateAsync` döngüsü, Karar f), `MemoryPassportPanel.tsx`'e sihirbazı açan bir giriş noktası + export'u tetikleyen bir buton (yeni `getMemoryRecordsExport`/benzeri bir `apiClient.ts` fonksiyonu + `useMemoryRecordsExportQuery`-tarzı bir hook, F2-T6'nın `useMemoryRecordsQuery.ts` dosyasındaki kalıbı izleyerek), kısmi-başarı durumunun UI'da (hangi kayıtlar başarılı/başarısız) gösterimi, uçtan-uca test. PR1'e bağımlı.

## Alternatifler ve Reddedilme Gerekçeleri

- **ChatGPT/Claude'a özel dosya-formatı ayrıştırıcısı yazmak (PLAN.md'nin lafzının geniş okuması).** Reddedildi — Karar (a)'ya göre; bu iki ürünün gerçek export formatı bu oturumda doğrulanamadı, tahmin ederek bir ayrıştırıcı yazmak ADR-0016 §(d)'nin BlockNote riskiyle aynı türde bir risk taşırdı. Format netleştiğinde ayrı bir görev/ADR kararı.
- **JSON-LD export'u F1-T18'in `ExportService`'ine `format=json-ld` olarak eklemek (ADR-0016'nın tek-uç-nokta desenini genişletmek).** Reddedildi — Karar (b)'ye göre; `json-ld` yalnızca Memory Passport'a anlamlı bir format, genel workspace export'unun `json|markdown|ical` enum'una eklenmesi bellek-özel bir kavramı genel bir kavramla kirletirdi. RBAC kuralı (ADR-0016 §a) yine de MİRAS ALINIYOR, yalnızca route konumu ayrılıyor.
- **`@context`'i tamamen LuminaOS'e özel bir sözlükle kurmak (schema.org kullanmadan).** Reddedildi — spec'in Açık Soru 1 önerisi ve insan onayı; yaygın araçlarla uyumluluk ve tekerleği yeniden icat etmeme, `schema.org` terimleri mümkün olan her yerde tercih edildi.
- **`@type` için `schema:CreativeWork`.** Reddedildi — Karar (c)'ye göre; `schema:Note` bellek kaydının "kısa, kendine-not" semantiğine daha dar ve daha doğru karşılık geliyor.
- **`@id` için gerçek bir HTTP URL (ör. `https://luminaos.app/memory/<id>`).** Reddedildi — bu kayıtlar herkese açık, çözümlenebilir bir web adresinde yaşamıyor; var olmayan bir HTTP kaynağı iddia etmek yanıltıcı olurdu. URN, aynı benzersizlik garantisini doğru semantikle taşıyor.
- **Export yanıtını bare bir dizi (`MemoryRecordJsonLd[]`) olarak döndürmek.** Reddedildi — Karar (e)'ye göre; aynı controller içindeki `list()`'in zarflı (`{records}`) konvansiyonundan sapmak tutarsızlık yaratırdı, zarf ayrıca gelecekte sessiz-kırılma olmadan genişletilebilir.
- **Yeni bir `POST /memory/bulk` endpoint'i eklemek.** Reddedildi (v1 için) — Karar (f)'ye göre; mevcut tekli-create API'si yeterli, mekanik client-side döngü daha basit; performans ihtiyacı ortaya çıkarsa ayrı bir gelecekteki görev.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- Repodaki İLK JSON-LD yüzeyi, gelecekteki F2-T8 (erişim politikası manifestoları) ve F2-T12'nin (MCP sunucusu) üzerine kurabileceği somut, test edilebilir bir sözleşimle kuruluyor — `@context`/`@type`/`@id` tasarımı koddan önce sabitlendiği için implementer'ın ad-hoc bir şema icat etme riski ortadan kalkıyor.
- ADR-0016 §(a)'nın "rol-gate yalnızca idari mutasyon için, okuma/export için asla" kuralı ikinci kez, bağımsız bir uç noktada teyit ediliyor — kuralın gerçekten Faz 2+'ye bağlayıcı olduğunun somut kanıtı.
- İçe aktarma kapsamının bilinçli daralması (yalnızca genel format) koddan önce insan onayıyla kayda geçiyor — implementer'ın doğrulanmamış bir ChatGPT/Claude şemasını tahmin etme riski ortadan kalkıyor.
- Round-trip tasarımı (LuminaOS'in kendi JSON-LD export'unu re-import edebilmesi, Karar a şekil 1) `content` alanını export/import arasında kayıpsız taşır. `kaynakOlayId` BUNA DAHİL DEĞİL — `parseImportInput` yalnızca `schema:text`'i (→ `content`) çıkarır, re-import edilen her kayıt `POST /memory` üzerinden BRAND-NEW bir `MemoryRecordAdded` olayı yaratır, dolayısıyla kendi YENİ, kendine-referans `kaynakOlayId`'sini alır (ADR-0022 Karar b'nin v1 semantiği) — orijinal kaydın `kaynakOlayId`'si taşınmaz, taşınamaz.

**Neyi erteliyoruz / kabul ediyoruz:**

- ChatGPT/Claude'a özel içe aktarma ayrıştırıcısı yok — gerçek format doğrulanana kadar ayrı bir görev/ADR'ye ertelendi.
- Yeni bir bulk-create backend endpoint'i yok — büyük hacimli import'larda performans, client-side `Promise.allSettled` döngüsüne bağımlı kalıyor; ölçek sorunu çıkarsa ayrı bir gelecekteki görev.
- `luminaos:kaynakOlayId` IRI'sinin arkasında bugün çözümlenebilir bir vocab dokümanı yok — yalnızca sözdizimsel geçerlilik hedefleniyor (spec'in Kapsam DIŞI §5'i), gerçek bir RDF-store doğrulaması bu görevde yapılmıyor.
- JSON-LD şeması yalnızca Memory Passport kayıtlarıyla sınırlı — F1-T18'in genel `LuminaObject` JSON export'u bu görevde JSON-LD'ye taşınmıyor (spec'in Kapsam DIŞI §3'ü).
