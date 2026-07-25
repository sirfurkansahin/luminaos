# F1-T6 — Sorgu Katmanı (Filter/Sort/Group DSL)

**Epik:** F1-E2 (Görünüm Motoru) · **Durum:** Tamamlandı
**Bağımlılık:** F1-E1 tamamlandı (özellikle F1-T2 Custom Fields, F1-T4 Formül Alanları)

## Amaç

Nesneleri filtreleme/sıralama/gruplama için tip-güvenli bir sorgu dili (DSL) ve bunu `objects_view` + `field_values` üzerinde güvenli şekilde çalıştıran bir API ucu kurmak. PLAN.md'nin ilkesi burada somutlaşıyor: **"görünümler veriye değil sorguya bağlanır"** — F1-T7'den itibaren tüm görünümler (List/Board/Table/Calendar) bu sorgu katmanının tüketicisi olacak.

## Kapsam

1. **QuerySpec tipi** (`packages/shared/src/query/`): `{ filters: FilterCondition[], sort?: SortSpec[], group?: string, cursor?: string, limit?: number }`. `FilterCondition = { field: string, operator: FilterOperator, value: unknown }`.
2. **Alan tipine göre operatör seti:** `packages/core-objects`'teki `field-type-registry`'den yararlanarak her `FieldType` için geçerli operatörler tanımlanır (örn. `text`→contains/equals, `number`/`currency`→gt/lt/between, `date`/`datetime`→before/after/between, `select`→in/notIn, `checkbox`→equals). Geçersiz alan-operatör eşleşmesi (örn. `checkbox` alanına `contains`) → `ValidationError`.
3. **Sunucu tarafı sorgu derleyici** (`apps/server/src/objects/query-builder.ts`): `QuerySpec`'i `objects_view` (sabit kolonlar) + `field_values` jsonb (özel alanlar) üzerinde çalışan bir Drizzle sorgusuna çevirir. **Zorunlu güvenlik kuralı: tüm değerler parametreli bağlanır, asla string interpolasyonu yok** (F1-T2'deki `jsonb_set` dersiyle aynı disiplin).
4. **API ucu:** `POST /workspaces/:workspaceId/objects/query` (body: `QuerySpec`) — mevcut rol-bazlı `hidden` alan süzme mantığını (F1-T2) korur, cursor-tabanlı sayfalama (ULID doğal olarak sıralanabilir olduğu için cursor olarak kullanılabilir).
5. **Gruplama:** `group` bir `select` tipi alan olduğunda, sonuç `{ groupValue, count, items[] }` şeklinde döner (Board görünümünün temel veri kaynağı).
6. **Performans:** `objects_view`'da yaygın filtreler için index stratejisi; 10.000 nesnelik workspace'te tipik bir sorgu <200ms.

## Kapsam DIŞI

- Kaydedilmiş görünümler (F1-T9).
- Sütun toplamaları (F1-T4'te zaten var, burada sadece tüketilir).
- UI (F1-T7'de).

## Kabul Kriterleri

- [x] Her alan tipi için en az 2 geçerli filtre senaryosu + 1 geçersiz operatör reddi testli.
- [x] Sıralama: başlık, `createdAt`, bir custom alan (number/date) ile test edilir.
- [x] Gruplama: `select` alanına göre gruplama doğru sayım + öğe listesi döner.
- [x] SQL injection'a karşı güvenli: bilerek kötücül bir filtre değeri (`'; DROP TABLE--`) gönderilir, zararsız şekilde işlenir (security-reviewer + testli).
- [x] 10.000 nesnelik test workspace'inde tipik sorgu <200ms (performans testi).
- [x] Rol-bazlı `hidden` alan süzme, sorgu sonuçlarında da korunur (guest kullanıcı hidden alana göre filtreleme yapamaz veya sonuçta göremez).

## Tamamlanma Notu

Dört PR halinde uygulandı (branch: `feature/f1-t6-sorgu-katmani`), `docs/adr/ADR-0009-sorgu-katmani.md`'de belgelendi:

- **PR-A** (`packages/shared/src/query/`): `QuerySpec`/`FilterCondition`/`SortSpec`/
  `FilterOperator` zod şemaları + tipleri — çerçeveden ve `core-objects`'ten
  bağımsız, F1-T9'un `SavedView.querySpec`'inin doğrudan saklayabileceği bir
  sözleşme.
- **PR-B** (`packages/core-objects/src/fields/query/`): `getValidOperatorsForField`/
  `assertValidFilterCondition`/`assertGroupableField`/`assertSortableField` — 14
  `FieldType`'ın operatör matrisi, `ai`'ın `config.outputType`'a bağlı dallanması,
  `formula`'nın tip-agnostik kısıtlı seti.
- **PR-C** (sunucu entegrasyonu): `query-builder.ts` (parametreli Drizzle SQL
  derleyici, F1-T2'nin `jsonb_set` disiplinini izler), `ObjectsService.query`,
  `POST .../objects/query` route'u, genel keyset-sayfalama formülüne dayanan
  cursor tasarımı, `{groupValue,count,items}` gruplaması, rol-bazlı hidden-alan
  reddi (`setFieldValues`'ın 404-varlık-gizleme deseni). **security-reviewer
  bulguları:** ILIKE kaçışlama sırası hatası, operatör-değeri tip doğrulaması
  eksikliği, `in`/`notIn` dizi üst sınırı yokluğu, `cursor` üst sınırı yokluğu —
  hepsi kapatıldı.
- **PR-D** (migration + performans + kalan kapsam): `objects_view`'a composite
  btree + `field_values` GIN index (migration 0009); kalan 8 `FieldType`
  (`longText`/`url`/`email`/`datetime`/`multiSelect`/`people`/`currency`/`ai`)
  için kapsamlı filtre testleri; 10.000-nesnelik performans testi (<200ms
  tipik sorgu). Bu turda gerçek Postgres'e karşı doğrulanırken bulunan bir
  korektlik hatası (drizzle-orm'un `sql` template'inin ham bir JS dizisini tek
  parametre değil ayrı fragmanlara bölmesi, `multiSelect`'in `?|` filtresini
  bozuyordu) düzeltildi. **Son security-reviewer turu:** cursor değerlerinin
  filtre değerleriyle tutarsız şekilde tip-doğrulanmadığı bulundu ve kapatıldı.

`apps/server` tam entegrasyon takımı (23 dosya, 219 test, Testcontainers ile
gerçek Postgres+Redis+HTTP, 10.000-nesnelik performans testi dahil) + birim
testleri (13 dosya, 98 test) + `packages/shared`/`packages/core-objects`
kendi test takımları yeşil, regresyon yok.
