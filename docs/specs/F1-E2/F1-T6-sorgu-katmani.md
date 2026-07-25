# F1-T6 — Sorgu Katmanı (Filter/Sort/Group DSL)

**Epik:** F1-E2 (Görünüm Motoru) · **Durum:** Yapılacak
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

- [ ] Her alan tipi için en az 2 geçerli filtre senaryosu + 1 geçersiz operatör reddi testli.
- [ ] Sıralama: başlık, `createdAt`, bir custom alan (number/date) ile test edilir.
- [ ] Gruplama: `select` alanına göre gruplama doğru sayım + öğe listesi döner.
- [ ] SQL injection'a karşı güvenli: bilerek kötücül bir filtre değeri (`'; DROP TABLE--`) gönderilir, zararsız şekilde işlenir (security-reviewer + testli).
- [ ] 10.000 nesnelik test workspace'inde tipik sorgu <200ms (performans testi).
- [ ] Rol-bazlı `hidden` alan süzme, sorgu sonuçlarında da korunur (guest kullanıcı hidden alana göre filtreleme yapamaz veya sonuçta göremez).
