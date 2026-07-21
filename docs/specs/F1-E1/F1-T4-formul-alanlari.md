# F1-T4 — Formül Alanları + Sütun Hesaplamaları

**Epik:** F1-E1 · **Durum:** Yapılacak
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

- [ ] Parser fuzz/property testi: rastgele girdilerde asla crash yok — ya sonuç ya tanımlı hata.
- [ ] `eval`/`new Function` kullanımını yasaklayan lint kuralı eklendi ve yeşil.
- [ ] 3 seviye iç içe formül doğru hesaplanır; döngü tanım anında reddedilir (testli).
- [ ] #ERROR yayılımı testli; sütun hesaplamaları 7 fonksiyon için doğrulandı.
- [ ] 10.000 nesnelik listede tek alan değişikliği yalnız etkilenen formülleri yeniden hesaplar (test/ölçüm).
