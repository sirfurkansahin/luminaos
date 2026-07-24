# F1-T2 — Custom Fields Motoru

**Epik:** F1-E1 · **Durum:** Tamamlandı
**Bağımlılık:** F1-T1

## Amaç

Her Lumina Object'e workspace'in kendi tanımladığı alanların eklenebilmesi: 12 alan tipi, varsayılan değerler ve alan bazlı izinler.

## Kapsam

1. **Alan tanımı (FieldDefinition):** workspace + nesne tipi kapsamında tanımlanır: `{ id, key, label, fieldType, config, defaultValue, permissions }`. Olaylar: `FieldDefined`, `FieldUpdated`, `FieldArchived`.
2. **12 alan tipi:** text, longText, number, checkbox, date, datetime, select, multiSelect, url, email, people, currency. Her tipin zod doğrulayıcısı + config şeması (ör. select seçenekleri, currency kodu).
3. **Değer yazımı:** `setFieldValue(objectId, fieldKey, value)` → doğrulama → `FieldValueChanged` olayı; toplu yazım (`setFieldValues`) tek olay grubunda.
4. **Varsayılan değerler:** nesne oluşturulurken tanımlı default'lar otomatik uygulanır (olayda görünür).
5. **Alan bazlı izinler:** `view | edit | hidden` × rol (owner/admin/member/guest); yetkisiz yazma reddi, `hidden` alan API yanıtlarından süzülür.
6. **Projeksiyon:** `objects_view` alan değerleriyle genişletilir; alan bazlı filtreleme için sorgu yardımcıları (F1-T6'nın temeli).

## Kapsam DIŞI

- formula ve ai alan tipleri (F1-T4, F1-T5).
- UI form bileşenleri (görünümlerle birlikte).

## Kabul Kriterleri

- [x] 12 tipin her biri için geçerli/geçersiz değer testleri (tip başına en az 3 senaryo).
- [x] select'e tanımsız seçenek, number'a string vb. → tanımlı doğrulama hatası.
- [x] guest rolü `edit` izni olmayan alana yazamaz; `hidden` alan guest yanıtında görünmez (entegrasyon testli).
- [x] Default değerler ObjectCreated akışında uygulanır ve replay'de korunur.
- [x] Alan tanımı değişince mevcut değerler bozulmaz (geriye uyumluluk testi).

## Tamamlanma Notu

Üç PR halinde uygulandı, `docs/adr/ADR-0005-custom-fields-motoru.md`'de belgelendi:

- **PR-A** (`packages/core-objects/src/fields/`, saf domain): `FieldDefinition` +
  `defineField/updateField/archiveField` + `replayFieldDefinition`; 12 alan tipi
  için zod tabanlı doğrulama motoru (`field-type-registry.ts`, yeni `zod`
  bağımlılığı); alan değeri komutları (`setFieldValue/setFieldValues/
applyDefaultFieldValues`) ve nesnenin kendi stream'inde çalışan izin verici
  `replayFieldValues` fold'u; `Role`/`FieldPermissions` per-role izin haritası.
  257 test, kapsam ≥%95. security-reviewer bulgusu (options dizisi/uzunluğu için
  üst sınır eksikliği — DoS yüzeyi) TDD ile kapatıldı.
- **PR-B** (`apps/server/src/fields/`, alan tanımı CRUD): `FieldDefinitionsService`/
  `FieldsController` (`/workspaces/:workspaceId/object-types/:objectType/fields`),
  şema yönetimi admin+ ile sınırlı. security-reviewer 3 bulgu buldu (eşzamanlı
  `define()` yarışının projeksiyonu kalıcı kilitleme riski — "zehir hap"; `GET
/fields`'in hidden alanları filtrelememesi; yanlış `:objectType` ile alan
  mutasyonu) — hepsi TDD ile kapatıldı.
- **PR-C** (`apps/server/src/objects/` genişletmesi, alan değeri yazımı): `objects_view`
  yeni `field_values jsonb` kolonuyla genişledi (parametreli `jsonb_set`); YENİ
  `PATCH .../objects/:objectId/fields` (toplu, tümü-ya-da-hiçbiri); `GET`/`list`
  callerRole'e göre `hidden` alanları tam olarak süzer. security-reviewer 2
  bulgu buldu (hidden alana yazma denemesinin 403 dönerek varlığını sızdırması;
  hata mesajına ham fieldKey gömülmesi) — tek düzeltmeyle (404 + statik mesaj)
  kapatıldı.

Toplam 75 entegrasyon testi (Testcontainers, gerçek Postgres+Redis+HTTP) yeşil.
