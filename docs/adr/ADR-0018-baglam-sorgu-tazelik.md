# ADR-0018: Bağlam Sorgu API'si — Tazelik Stratejisi, RBAC Kapsamı, Endpoint Sözleşmesi

**Durum:** Kabul edildi
**Tarih:** 2026-08-15
**İlgili görev:** [F2-T2 — Bağlam API'si: "Bu Nesneyle İlgili Her Şey" Sorgusu (<100ms, İzin Süzgeçli)](../specs/F2-E1/F2-T2-baglam-sorgu-api.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E1: Lumina Context Fabric" (F2-T2 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin öncelikle **(2)** fıkrası bu kararı tetikliyor — burada sabitlenen tazelik sözleşimi ve yanıt DTO'su F2-T4'e (ilgililik skorlama) ve gelecekteki F3 ajan-bağlam sorgularına dayatılan bir kontrat. Karar ikincil olarak **(1)** fıkrasıyla da geriliyor: CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir" değişmezi bugüne dek hiçbir projeksiyon için "ne kadar güncel" sorusuna somut bir cevap vermemişti (her biri örtük "yazma yolunda `catchUp` çağrılır" varsayımıyla yürüdü) — bu ADR, F2-T1'in ADR-0017 Karar (h) ile bilinçli olarak kablosuz bıraktığı `ContextGraphProjection` için o boşluğu ilk kez somut, ölçülebilir bir SLA'ya (`asOf`) bağlıyor.

> F2-T1'in ürettiği bağlam grafiği (ADR-0017) üretimde "canlı" değildi: hiçbir servis `catchUp` çağırmıyordu. F2-T2'nin sorgu API'si bu boşluğu kapatmak zorunda ve spec'in kendi Açık Soru 1'i üç seçeneği (canlı kablolama, sorgu-zamanı senkron `catchUp`, zamanlanmış arka plan worker) insan onayına sundu. Bu ADR Seçenek C'yi (zamanlanmış worker) seçiyor — gerekçesi salt tercih değil, ölçülebilir bir performans-izolasyon riski: `ProjectionRunner.catchUp`'ın kilidi ve checkpoint'i projeksiyon-adı bazlı, workspace bazlı değil, bu yüzden sorgu-zamanı senkron çağrı tüm workspace'leri TEK bir global advisory lock'a sokardı.
>
> Karar ayrıca RBAC kapsamını (yalnızca alan-düzeyi, obje-varlık-düzeyi gizleme yok) ADR-0016'nın export kararıyla tutarlı tutuyor, ve plan incelemesinde insan tarafından yakalanan kritik bir sızıntıyı — kök entity'nin KENDİ `entity–topic` kenarlarının, komşu düğüm özetleri `fieldValues` taşımasa bile, gizli bir alanın ham değerini ikinci bir yoldan sızdırabilmesi — koddan önce kapatıyor. Son olarak endpoint/sorgu/yanıt şeklini sabitliyor ve index yeterliliğini implementer seviyesine bırakıyor.
>
> Bu ADR, F2-T1'in bıraktığı "grafik türetilir ama henüz beslenmiyor" durumunu ilk kez somut bir tazelik sözleşimine kavuşturan karar — F2-T4'ün ve F3'ün bağlam okumaları bundan sonra bu sözleşime göre tasarlanacak.

## Bağlam

F2-T2, F2-T1'in ürettiği `context_graph_nodes`/`context_graph_edges` (ADR-0017) üzerine, tek bir Lumina Object için "bu nesneyle ilgili her şey" sorusuna cevap veren, RBAC süzgeçli, `<100ms` gecikmeli bir okuma API'si kuruyor. ADR-0017 Karar (h) bilinçli olarak `ContextGraphProjection`'ı hiçbir servisin yazma yoluna kablolamadan bıraktı — projeksiyon test edilebilir ve doğru ama "canlı" değil. F2-T2 bu boşluğu ya (A) N mevcut servise `catchUp` ekleyerek, ya (B) sorgu-zamanı senkron `catchUp` ile, ya da (C) zamanlanmış arka plan senkronizasyonuyla kapatmak zorunda — spec'in kendisi bu üçünü açık soru olarak bıraktı ve mimari-kritik olarak işaretledi.

Keşif üç bulguyu doğruladı:

1. **`ProjectionRunner.catchUp`'ın kilidi/checkpoint'i projeksiyon-adı bazlı, workspace bazlı DEĞİL.** `projection-runner.service.ts`'in `catchUp` metodu `pg_advisory_xact_lock(hashtext(projection.name)::bigint)` ile TEK bir projeksiyon adı üzerinden kilitliyor; `projection_checkpoints` tablosu da `projectionName` PRIMARY KEY (workspace kolonu yok). Seçenek B (sorgu-zamanı senkron `catchUp`) seçilseydi, HERHANGİ bir workspace'in context-API isteği, TÜM workspace'lerin `catchUp`'ını aynı global kilide sokardı — bir workspace'in yoğun yazma trafiği, tamamen ilgisiz başka bir workspace'in context-sorgu gecikmesini bozabilirdi.
2. **`CalendarSyncPollerService` (`apps/server/src/calendar/calendar-sync-poller.service.ts`), zamanlanmış arka plan worker deseninin kod tabanındaki hazır emsali.** `OnModuleInit`/`OnModuleDestroy` ile `setInterval` kurup söküyor, genel (public) bir `pollOnce()` metodu taşıyor (testin gerçek interval'i beklemeden doğrudan çağırabilmesi için), ve bir hesabın hatasının diğerini etkilememesi için döngü içi `try/catch` kullanıyor. Bu desen, F2-T2'nin worker'ı için birebir kopyalanabilir bir kalıp.
3. **`projection_checkpoints.updatedAt` zaten var ve her `catchUp` sonunda güncelleniyor.** `ProjectionRunner.writeCheckpoint`, her `catchUp` çağrısının SONUNDA (batch boş dönse bile — ilk `readCheckpoint` sonrası en az bir `writeCheckpoint` her zaman aynı transaction içinde çalışır) `projection_checkpoints` satırını `onConflictDoUpdate` ile `updatedAt: new Date()` olarak yeniden yazıyor. Bu, `context-graph` projeksiyonu için ölçülebilir bir "en son ne zaman güncellendi" zaman damgası — yeni bir migration/kolon gerektirmiyor.

Ayrıca `ObjectsService.filterFieldValuesForRole` (`apps/server/src/objects/objects.service.ts:1386`) ve `canViewField` (`packages/core-objects/src/fields/field-permissions.ts:19`) incelendi: filtreleme SADECE `fieldValues` haritasındaki anahtarları, `FieldDefinition.permissions[callerRole] === 'hidden'` olduğunda düşürüyor — obje varlığının kendisini (kimlik, başlık, tip) hiçbir zaman gizlemiyor. F2-T2'nin RBAC kapsamı bu mevcut mekanizmayla tutarlı kalmalı, yeni bir kavram icat etmemeli (ADR-0016'nın export kararıyla ve CLAUDE.md'nin "veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" değişmeziyle aynı çizgide).

Çözülmesi gereken merkezi sorular: (1) tazelik stratejisi; (2) RBAC'ın komşu düğümlere ne kadar derin uygulanacağı ve kök entity'nin kendi kenarlarının sızıntı riski taşıyıp taşımadığı; (3) endpoint/sorgu şekli/yanıt DTO'su; (4) index yeterliliği.

## Karar

### (a) Tazelik stratejisi — Seçenek C (zamanlanmış arka plan worker), Seçenek A/B REDDEDİLDİ

`ProjectionRunner.catchUp`'ın kilidi (`pg_advisory_xact_lock`) ve checkpoint'i PROJEKSİYON-ADI bazlı, workspace bazlı DEĞİL. Seçenek B (sorgu-zamanı senkron `catchUp`) seçilseydi, her context-API isteği TÜM workspace'lerin olaylarını tarayan TEK bir global advisory lock'a girerdi — aktif bir workspace'in yüksek yazma trafiği, tamamen ilgisiz başka bir workspace'in context-sorgu gecikmesini bozardı (noisy-neighbor riski). Bu, tam olarak ADR-0017'nin "ayrı materyalize tablo, sorgu-zamanı view değil" kararının (Karar f) önlemeye çalıştığı türden bir performans-izolasyon riski — iki karar aynı endişeyi paylaşıyor. Seçenek A (canlı kablolama, N mevcut servise `catchUp` çağrısı ekleme) de reddedildi çünkü N dosyaya dokunmak regresyon riskini büyütüyor ve context grafiği okuma-kendi-yazdığını-okuma (read-your-writes) tazeliği gerektirmeyen ikincil/advisory bir veri modeli — `search_index`'in (ADR-0013) zaten kabul ettiği tazelik toleransıyla aynı sınıfta.

**Karar:** `ContextGraphSyncWorker` (yeni, `apps/server/src/context/context-graph-sync.worker.ts`) — `CalendarSyncPollerService`'in (`apps/server/src/calendar/calendar-sync-poller.service.ts`) BİREBİR aynı deseni: `OnModuleInit`/`OnModuleDestroy`, `setInterval`, genel (public) `async syncOnce()` metodu (testin doğrudan çağırabilmesi için gerçek interval'i beklemeden). `SYNC_INTERVAL_MS = 5_000` (5 saniye) — `CalendarSyncPollerService`'in 5 DAKİKALIK aralığından kasıtlı olarak farklı, çünkü o dış üçüncü-taraf API rate-limit'ine bağlı bir senkronizasyon, bu ise ucuz bir iç DB-to-DB `catchUp` çağrısı.

API yanıtı `asOf` (ISO8601 zaman damgası) alanı taşır — ölçülebilir bir tazelik SLA'sı, belirsiz "gecikmeli olabilir" değil. Kaynak: `projection_checkpoints.updatedAt` kolonu (`projectionName='context-graph'`), zaten var, `ProjectionRunner.writeCheckpoint` her `catchUp` sonunda günceller — YENİ migration/kolon GEREKMİYOR.

Eşzamanlı-tetikleme/debounce endişesi (F2-T2 spec'inin Açık Soru 4'ü) Seçenek C ile kendiliğinden çözülüyor: worker sorgu trafiğinden bağımsız sabit aralıkla çalışıyor, sorgu hacmi `catchUp` çağrı sıklığını etkilemiyor; `ProjectionRunner.catchUp`'ın zaten var olan advisory-lock'u, yatay ölçeklenmede birden fazla worker instance'ının olası eşzamanlı çalışmalarını da güvenle serileştiriyor (F0-T6'dan miras, yeni kod gerekmiyor) — bu ADR'de yeni bir mekanizma İCAT EDİLMİYOR, mevcut garanti NOT ediliyor.

### (b) RBAC kapsamı — yalnızca alan-düzeyi, YENİ bir obje-varlık-düzeyi gizleme kavramı YOK

Kök (`objectId` ile sorgulanan) entity'nin `fieldValues`'ı mevcut `ObjectsService.filterFieldValuesForRole` mantığıyla filtrelenir (aynı `FieldDefinition.permissions[callerRole]` kontrolü, `canViewField`). Komşu `entity` düğümleri yalnızca hafif bir özet taşır (`entityId`, `objectType`, `title`) — `fieldValues` TAŞIMAZ.

**Gerekçe:** performans — N komşu için ayrı ayrı `field_definitions` + rol kontrolü `<100ms` bütçesini zorlar; `title` zaten üst-düzey bir kolon, alan-bazlı RBAC kapsamında değil; istemci tam detay isterse mevcut `GET .../objects/:objectId`'i ayrıca çağırabilir. Bu, obje-varlık düzeyinde hiçbir yeni gizleme kavramı icat etmeyen, mevcut modelin doğal bir uzantısı — ADR-0016'nın export kararıyla ve CLAUDE.md'nin "veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" değişmeziyle tutarlı.

### (c) KRİTİK sızıntı düzeltmesi (insan bulgusu, plan incelemesinde yakalandı, koddan önce kapatıldı)

Kök entity'nin KENDİ `entity–topic` kenarları da rol-bazlı filtrelenmeli. **Gerekçe:** `topic` düğümünün doğal anahtarı (ADR-0017 Karar a) kaynak alanın HAM değerini taşıyor (`naturalKey` = değerin kendisi, alan-bazlı topic'lerde `sourceFieldKey` ile birlikte). Kök entity'nin `fieldValues`'ı role göre filtrelense bile (ör. `status` alanı `guest` için `hidden`), yanıttaki `edges` dizisinde kök entity'ye ait bir `entity–topic` kenarı AYNI değeri (`sourceFieldKey='status'` + hedef topic düğümünün `naturalKey`'i) İKİNCİ, DENETLENMEMİŞ bir yoldan sızdırabilir — "komşu düğüm özeti `fieldValues` taşımaz" kararı (Karar b) bunu KAPATMAZ, çünkü sorun komşu düğümlerde değil kök entity'nin KENDİ kenarlarında.

**Karar:** `ContextService`, kök entity'nin `entity–topic` kenarlarını yanıta eklemeden ÖNCE her kenarın `sourceFieldKey`'ini (varsa) `filterFieldValuesForRole`'un aynı `permissions[callerRole]==='hidden'` kontrolüyle süzer — gizliyse o kenar TAMAMEN çıkarılır. Tip-bazlı `entity–topic` kenarları (`sourceFieldKey=NULL`, `ObjectCreated`'dan gelen `objectType` konusu) bu filtrelemeye tabi DEĞİL (`objectType` zaten üst-düzey kolon).

### (d) Endpoint/sorgu şekli/yanıt DTO'su

`GET /workspaces/:workspaceId/context/:objectId`, `SessionAuthGuard`+`WorkspaceMembershipGuard`, `requireRole(req)` deseni (`ExportController.requireRole`'den — `req.membership?.role`, guard hiç çalışmadıysa fails closed `ForbiddenError`).

Sorgu akışı: `objectId` → entity node (`contextGraphNodes`'ta `workspaceId` + `nodeType='entity'` + `naturalKey=objectId` ile unique-index lookup) → `context_graph_edges` (`workspaceId` + `fromNodeId=entityNode.id` OR `toNodeId=entityNode.id`) → karşı düğümleri (`context_graph_nodes`) topluca çöz.

Yanıt: `{ asOf, entity: {entityId,objectType,title,fieldValues}, edges: [{edgeType, direction, node:{nodeType,naturalKey,entityId?,objectType?,title?}, sourceFieldKey?, sourceRelationId?}] }`. `direction` alanı (`outgoing`/`incoming`), kök entity `fromNodeId` mi yoksa `toNodeId` mi olduğunu ayırt eder — `entity-entity` kenarları (RelationCreated) her iki yönde de oluşabildiği için (kaynak: `context-graph.projection.ts`'in `RelationCreated` işleyicisi, `fromEntity`/`toEntity` sırasıyla `fromId`/`toId`'yi yansıtıyor) tüketicinin ilişkinin yönünü kaybetmeden okuyabilmesi gerekiyor.

Var olmayan/başka workspace'e ait `objectId` → `NotFoundError` (`packages/shared/errors`), `ObjectsService.lookupStreamId`'nin aynı desenini izleyerek.

### (e) Index yeterliliği — implementer-seviyesi karar

Mevcut tekil `fromNodeId`/`toNodeId` index'leri (`context_graph_edges_from_node_id_idx`, `context_graph_edges_to_node_id_idx`) performans testiyle yetersiz çıkarsa, bu görevin kendi migration'ında `(workspaceId, fromNodeId)`/`(workspaceId, toNodeId)` kompozit index eklenir. Bu ADR bunu bir mimari kısıt olarak DEĞİL, açık bir implementer kararı olarak NOT eder — `<100ms` hedefinin nasıl karşılanacağı (mevcut index'lerle mi, yeni kompozit index'lerle mi) `object-query-performance.integration.test.ts` desenindeki entegrasyon testiyle belirlenecek, ADR onayı beklemeyecek.

## Alt-PR ayrıştırması

Tek PR — mimari-kritik görev olduğu için CLAUDE.md'nin ±400 satır rehberliğine tabi:

- `apps/server/src/context/context-graph-sync.worker.ts` (yeni `ContextGraphSyncWorker`, Karar a).
- `apps/server/src/context/context.controller.ts` (yeni `ContextController`, Karar d).
- `apps/server/src/context/context.service.ts` (yeni `ContextService` — entity lookup, komşu düğüm/kenar çözümleme, RBAC filtreleme Karar b/c, `asOf` okuma).
- `apps/server/src/context/context.module.ts` (yeni modül kablolaması).
- Gerekirse (Karar e) `(workspaceId, fromNodeId)`/`(workspaceId, toNodeId)` kompozit index migration'ı.
- Entegrasyon testleri: davranış testleri (4 düğüm/4 kenar türünün tamamı, her rol için RBAC filtreleme, Karar c'nin sızıntı senaryosu, cross-workspace izolasyon, `NotFoundError` yolu), worker testi (`syncOnce()`'ı doğrudan çağırıp `asOf`'un ilerlediğini doğrulayan), performans testi (`object-query-performance.integration.test.ts` deseni: ısınma + 3-örnek-minimum + `<100ms` eşik).

F2-T3 (masaüstü sinyal toplayıcılar), F2-T4 (ilgililik skorlama), çok-hop grafik gezinme ve yeni düğüm/kenar türü eklenmesi KAPSAM DIŞI (ADR-0017'nin ve F2-T2 spec'inin kendi disiplini korunuyor).

## Alternatifler ve Reddedilme Gerekçeleri

- **Seçenek A (canlı kablolama — N mevcut servise `catchUp` ekleme).** Reddedildi — Karar (a)'ya göre; `ObjectsService`/`RelationsService`/`FieldDefinitionsService` gibi N dosyaya dokunmak regresyon riskini büyütüyor, ve context grafiği read-your-writes tazeliği gerektirmeyen ikincil bir veri modeli.
- **Seçenek B (sorgu-zamanı senkron `catchUp`).** Reddedildi — Karar (a)'ya göre; `ProjectionRunner.catchUp`'ın projeksiyon-adı bazlı (workspace bazlı değil) global advisory lock'u nedeniyle noisy-neighbor riski taşıyor, ADR-0017 Karar (f)'nin önlemeye çalıştığı performans-izolasyon endişesiyle aynı sınıfta.
- **Obje-varlık-düzeyinde yeni bir RBAC gizleme kavramı (komşu entity düğümlerinin kendisini role göre tamamen gizlemek).** Reddedildi — Karar (b)'ye göre; bugün hiçbir yerde olmayan yeni bir kavram, ADR-0016'nın export kararıyla ve "veri dışa aktarma kısıtlanamaz" değişmeziyle gerilim yaratırdı; mevcut alan-düzeyi model yeterli.
- **Yalnızca komşu düğüm özetlerini `fieldValues`'sız bırakıp kök entity'nin kendi `entity–topic` kenarlarını filtrelemeden geçirmek.** Reddedildi — Karar (c)'ye göre; bu, gizli bir alanın ham değerini `edges` dizisi üzerinden ikinci, denetlenmemiş bir yoldan sızdırırdı; plan incelemesinde insan tarafından yakalandı, koddan önce kapatıldı.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- İlk kez bir projeksiyonun tazelik garantisi, belirsiz "gecikmeli olabilir" yerine ölçülebilir bir API alanına (`asOf`) bağlanıyor — F2-T4'ün ve F3'ün gelecekteki bağlam okumaları bu sözleşimi devralıyor.
- Noisy-neighbor riski, mevcut `ProjectionRunner.catchUp`'ın projeksiyon-adı bazlı global kilidi tam olarak anlaşılıp Seçenek B yerine Seçenek C seçilerek koddan önce önleniyor.
- `CalendarSyncPollerService`'in kanıtlanmış worker deseni yeniden kullanılıyor — yeni bir yaşam-döngüsü/hata-izolasyon mekanizması icat edilmiyor.
- Gerçek bir RBAC sızıntısı (kök entity'nin kendi `entity–topic` kenarları üzerinden gizli alan değeri ifşası) kod yazılmadan önce, ADR incelemesi sırasında yakalanıp kapatılıyor.
- Mevcut advisory-lock garantisi (F0-T6'dan miras) yatay ölçeklenmede birden fazla worker instance'ı için de geçerliliğini koruyor — yeni bir eşzamanlılık mekanizması gerekmiyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- Context API en fazla `SYNC_INTERVAL_MS` (5 saniye) kadar gecikmeli olabilir — read-your-writes garantisi YOK (bir nesne az önce oluşturulduysa, worker'ın bir sonraki `syncOnce()`'ına kadar context sorgusunda görünmeyebilir). Bu, CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür" değişmeziyle teknik olarak tutarlı ama sürpriz yaratabilecek, bilinçli kabul edilmiş bir sınır.
- Obje-varlık düzeyinde yeni bir RBAC gizleme kavramı yok — bir kullanıcının erişemeyeceği bir nesnenin varlığı (kimlik/başlık/tip) context sorgusunda görünür kalabilir, yalnızca alan değerleri gizlenir.
- Çok-hop grafik gezinme (2+ hop) ve yeni düğüm/kenar türleri bu görevin kapsamı dışında kalmaya devam ediyor — ADR-0017'nin kendi kapsam disiplini korunuyor.
- Index yeterliliği (Karar e) bu ADR'de bağlayıcı olarak sabitlenmedi — implementer'ın performans testine bırakıldı; test eşiği aşılırsa migration eklenecek, aşılmazsa mevcut tekil index'ler yeterli sayılacak.
- ADR-0017'nin kabul ettiği FieldArchived kalıntı `entity–topic` kenarı sınırı (arşivlenen alanlardan türetilmiş kenarların temizlenmemesi) bu ADR'de değişmiyor, miras kalıyor.
