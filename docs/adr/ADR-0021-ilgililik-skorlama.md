# ADR-0021: İlgililik Skorlama — Sorgu-Zamanı Sönümleme, `sort=relevance` Parametresi, Kenar-Türü Ağırlıkları

**Durum:** Kabul edildi — Karar (b) için Aday B (üstel, 14 günlük yarı-ömür) ve Karar (c)'nin önerilen kenar-türü temel ağırlıkları (`1.0`/`0.8`/`0.6`/`0.4`) insan tarafından seçildi/onaylandı; tüm kararlar (a)-(g) bağlayıcı.
**Tarih:** 2026-08-16
**İlgili görev:** [F2-T4 — İlgililik Skorlama + Zaman Aşımıyla Sönümleme](../specs/F2-E1/F2-T4-ilgililik-skorlama.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E1: Lumina Context Fabric" (F2-T4 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin YALNIZCA **ikinci fıkrası** ("Karar birden fazla pakete veya gelecekteki görevlere dayatılan bir sözleşim tanımlıyorsa — veri şekli, event tipi, API kontratı") bu kararı tetikliyor — spec'in kendi mimari-kritik uyarısı da bunu doğruluyor: karar ADR-0018'in `ContextResponse` sözleşmesini (`edges: ContextEdgeSummary[]`, "bu API'nin YALNIZCA ham grafik yapısını döner — hiçbir skorlama, sıralama veya ağırlıklandırma mantığı içermez" diye AÇIKÇA yazılmış) genişletiyor/ona paralel bir sıralama sözleşimi ekliyor, F2-T4'ün kendisiyle sınırlı kalmayıp gelecekteki her context-fabric tüketicisine (ajan bağlam çağrıları, Faz 3'ün ambient önerileri) dayatılacak bir veri-şekli/sıralama kararı. Birinci fıkra (mimari değişmezlerle gerilim) burada TETİKLENMİYOR — bu ADR-0020'nin "hassas veri sınıfları buluta ham gönderilmez" değişmeziyle doğrudan gerilim yaratan kararının aksine; skor hiçbir yerde saklanmadığından (Karar a) "tek doğruluk kaynağı olay günlüğüdür" değişmeziyle bir çelişki değil, onunla tutarlı bir ek — bu yüzden yalnızca ikinci fıkra bu ADR'yi zorunlu kılıyor.

> Bu karar setinin BÜYÜK KISMI insan onaylı geldi: spec'in kendi "Durum" satırı, Açık Soru 1'i (hesaplama zamanı — sorgu-zamanı/ephemeral) ve Açık Soru 2'yi (sunum şekli — `ContextResponse` genişletilmeden, `sort=relevance` parametresi) zaten kapatmıştı; Açık Soru 4 (hangi kenar türleri dahil) de aynı satırda kapatıldı. Açık Soru 5 (tüketici yokken şimdi mi yapılsın) da "şimdi yapılacak" kararıyla kapatıldı — bu ADR o riski icat etmiyor, spec'in kendi notuyla birlikte bilinçli kabul edilmiş bir YAGNI riski olarak burada da devralıyor. Bu ADR'nin GERÇEK açık işi yalnızca Açık Soru 3'ün (sönümleme formülü/sabiti) ve kenar-türü temel ağırlıklarının somut SAYILARI — spec'in kendisi de "architect bir sayı icat etmeyecek, ADR taslağında 2-3 somut aday sunulup insana seçtirilecek" diye bunu açıkça bu ADR'ye devretmişti.
>
> Hesaplama zamanı/yeri kararı (Karar a), `SearchService.search`'ün (ADR-0013) kanıtlanmış sorgu-zamanı ağırlıklı skorlama desenini BİREBİR yeniden kullanıyor — skor hiçbir tabloya yazılmıyor, her istekte `now()`'a göre yeniden hesaplanıyor, yeni migration/kolon yok. Sunum şekli kararı (Karar a'nın devamı) `ContextEdgeSummary` DTO'sunun ŞEKLİNİ DEĞİŞTİRMİYOR — yalnızca `edges[]` dizisinin SIRASI `sort=relevance` verildiğinde değişiyor; bu, ADR-0018'in "hiçbir skorlama içermez" kararını satır-satır ihlal etmeden, onu bir opt-in sıralama davranışıyla genişletiyor.
>
> En kritik, koddan önce kapatılması gereken karar Karar (d): `entity-entity`/`entity-person` kenarları — CLAUDE.md'nin "ilişki" ve "kimin oluşturduğu" gibi YAPISAL bağlantıları temsil eden bu iki kenar türü — skorlamaya hiç dahil edilmiyor, sıralanan 4 türün (`entity-time`/`entity-topic`/`person-topic`/`person-time`) ARDINDAN, kendi orijinal göreli sırasını koruyarak listenin sonuna ekleniyor. Bu karar, "ilgililik" kavramının doğası gereği zaman-temelli olduğu, yapısal kenarları en yükseğe koymanın bu anlamla çelişeceği gerekçesiyle insan onayında kapatıldı.

## Bağlam

`ContextService.getContext` (F2-T2, ADR-0018, `apps/server/src/context/context.service.ts`) bugün `ContextResponse = {asOf, entity, edges: ContextEdgeSummary[]}` döndürüyor. `edges[]` Postgres'in döndürdüğü ham sırada — 111-139. satırlar arasındaki döngü, `edgeRows`'u (satır 80-91'de `contextGraphEdges`'ten `workspaceId` + `fromNodeId=entityNode.id OR toNodeId=entityNode.id` ile çekilen ham satırlar) tek tek gezip `ContextEdgeSummary`'ye eşliyor (`edgeType`, `direction`, `node`, `sourceFieldKey`, `sourceRelationId`). Kritik bulgu: `edgeRows`'un her satırı zaten Drizzle `contextGraphEdges.$inferSelect`'in TAMAMINI taşıyor — yani `edge.createdAt` (kenarın son full-refresh/oluşturulma zaman damgası) internal olarak ZATEN elde mevcut, yalnızca `ContextEdgeSummary`'ye hiç eşlenmiyor/dışa hiç sızmıyor. Bu ADR'nin sıralama mantığı, hiçbir yeni sorgu eklemeden, tam olarak bu zaten-çekilmiş `edge.createdAt`/`edge.edgeType` çiftini kullanacak.

`ContextController` (`apps/server/src/context/context.controller.ts`), `GET /workspaces/:workspaceId/context/:objectId` — `SessionAuthGuard`+`WorkspaceMembershipGuard` guard stack'i, `requireRole(req)` (`req.membership?.role`, guard hiç çalışmadıysa fails-closed `ForbiddenError`) — `ExportController.requireRole`'ün AYNI kalıbı.

En yakın mimari emsal `SearchService.search` (`apps/server/src/search/search.service.ts`, ADR-0013): tamamen sorgu-zamanında (ephemeral, hiçbir yerde saklanmayan) ağırlıklı bir skor hesaplıyor (`score = KEYWORD_WEIGHT * keywordNorm + SEMANTIC_WEIGHT * cosine`, sabit ağırlıklar modül-seviyesi `const`), bellek-içi `Array.from(...).map(...)` ile skorluyor, `.sort((a,b) => b.score - a.score)` ile azalan sıraya diziyor, `.slice(0, limit)` ile kesiyor. Bu skor hiçbir kolona/tabloya yazılmıyor. Bu ADR'nin Karar (a)/(b)/(c)'si bu deseni BİREBİR devralıyor — yeni bir skorlama mimarisi icat edilmiyor.

Query-param DTO deseni için en yakın emsal `apps/server/src/objects/dto/list-objects.schema.ts`'nin `listObjectsQuerySchema`'sı — `.strict()` ile bilinmeyen anahtarları reddeden, `@Query(new ZodValidationPipe(...))` (parametre-seviyesi, `@UsePipes` DEĞİL — `SearchController`'ın da izlediği, F1-T12 PR5a'nın pipe-scoping dersiyle sabitlenmiş kural) ile uygulanan bir zod şeması.

Çözülmesi gereken merkezi sorular (spec'in Açık Soru 1/2/4/5'i insan onayıyla ÇOKTAN kapatıldı; bu ADR'nin görevi bunları kod-seviyesi bir tasarıma dökmek VE Açık Soru 3'ün somut sayılarını aday olarak sunmak): (1) hesaplama zamanı/sunum şekli; (2) sönümleme formülü/sabiti (SAYISAL — insan seçecek); (3) kenar-türü temel ağırlıkları (SAYISAL — insan seçecek); (4) `entity-entity`/`entity-person` kenarlarının skorlama-dışı konumu; (5) performans; (6) workspace izolasyonu; (7) test stratejisi.

## Karar

### (a) Hesaplama zamanı/yeri — sorgu-zamanında, ephemeral; `ContextResponse` sözleşmesi GENİŞLETİLMEDEN

`SearchService.search`'ün deseniyle tutarlı — skor hiçbir yerde saklanmaz, her `GET .../context/:objectId?sort=relevance` isteğinde `now()`'a göre yeniden hesaplanır. Yeni migration/kolon YOK. `ContextEdgeSummary` DTO'sunun ŞEKLİ DEĞİŞMEZ — skora yeni bir `relevanceScore` alanı EKLENMEZ, yalnızca `edges[]` dizisinin SIRASI, `sort=relevance` query param'ı verildiğinde skora göre (azalan) yeniden düzenlenir. Skor hesaplaması, `ContextService.getContext`'in ZATEN `edgeRows`'ta topladığı `edge.createdAt`/`edge.edgeType`'ı kullanır (dışa hiç sızdırmadan, yalnızca sıralama için) — yeni bir sorgu eklenmez.

`ContextService.getContext`, `options?: {sort?: 'relevance'}` opsiyonel bir üçüncü parametre alacak şekilde genişler; `sort` verilmezse davranış BUGÜNKÜYLE BİREBİR AYNI kalır (Postgres'in döndürdüğü ham sıra) — bu, mevcut çağrı yerlerinin (varsa) hiçbirinin kırılmayacağının kod-seviyesi garantisi.

### (b) Sönümleme formülü — üstel, 14 günlük yarı-ömür (insan onaylı, KESİN)

`ageInDays = (now.getTime() - edge.createdAt.getTime()) / 86_400_000`.

**Karar:** `factor = 0.5 ** (ageInDays / 14)` — üstel sönümleme, 14 günlük yarı-ömür. Bir hafta önceki bir kenar skorunun yaklaşık `%67`'sini, iki hafta önceki `%50`'sini, bir ay önceki `%18`'ini korur. Çoğu iş akışının "bu hafta ve geçen hafta hâlâ ilgili, bir ay önce artık arka planda" sezgisiyle en iyi eşleşen orta nokta olarak insan tarafından seçildi (Aday A'nın 7 günlük daha agresif sönümlemesine ve Aday C'nin 30 günlük doğrusal/kesin-kesim modeline karşı).

Saf, deterministik fonksiyon olarak `apps/server/src/context/relevance-scoring.ts`'e (Karar g) yazılır.

**Önemli not (implementer/security-reviewer için sabitleniyor):** `entity-topic`/`person-topic` kenarları full-refresh edildiğinden (ADR-0017 Karar d, ADR-0020 Karar h.4) `edge.createdAt` bu iki tür için "ilk oluşturulma" değil "SON değer-atanma" zamanını yansıtır — bu bir hata DEĞİL, DOĞRU davranıştır: ilgililik "bu konuya en son ne zaman değinildiği"ni ölçmeli, "ilk kez ne zaman değinildiği"ni değil. `entity-time`/`person-time` kenarları için `createdAt` gün-bucket düğümünün ilk oluşturulma zamanı (full-refresh edilmiyor, ADR-0020 Karar h.5) — iki tür arasındaki bu semantik fark bilinçli, sönümleme formülünün DIŞINDA, `getOrCreateNode`/full-refresh mekaniğinin doğal bir sonucu.

### (c) Kenar-türü temel ağırlıkları — insan onaylı, KESİN

Kabul edildi:

| Kenar türü     | Temel ağırlık | Gerekçe                                                                                                  |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `entity-time`  | `1.0`         | Temporal — nesnenin KENDİ zaman-damgalı aktivitesi; en doğrudan/güçlü sinyal.                            |
| `entity-topic` | `0.8`         | Konu-bazlı, ama hâlâ NESNENİN kendi alan değerinden türüyor — ikincil ama hâlâ doğrudan.                 |
| `person-topic` | `0.6`         | Masaüstü-sinyal-türevi (ADR-0020) — doğrudan NESNEYLE değil KİŞİYLE ilgili, dolaylı bir bağlantı.        |
| `person-time`  | `0.4`         | Aynı dolaylılık, üstüne bir de yalnızca gün-bucket'lı zaman aktivitesi (konu içermez) — en zayıf sinyal. |

`score(edge, now) = baseWeight(edge.edgeType) * dampingFactor(edge.createdAt, now)` — Karar (b)'nin seçilecek adayı ile çarpılır.

### (d) `entity-entity`/`entity-person` kenarları skorlamaya DAHİL EDİLMEZ, listenin SONUNA sabit/nötr konumda eklenir

Bu iki kenar türü YAPISAL kabul edilir — bir ilişki (`entity-entity`, `RelationCreated`) ya da `createdBy` (`entity-person`) zamanla "daha az ilgili" hale gelmez. `sort=relevance` uygulandığında: önce skorlanan 4 tür (`entity-time`/`entity-topic`/`person-topic`/`person-time`) azalan skora göre sıralanır, SONRA skorlanmayan 2 tür (`entity-entity`/`entity-person`) kendi ORİJİNAL göreli sırasını (Postgres'in döndürdüğü ham sıra, `edgeRows` içindeki index) koruyarak listenin SONUNA eklenir. Gerekçe: "ilgililik" kavramı zaten zaman-temelli; yapısal kenarları en yükseğe koymak "ilgililik" anlamıyla çelişirdi, en doğal davranış onları sıralamanın dışında tutmaktır.

### (e) Performans

`sort=relevance`, `SearchService.search` gibi bellek-içi bir sıralama — F2-T2'nin `<100ms` hedefine etkisi `object-query-performance.integration.test.ts`/ADR-0018'in performans test deseniyle (ısınma + 3-örnek-minimum + eşik) ölçülüp bu görevin kendi entegrasyon testinde kabul edilir. Öngörülen etki ihmal edilebilir — N-kenarlı bir listenin (tipik bir entity'nin komşu sayısı, ADR-0018'in zaten `<100ms` bütçesiyle doğruladığı aynı `edgeRows`) bellek-içi sıralaması ucuz, `SearchService.search`'ün `KEYWORD_CANDIDATE_LIMIT`/`SEMANTIC_CANDIDATE_LIMIT` (50) mertebesindeki adaylarla aynı büyüklük sınıfında.

### (f) Workspace izolasyonu

Yeni bir sorgu/hesaplama yüzeyi açılmıyor — mevcut `ContextService.getContext`'in ZATEN workspace-scope'lu çektiği `edgeRows` (satır 80-91, `eq(contextGraphEdges.workspaceId, workspaceId)`) üzerinde bellek-içi bir işlem; cross-workspace riski yok.

### (g) Test stratejisi

Sönümleme formülü + ağırlıklandırma, `now` enjekte edilebilir bir parametre olan saf fonksiyonlar olarak yazılır: `apps/server/src/context/relevance-scoring.ts` (yeni dosya) — `computeRelevanceScore(edgeType: string, createdAt: Date, now: Date): number | null` (skorlanmayan türler için `null` döner, Karar d'nin "sona ekle" mantığının ayırt edicisi) ve `sortEdgesByRelevance<T extends {edgeType: string; createdAt: Date}>(edges: T[], now: Date): T[]` gibi bir imza — gerçek `Date.now()`'a bağımlı olmayan, deterministik birim testler (aynı kenar + aynı `now` her zaman aynı skor/sıra).

Entegrasyon testleri (F2-T1/F2-T2 Testcontainers deseni): `sort=relevance` ile/olmadan `GET .../context/:objectId` — `sort` verilmediğinde davranış BUGÜNKÜYLE AYNI (regresyon testi), `sort=relevance` verildiğinde 4 skorlanan türün azalan sırada, `entity-entity`/`entity-person`'ın kendi orijinal sırasıyla sonda olduğu doğrulanır. Performans testi (Karar e).

## Alt-PR ayrıştırması

Kapsam spec'in kendi kararıyla TEK PR — mimari-kritik görev olduğu için CLAUDE.md'nin ±400 satır rehberliğine tabi (ADR-0018'in aynı "tek PR" kararıyla tutarlı):

- `apps/server/src/context/relevance-scoring.ts` (yeni — saf fonksiyonlar, Karar b/c/d/g).
- `apps/server/src/context/context.service.ts` (genişletme — `getContext`'e `options?: {sort?: 'relevance'}` üçüncü parametresi, Karar a).
- `apps/server/src/context/context.controller.ts` + yeni bir query DTO (ör. `apps/server/src/context/dto/get-context-query.schema.ts`, `listObjectsQuerySchema`'nın `.strict()` deseniyle, `sort` query param'ı `@Query(new ZodValidationPipe(...))` ile).
- Birim testleri (`relevance-scoring.test.ts`) + entegrasyon testleri (mevcut context entegrasyon test dosyasının genişlemesi) + performans testi.

F2-T2'nin kendi endpoint/RBAC/tazelik davranışının değiştirilmesi, herhangi bir UI tüketimi, yeni düğüm/kenar türü eklenmesi, embedding/AI-tabanlı ilgililik KAPSAM DIŞI (spec'in kendi "Kapsam DIŞI"sı korunuyor).

## Alternatifler ve Reddedilme Gerekçeleri

- **Seçenek B — periyodik ön-hesaplama, `ContextGraphSyncWorker`'ın 5 saniyelik döngüsünde `context_graph_edges`'e yeni bir `weight`/`score` kolonuna yazma.** Reddedildi — spec'in kendi Açık Soru 1 analizi: sönümleme `now()`'a bağlı olduğundan bu kolon her zaman "son senkron anına göre" bayat olurdu (grafik yapısı vs. skor için iki farklı tazelik garantisini aynı satırda karıştırır); worker'ın bugünkü sorumluluğu (yapısal projeksiyon bakımı, `ContextGraphProjection.apply`) skorlama mantığıyla karışırdı, event-fold doğasına uymazdı.
- **`ContextEdgeSummary`'ye yeni bir `relevanceScore: number` alanı eklemek.** Reddedildi — Karar (a)'ya göre; ADR-0018'in "hiçbir skorlama içermez" kararını DTO şekli seviyesinde bozardı, tek bir sözleşim/tek çağrı kazandırsa da ADR-0018'e daha invaziv bir güncelleme gerektirirdi. `sort` query param'ı aynı tek-round-trip faydasını, DTO şeklini bozmadan sağlıyor.
- **Tamamen ayrı bir `GET .../context/:objectId/relevance` endpoint'i.** Reddedildi — spec'in Açık Soru 2 analizi: iki ayrı çağrı/round-trip gerektirirdi, `sort` query param'ı tek çağrıda aynı sonucu (sıralı liste) verirken hiçbir ek endpoint/route yüzeyi açmıyor.
- **`entity-entity`/`entity-person` kenarlarını skorlamaya dahil edip en yüksek sabit ağırlıkla en üste koymak.** Reddedildi — Karar (d)'ye göre; "ilgililik" kavramı zaten zaman-temelli, yapısal kenarları en yükseğe koymak bu anlamla çelişirdi.
- **Tüketici netleşene kadar F2-T4'ü tamamen ertelemek (spec Açık Soru 5'in B seçeneği).** Reddedildi — insan kararıyla (spec'in "Durum" satırı); bilinçli kabul edilmiş bir YAGNI riski, aşağıda Sonuçlar/Ödünler'de tekrar not ediliyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- Repoda ilk kez "süresi dolan/eskiyen bir bağlantının gerçekten etkisinin azaldığı" mantığı, `UserAvailability.until`'ın (saklanıp hiç tüketilmeyen, yanlış emsal olarak kullanılmaması gereken) aksine, gerçekten TÜKETEN, test edilebilir saf fonksiyonlarla kuruluyor.
- ADR-0018'in "hiçbir skorlama içermez" kararı, `ContextResponse`'un DTO şeklini bozmadan, `sort` opt-in parametresiyle bilinçli olarak genişletiliyor — gelecekteki context-fabric tüketicileri (ajan bağlam çağrıları, Faz 3) bu `sort=relevance` sözleşimini devralabilir, kendi sıralama mantığını icat etmek zorunda kalmaz.
- `SearchService.search`'ün kanıtlanmış sorgu-zamanı ağırlıklı skorlama deseni ikinci kez kullanılıyor — yeni bir skorlama mimarisi icat edilmiyor, iki bağımsız alt-sistem (arama, bağlam) aynı desenle tutarlı kalıyor.
- `entity-topic`/`person-topic`'in full-refresh semantiğinin (`createdAt` = "son değer-atanma") sönümleme formülü için DOĞRU davranış olduğu, ayrı bir düzeltme gerektirmeden, koddan önce açıkça belgeleniyor — implementer'ın bunu bir "bug" sanıp "düzeltmeye" çalışması önleniyor.
- Yapısal kenarların (`entity-entity`/`entity-person`) sönümlenmemesi kararı (Karar d) koddan önce kapatıldı — implementer'ın bunlara rastgele bir sabit ağırlık atayıp "ilgililik" anlamını bozması riski ortadan kalktı.

**Neyi erteliyoruz / kabul ediyoruz:**

- Sönümleme formülünün/sabitinin (Karar b, 14 günlük yarı-ömürlü üstel) VE kenar-türü temel ağırlıklarının (Karar c) sayısal değerleri şu an sabit — gelecekte kullanım verisiyle ayarlanması gerekirse (ör. sönümleme çok agresif/yumuşak bulunursa), bu sayılar merkezi tek bir dosyada (`relevance-scoring.ts`) tutulduğundan değişiklik ucuz, ama YENİ bir insan onayı gerektirir (bu ADR'yi değiştirmeden sabitleri değiştirmek, CLAUDE.md'nin ADR-sözleşmesi ruhuna aykırı olur).
- Bu görevin ürettiği `sort=relevance` sözleşimini tüketecek onaylı, isimlendirilmiş bir gelecek görev yok (spec'in kendi Açık Soru 5 uyarısı) — bu, bilinçli kabul edilmiş bir YAGNI riski; insan "şimdi yapılacak" kararını zaten verdi, bu ADR o kararı yeniden tartışmıyor, yalnızca devralıyor.
- `sort` verilmediğinde davranış bugünküyle birebir aynı kalıyor (ham Postgres sırası) — `sort=relevance`'ın KENDİSİ de yalnızca bir opt-in görünüm; hiçbir mevcut çağrı yeri zorunlu bir davranış değişikliğine maruz kalmıyor.
- `person-topic`/`person-time` kenarlarının ağırlıkları (Karar c önerisi) `entity-*` kenarlarından düşük tutuluyor — bu, masaüstü sinyalinin nesneyle DOLAYLI ilişkisinin bilinçli bir yansıması; bir kullanıcı bunu "çok düşük" bulursa insan ADR onayında değiştirebilir, kod bu sayıları merkezi bir yerde (`relevance-scoring.ts`) tuttuğu için değişikliği ucuz kılıyor.
