# F1-T2 — Custom Fields Motoru

**Epik:** F1-E1 · **Durum:** Yapılacak
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

- [ ] 12 tipin her biri için geçerli/geçersiz değer testleri (tip başına en az 3 senaryo).
- [ ] select'e tanımsız seçenek, number'a string vb. → tanımlı doğrulama hatası.
- [ ] guest rolü `edit` izni olmayan alana yazamaz; `hidden` alan guest yanıtında görünmez (entegrasyon testli).
- [ ] Default değerler ObjectCreated akışında uygulanır ve replay'de korunur.
- [ ] Alan tanımı değişince mevcut değerler bozulmaz (geriye uyumluluk testi).
