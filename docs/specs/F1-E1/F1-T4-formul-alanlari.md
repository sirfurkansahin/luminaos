# F1-T4 — Formül Alanları + Sütun Hesaplamaları

**Epik:** F1-E1 · **Durum:** Tamamlandı
**Bağımlılık:** F1-T2

## Amaç

Alan değerlerinden hesaplanan formül alanları (ClickUp'taki iç içe formüllerin karşılığı) ve liste üzerinde toplu hesaplamalar.

## Kapsam

1. **Güvenli ifade motoru:** Kendi mini DSL'imiz — `eval`/`Function` KESİNLİKLE yasak. Tokenizer + parser + evaluator packages/core-objects içinde. Desteklenen: aritmetik, karşılaştırma, mantık, string birleştirme, `IF/AND/OR/NOT`, `ROUND/ABS/MIN/MAX`, `CONCAT/UPPER/LOWER/LEN`, `TODAY/DAYS_BETWEEN`, alan referansı `{fieldKey}`.
2. **formula alan tipi:** FieldDefinition'a eklenir (`config.expression`); değeri yazılamaz, hesaplanır.
3. **İç içe formüller:** formül başka formül alanına referans verebilir; bağımlılık grafiği çıkarılır, döngüsel referans tanımda reddedilir; hesap topolojik sırayla.
4. **Hata semantiği:** tip uyuşmazlığı/sıfıra bölme/eksik alan → değer `#ERROR("mesaj")`; hata yayılımı tanımlı (hatalı girdiye bağlı formül de #ERROR).
5. **Yeniden hesaplama:** `FieldValueChanged` olayı, o alana bağlı formülleri projeksiyonda günceller (event-driven, artımlı).
6. **Sütun hesaplamaları:** sorgu sonucu üzerinde sum, avg, min, max, count, countUnique, countEmpty — API'de `aggregate` parametresiyle.

## Kapsam DIŞI

- Formül düzenleme UI'ı; tarih dışı gelişmiş fonksiyon kütüphanesi (ihtiyaçla genişler).

## Kabul Kriterleri

- [x] Parser fuzz/property testi: rastgele girdilerde asla crash yok — ya sonuç ya tanımlı hata.
- [x] `eval`/`new Function` kullanımını yasaklayan lint kuralı eklendi ve yeşil.
- [x] 3 seviye iç içe formül doğru hesaplanır; döngü tanım anında reddedilir (testli).
- [x] #ERROR yayılımı testli; sütun hesaplamaları 7 fonksiyon için doğrulandı.
- [x] 10.000 nesnelik listede tek alan değişikliği yalnız etkilenen formülleri yeniden hesaplar (test/ölçüm).

## Tamamlanma Notu

Dört ana commit + bir güvenlik-denetimi düzeltmesi halinde uygulandı (branch:
`feature/f1-t4-formul-alanlari`), `docs/adr/ADR-0007-formul-alanlari.md`'de
belgelendi:

- **PR-A1** (`packages/core-objects/src/fields/formula/`, ifade motoru):
  elle yazılmış tokenizer/parser/evaluator, `eval`/`Function` yok —
  `packages/core-objects/eslint.config.js`'e eklenen `no-eval`/`no-new-func`/
  `no-implied-eval` kurallarıyla sözdizimsel olarak da zorunlu kılındı.
  `MAX_EXPRESSION_LENGTH`/`MAX_NESTING_DEPTH` korumaları + fuzz/property
  testleriyle (`fast-check`, 200 koşum) "asla crash yok" kanıtlandı.
- **PR-A2** (`formula` alan tipi + döngü tespiti): `field-type-registry.ts`'in 13. tipi; `defineField`/`updateField`'in F1-T3 (`createRelation`)
  deseniyle aynı şekilde genişletilen `existingFieldDefinitions` parametresi
  — bilinmeyen alan referansı ve formül-formül döngüsü tanım anında
  reddedilir (`formula-graph.ts`); `field-aggregations.ts` (7 saf fonksiyon).
- **PR-B** (sunucu: yeniden-hesaplama entegrasyonu): `ObjectsService.create`/
  `.setFieldValues`, etkilenen formülleri (`getAffectedFormulaKeysInOrder`)
  topolojik sırayla, TEK `append()` çağrısında, sistem-aktörlü (`{type:
'system', id: 'formula-engine'}`) gerçek `FieldValueChanged` olayları
  olarak yeniden hesaplar — rebuild determinizmini bozmaz. 3-seviye iç-içe
  hesaplama, #ERROR yayılımı ve 10.000-nesnelik ölçek testiyle (tek yazımın
  yalnızca yazılan nesneyi etkilediği) kanıtlandı.
- **PR-C** (sütun hesaplamaları): `GET .../objects?aggregate=fieldKey:fn,...`
  — hesaplama, rol-bazlı alan filtrelemesinden SONRA çalışır (gizli bir
  alanın değeri agregat sonucuna asla sızmaz).
- **security-reviewer bulguları:** (1) F1-T1'in donmuş `ObjectsViewProjection`
  koduna yalnızca bir testin seed kısayolu için eklenen `onConflictDoNothing`
  geri alındı; test gerçek bir `ProjectionRunner.catchUp()` döngüsüyle
  yeniden tasarlandı. (2) `__proto__`/`constructor`/`prototype` alan
  anahtarları artık tüm alan tiplerinde reddediliyor (prototype-pollution
  koruması). (3) Eşzamanlı formül-döngü doğrulaması yarışı kabul
  edilen/ertelenen risk olarak ADR-0007'de belgelendi.

`packages/core-objects` toplam 496 test ile yeşil (F1-T1/F1-T2/F1-T3 dahil
kümülatif); F1-T4'e özgü 27 yeni entegrasyon testi (Testcontainers, gerçek
Postgres+Redis+HTTP) + sunucu paketinin tam entegrasyon takımı (18 dosya,
135 test) yeşil, regresyon yok.
