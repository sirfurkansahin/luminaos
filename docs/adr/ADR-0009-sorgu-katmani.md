# ADR-0009: Sorgu Katmanı — Parametreli SQL Derleyici, Keyset Cursor Sayfalama ve Katmanlı Operatör Doğrulaması

**Durum:** Kabul edildi
**Tarih:** 2026-07-26
**İlgili görev:** [F1-T6 — Sorgu Katmanı (Filter/Sort/Group DSL)](../specs/F1-E2/F1-T6-sorgu-katmani.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E2: Görünüm Motoru" (F1-T6 satırı): _"görünümler veriye değil sorguya bağlanır"_ — ayrıca CLAUDE.md "Kodlama Sözleşmeleri" ve spec'in kendi açık şartı: _"Zorunlu güvenlik kuralı: tüm değerler parametreli bağlanır, asla string interpolasyonu yok."_

> Bu ADR dokümantasyon amaçlıdır (F1-T2/ADR-0005, F1-T3/ADR-0006, F1-T4/ADR-0007, F1-T5/ADR-0008 emsali): kararlar planlama sırasında gerekçelendirildi ve 4 PR boyunca (`packages/shared` temel tipler → `packages/core-objects` operatör matrisi → sunucu sorgu-derleyicisi + API ucu → migration/performans/kapsamlı test) sırayla uygulandı, her PR sonunda `security-reviewer` denetiminden geçti.

## Bağlam

F1-E1 (nesne çekirdeği, custom fields, ilişkiler, formül/AI alanları) tamamlandı. F1-E2 (Görünüm Motoru), PLAN.md'nin "görünümler veriye değil sorguya bağlanır" ilkesini F1-T6 ile somutlaştırıyor: F1-T7 (List/Board/Table), F1-T8 (Calendar/Timeline) ve F1-T9 (kaydedilmiş görünümler) bundan sonraki her görev bu sorgu katmanının doğrudan tüketicisi olacak.

Çözülmesi gereken merkezi sorular: (1) `QuerySpec` tipi hangi katmanda yaşamalı — hem sunucu hem (F1-T9'dan itibaren) frontend'in ortak kullanabileceği, framework'ten bağımsız bir sözleşme; (2) 14 farklı `FieldType`'ın her biri için hangi filtre operatörleri geçerli, ve bu bilgi nerede (hangi paket) tutulmalı; (3) keyfi alan anahtarları ve filtre değerleri `objects_view`/`field_values` jsonb'ı üzerinde SQL enjeksiyonuna kapalı şekilde nasıl derlenir; (4) sayfalama, `sort` rastgele bir custom alanı içerdiğinde nasıl tutarlı kalır; (5) rol-bazlı `hidden` alan filtrelemesi (F1-T2) sorgu katmanında da (filtre/sıralama/gruplama reddi VE sonuç süzme) nasıl korunur.

## Karar

### (a) `packages/shared/src/query/` — çerçeveden ve `core-objects`'ten bağımsız temel sözleşme

`QuerySpec = {objectType, filters, sort?, group?, cursor?, limit?}`, `FilterCondition = {field, operator, value?}`, `SortSpec = {field, direction}`, `FilterOperator` (15 literal). Zod şema önce tanımlanır, tip `z.infer` ile türetilir (F0-T6'nın `domainEventSchema` deseni). `objectType` spec'in kendi taslağında yoktu — alan/operatör doğrulaması ve `group` HANGİ nesne tipinin alan tanımlarına göre yapılacağını bilmek zorunda olduğundan eklendi (eksiksiz bir sözleşme için gerekli bir düzeltme). Bu paket `core-objects`'e bağımlı DEĞİL (bağımlılık yönü tersi) — `objectType`/alan anahtarları burada düz `string`, daraltma bir üst katmanın işi.

Güvenlik denetiminde: `filters` (max 50) / `sort` (max 10) / `limit` (max 200) zaten sınırlıydı; `cursor`'a da 2000 karakter üst sınırı eklendi (tutarlılık için, DoS-savunması disiplini).

### (b) `packages/core-objects/src/fields/query/` — FieldType→operatör matrisi, `formula`/`ai` için özel muamele

`getValidOperatorsForField`/`assertValidFilterCondition`/`assertGroupableField`/`assertSortableField`. Operatör matrisi spec'in açıkça verdiği 6 tip + geri kalan 8 için gerekçeli çıkarım (bkz. `filter-operators.ts`'in kendi yorumları). İki özel durum:

- **`ai`**: operatör seti `config.outputType`'a göre dallanır (`'select'` ise `select`'in seti, `'text'` ise `text`'in seti) — `field-type-registry.ts`'in kendi `buildValueSchema`'sındaki AYNI dallanma, F1-T5'ten miras.
- **`formula`**: değer tipi STATİK bilinmiyor (config'te bir "outputType" yok) — yalnızca tip-agnostik, her zaman güvenli operatörler (`equals`/`notEquals`/`isEmpty`/`isNotEmpty`).

`group`, yalnızca `select` tipi bir alan için geçerli (spec'in lafzı) — `multiSelect` dahil başka hiçbir tip gruplanabilir değil (bir grup anahtarının tek, ayrık bir değer olması gerekir).

### (c) Sunucu sorgu-derleyicisi — parametreli Drizzle SQL, keyset cursor, gruplama

`ObjectsService.query`, doğrulamayı KESİN bir sırada yapar (`object-query.integration.test.ts`'in kendi başlık yorumunda pinlenmiş): (1) bilinmeyen `objectType` → `ValidationError`; (2) her referans edilen alan anahtarı (filtre/sıralama/grup) sabit kolon DEĞİLSE, aktif+GÖRÜNÜR bir alan tanımına çözülmeli — yoksa/hidden ise `NotFoundError` (F1-T2'nin `setFieldValues` varlık-gizleme deseni birebir tekrarı: "hidden bir alan tanımsız bir alandan ayırt edilemez", 404 asla 403 değil); (3) operatör-tip eşleşmesi (`assertValidFilterCondition`); (4) sıralanabilirlik; (5) gruplanabilirlik; (6) operatöre-özgü değer şekli (`between` 2-elemanlı dizi, `in`/`notIn` dizi, `isEmpty`/`isNotEmpty` değersiz, diğerleri tekil-skaler).

`apps/server/src/objects/query-builder.ts`, F1-T2'nin `jsonb_set` disiplinini (`objects-view.projection.ts`) birebir izler: **her dinamik değer (alan anahtarları, filtre değerleri, cursor değerleri) Drizzle'ın `sql` tagged template'inin `${...}` bağlı-parametre mekanizmasından geçer, asla `sql.raw`/string concat değil.**

**Keyset cursor sayfalama:** opak, base64url kodlu bir değer-tuple'ı (`[...sıralamaDeğerleri, id]`, `id` her zaman kararlı son tekilleştirici). Genel keyset "seek" formülü kullanılır (`(C1 op1 V1) OR (C1=V1 AND C2 op2 V2) OR ...`), bu yüzden `sort`'taki HERHANGİ bir alan sayısıyla (tek veya çoklu) doğru çalışır — bir tek sıralama alanına özgü basitleştirilmiş bir cursor tasarımı yerine.

**Gruplama** (`group` bir `select` alanı): filtreler aynen uygulanır, ama sonuç `{groupValue, count, items[]}[]` — **kullanıcı-onaylı v1 tasarım kararı:** grup başına AYRI bir cursor/limit YOK, her grup TÜM eşleşen öğeleri döner; üst-seviye `limit`/`cursor` yalnızca `group` YOKKEN düz-liste modunda geçerli. `group` alanının değeri hiç set edilmemiş bir nesne, HİÇBİR gruba dahil edilmez (null/boş-değer grubu oluşturulmaz).

### (d) Performans — index stratejisi + 10.000-nesnelik kanıt

`objects_view`'a migration 0009: `(workspaceId, type, lifecycle)` composite btree (sorgu katmanının kendi scoping predicate'i — her zaman `workspaceId`+`type`+`lifecycle!='deleted'` — için) + `field_values` üzerinde bir GIN index (jsonb `?`/`?|` dizi-üyelik operatörlerini, yani `multiSelect`/`people` filtrelerini hızlandırır). jsonb'daki KEYFİ bir anahtarın metin-çıkarımlı (`->>`) skaler filtreleri (number/date/select/...) dinamik anahtar sayısı nedeniyle genel bir expression-index'le hızlandırılamaz — bu filtreler composite index'in daralttığı satır kümesi üzerinde sıralı taramaya dayanır. Bu VARSAYIM değil, 10.000-nesnelik gerçek bir entegrasyon testiyle (Testcontainers, gerçek Postgres, gerçek HTTP) KANITLANDI: tipik filtre+sırala+limit sorgusu <200ms; grup sorgusu (v1'in bilinçli olarak sınırsız tasarımı gereği) <2sn'lik daha gevşek bir sınırla.

### (e) Güvenlik denetimi bulguları ve çözümleri (üç ayrı tur)

1. **ILIKE joker karakteri kaçışlama sırası hatası** — ters eğik çizgi ÖNCE kaçışlanmalıydı; aksi halde kullanıcının kendi ters eğik çizgisi eklenen kaçışı "tüketip" bir alt çizgiyi/yüzdeyi tekrar canlı joker haline getirebiliyordu. Düzeltildi + testli (literal `\_` içeren bir değerin yanlışlıkla joker eşleşmesi yapmadığı kanıtlandı).
2. **Operatör değeri yalnızca aritet, alan TİPİ değil doğrulanıyordu** — geçersiz bir tip (örn. sayısal alana string) doğrudan `::numeric`/`::timestamptz`/`::boolean` cast'ine ulaşıp kontrolsüz bir 500 üretiyordu (enjeksiyon değil, ama gereksiz sert bir hata). `assertNumberValue`/`assertStringValue`/`assertBooleanValue`/`assertDateValue`/`assertStringArrayValue` eklendi, her predicate builder'a bağlandı.
3. **`in`/`notIn` dizi değeri sınırsızdı** — 100 elemanla sınırlandı (DoS-savunması, `QuerySpec`'in kendi disiplinine paralel).
4. **`QuerySpec.cursor`'a üst sınır yoktu** — 2000 karakter eklendi.
5. **Gerçek Postgres'e karşı doğrulanırken bulunan bir korektlik hatası** (enjeksiyon değil, ama testler olmadan fark edilmeyecek türden): drizzle-orm'un `sql` template'i ham bir JS dizisini (`${array}`) tek bir dizi-tipli parametre değil, "parçaları ayrı SQL fragmanlarına BÖL" olarak yorumluyor — tek elemanlı bir dizi bu yüzden Postgres'e çıplak bir skaler olarak ulaşıp `malformed array literal` hatası veriyordu (`multiSelect`'in `?|` filtresi). `sqlTextArrayLiteral` (her eleman kendi bağlı parametresi olarak `ARRAY[...]::text[]` kurucusu) ile düzeltildi — enjeksiyon yüzeyi değişmedi, yalnızca doğru dizi-tipli değer üretiliyor.
6. **Cursor değerleri, filtre değerleriyle TUTARSIZ şekilde tip-doğrulanmıyordu** (son tur) — sahte bir cursor, sıralanan kolonun tipine uymayan bir değer taşıyorsa `bindComparableValue` bunu kontrolsüz cast'e sokuyordu. `assertCursorValueKind`, filtre-değeri sertleştirmesiyle AYNI disiplinle eklendi.

**Bilinçli olarak ertelenen/kabul edilen bulgular** (güvenlik açığı değil, operasyonel/tasarım notları):

- Migration 0009, `CREATE INDEX CONCURRENTLY` değil düz `CREATE INDEX` kullanır — büyük, üretimde zaten dolu bir `objects_view` tablosunda yazımları geçici olarak durdurabilir (bu repo'nun transactional migration runner'ı `CONCURRENTLY`'yi doğrudan desteklemiyor, ayrı bir migration-altyapısı görevi gerektirir).
- Bir cursor, hangi sorgu için üretildiğine bağlanmaz (yalnızca uzunluk kontrol edilir) — farklı bir sorguya karşı yeniden kullanılırsa semantik olarak yanlış (ama asla workspace/tip/yaşam-döngüsü kapsamının dışına sızdırmayan, çünkü `baseWhere` her zaman AND'lenir) sayfalama sonucu doğurabilir.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- `packages/shared`'da framework'ten ve `core-objects`'ten bağımsız, F1-T9'un `SavedView.querySpec`'inin doğrudan saklayabileceği bir `QuerySpec` sözleşmesi.
- 14 `FieldType`'ın her biri için `core-objects` katmanında saf, test edilebilir bir operatör-geçerlilik tablosu — `ai`'ın config'e-bağlı dallanması ve `formula`'nın tip-agnostik kısıtlı seti dahil.
- F1-T2'nin `jsonb_set` disiplinini birebir izleyen, tamamen parametreli bir SQL derleyici — üç ayrı güvenlik denetimi turunda bulunan her sorun (ILIKE kaçışlama, tip doğrulaması, dizi-parametre hatası, cursor tip doğrulaması) kapatıldı ve testle kanıtlandı.
- `sort`'taki HERHANGİ bir alan sayısıyla doğru çalışan, genel keyset-sayfalama formülüne dayanan bir cursor tasarımı.
- Rol-bazlı `hidden` alan filtrelemesi, `setFieldValues`'ın varlık-gizleme desenini (404, asla 403) filtre/sıralama/gruplamanın HER ÜÇÜNDE de aynı şekilde koruyor.
- 10.000-nesnelik gerçek bir performans testiyle kanıtlanmış, "workspace-scope index + sınırlı satır kümesinde sıralı tarama" stratejisi.

**Neyi erteliyoruz:**

- Kaydedilmiş görünümler (F1-T9'un kendi kapsamı).
- Sütun toplamaları (F1-T4'te zaten var, bu görev yalnızca tüketir).
- UI (F1-T7'de).
- `CREATE INDEX CONCURRENTLY` — büyük üretim tablolarında migration kilit süresini azaltmak için ayrı bir migration-altyapısı takip görevi.
- Cursor'ın hangi sorgu için üretildiğine bağlanması — düzeltilmezse yalnızca yanlış (ama kapsam-dışına sızdırmayan) sayfalama sonucu riski taşıyan, kabul edilmiş bir v1 sınırlaması.
