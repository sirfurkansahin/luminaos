# ADR-0017: Bağlam Grafiği — Düğüm/Kenar Şeması, Konu Türetimi, Alan-Tipi Farkındalığı, `entity–topic` Yenileme Semantiği

**Durum:** Kabul edildi
**Tarih:** 2026-08-15
**İlgili görev:** [F2-T1 — Olaylardan Bağlam Grafiği Türetme (Varlık-Kişi-Zaman-Konu Düğümleri)](../specs/F2-E1/F2-T1-baglam-grafigi.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E1: Lumina Context Fabric" (F2-T1 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin **HER İKİ** fıkrası da bu kararı tetikliyor: (1) karar "Mimari Değişmezler"den birine **doğrudan dokunuyor** — _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_; (2) karar birden fazla göreve dayatılan bir sözleşim tanımlıyor — burada sabitlenen düğüm/kenar şeması F2-T2'nin (bağlam API'si) ve F2-T4'ün (ilgililik skorlama) üzerine kurulacağı okuma modeli.

> Bu ADR, o değişmezi kod tabanında **ilk kez somut bir şemaya döken** karardır. "Bağlam grafiği" o zamana dek CLAUDE.md'de yalnızca bir isim olarak duruyordu — hiçbir tablo, hiçbir projeksiyon onu karşılamıyordu. Spec'in kendisi (F2-T1, "Açık Sorular") dört soruyu açık bırakıyor: konu düğümü türetimi, zaman bucket granülerliği, depolama stratejisi, agent/system aktörlerin kişi düğümlerine dahil olup olmayacağı. Bu ADR bu dördünü kapatıyor. Ayrıca planlama sırasında insan onayıyla **iki yeni** karar eklendi (spec'in kendi dört sorusunun ötesinde): alan-tipi farkındalığının projeksiyonun kendi içinde, `field_definitions` tablosuna çapraz-okuma yapmadan tutulması gerektiği (bir gerçek tutarlılık riski bulgusu) ve `entity–topic` kenarlarının, `FieldValueChanged`'ın eski değeri taşımaması nedeniyle sil-sonra-ekle ile yenilenmesi gerektiği (insan plan incelemesinde yakalanan bir doğruluk açığı, kod yazılmadan önce kapatıldı).

## Bağlam

F2-T1, Faz 2'nin ("Lumina Context Fabric") ilk görevi. Event log'dan türetilen, workspace-izole bir bağlam grafiği kuruyor: varlık (`entity`), kişi (`person`), zaman (`time`), konu (`topic`) düğümleri ve aralarındaki kenarlar. Bu grafik F2-T2'nin "bu nesneyle ilgili her şey" sorgusunun ve F2-T4'ün ilgililik/sönümleme skorlamasının okuma modeli olacak — burada sabitlenen sözleşmeden sapma, o iki görevin ikisini de yeniden açar.

Keşif üç bulguyu doğruladı:

1. **Projeksiyon çatısı zaten var, yeniden icat gerekmiyor.** `packages/shared/src/events/projection.ts`'in `Projection` arayüzü (`name`, `handles`, `apply(event, tx)`, `reset(tx)`) — `objects_view`, `relations_view`, `search_index`, `field_definitions` bu çatı üzerine kurulu. Bağlam grafiği de aynı arayüzü uygulayan yeni bir `ContextGraphProjection` olmalı.
2. **`RelationsViewProjection` en yakın davranışsal emsal.** Hard-delete-on-remove semantiği (`RelationRemoved` → satırı tamamen sil, bir lifecycle kolonunu çevirmez) ve partial-unique-index üzerinde `onConflictDoNothing` (`(workspaceId, toId) WHERE kind='parentChild'`) — idempotent folding için kanıtlanmış desen, bu ADR'de daha geniş uygulanıyor.
3. **`ObjectsViewProjection` çoklu-olay-tipi dispatch ve savunmacı payload doğrulamasının en zengin örneği.** `requireStringPayloadField`/`requireNumberPayloadField` gibi yardımcılarla her payload alanı ayrı ayrı doğrulanıyor; checklist olayları read-modify-write deseniyle (`loadChecklist` → mutasyon → `UPDATE`) aynı transaction içinde çözülüyor — `context_graph_edges`'in `entity–topic` full-refresh'i (bkz. Karar d) bu deseni izliyor.

Ayrıca kritik bir yapısal bulgu: `objects_view.fieldValues` düz bir `{fieldKey: rawValue}` haritası, kolon bazında tip etiketi TAŞIMIYOR (`apps/server/src/db/schema/objects-view.ts`'in kendi doküman yorumu bunu doğruluyor). Bir `fieldKey`'in `select`/`multiSelect` olup olmadığını bilmek `field_definitions.fieldType`'a bakmayı gerektirir — ama `FieldValueChanged`'ın payload'ı yalnızca `{objectId, fieldKey, value}` (tip bilgisi yok). Bu, Karar (c)'nin doğrudan gerekçesi.

Çözülmesi gereken merkezi sorular: (1) düğüm/kenar şeması ve depolama; (2) konu düğümü nasıl türetilir; (3) alan-tipi farkındalığı nereden gelir; (4) `entity–topic` kenarları bir alan değeri değiştiğinde nasıl güncellenir; (5) zaman bucket granülerliği; (6) agent/system aktörler kişi düğümüne dahil mi; (7) bu görev tam olarak neyi kapsar (tek PR mi, servislere canlı `catchUp` kablolaması dahil mi).

## Karar

### (a) Düğüm/kenar şeması — dört düğüm, dört kenar türü, iki yeni Drizzle tablosu

Düğüm türleri:

- `entity` — bir `LuminaObject`'e 1:1, doğal anahtar `objects_view.id`.
- `person` — bir actor kimliğine 1:1, doğal anahtar `actor.id`.
- `time` — gün-granülerliğinde bir zaman bucket'ına 1:1 (bkz. Karar e).
- `topic` — bkz. Karar (b); doğal anahtar `workspaceId + fieldKey + value` (alan-bazlı konu) veya `workspaceId + objectType` (tip-bazlı konu).

Kenar türleri: `entity–entity` (`relations_view`'i yansıtır), `entity–person`, `entity–time`, `entity–topic`.

İki yeni Drizzle şeması tablosu, `context_graph_nodes` ve `context_graph_edges`, workspace-izoleli (`workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' })`, `objects-view.ts`/`relations-view.ts`'in AYNEN kullandığı kalıp). Her ikisi de:

- İçeride basılan ULID `id` PRIMARY KEY — kararlı dış referans için, `objects_view`/`relations_view` kuralıyla aynı.
- `UNIQUE(workspaceId, nodeType/edgeType, <doğal anahtar>)` kısıtı — `onConflictDoNothing`/`onConflictDoUpdate`'in idempotent folding için hedefi. `RelationsViewProjection`'ın `(workspaceId, toId) WHERE kind='parentChild'` partial-unique-index emsalinin AYNI mekanizması, daha geniş uygulanıyor.

**Gerekçe:** yeni bir idempotency mekanizması icat etmek yerine kod tabanında zaten kanıtlanmış olanı yeniden kullanmak, hem tutarlılığı hem gözden geçirilebilirliği artırıyor.

### (b) Konu (topic) düğümü türetimi — Seçenek A (kural-tabanlı), embedding YOK

Konu düğümleri yalnızca kural-tabanlı türetilir: `select`/`multiSelect` custom-field'ların HAM `value` string'i (etiket değil, opsiyonun kendi `value`'su) artı nesnenin kendi `type`'ı (task/doc/note/timeblock) konu adayı sayılır. YENİ bir AI-gateway/embedding bağımlılığı EKLENMİYOR.

**Reddedilen alternatif (Seçenek B):** `search_index`'teki embedding'lerden (ADR-0013) benzerlik kümelemesiyle otomatik konu çıkarımı. Bugün yalnızca bir `MockEmbeddingProvider` bağlı — yarım kurulu bir sisteme, henüz bütçelenmemiş yeni bir tüketici eklemek anlamına gelirdi. Ayrıca kümeleme, F2-T1'in "türetilen okuma modeli deterministik olmalı" (F0-T6 rebuild kabul kriteri) gereksinimiyle gerilimli — embedding-tabanlı kümeleme genelde parametrelere/eşiklere bağımlı, event-replay'de bit-bit aynı sonucu üretmesi ek garanti gerektirir.

**Gerekçe:** `objects_view.fieldValues` düz bir harita, per-değer tip etiketi taşımıyor (bkz. Bağlam) — bu yüzden hangi `fieldKey`'in konu-adayı olduğunu bilmek projeksiyonun kendi alan-tipi farkındalığını gerektiriyor (bkz. Karar c).

### (c) Alan-tipi farkındalığı — `field_definitions`'a ÇAPRAZ-PROJEKSİYON OKUMASI YOK, projeksiyon kendi bilgisini kendisi türetir

`ContextGraphProjection`, `apply()`/`reset()` içinde `field_definitions` tablosunu DOĞRUDAN OKUMAZ — `apply`'ın aldığı `tx` teknik olarak aynı-transaction-güvenli olsa bile.

**Gerekçe (mimari, sadece stil değil):** kod tabanındaki 9 somut projeksiyonun HER BİRİ katı biçimde yalnızca ham olaylardan türer, başka bir projeksiyonun ZATEN materyalize edilmiş tablosunu asla okumaz — çünkü projeksiyonlar BAĞIMSIZ checkpoint'ler taşır (lockstep değil). `ContextGraphProjection.apply()` içinde `field_definitions`'ı okumak, bu projeksiyonun şu an kat ettiği olaylara göre ESKİ/eksik bir görünüm gözlemleyebilir — eğer `FieldDefinitionsViewProjection`'ın kendi checkpoint'i herhangi bir nedenle geride kalmışsa (ör. bir servis `FieldDefined` olayını ekleyip `FieldDefinitionsService`'in kendi catchUp'ını hemen tetiklemiyorsa, ya da iki projeksiyon farklı çağrı zincirlerine kablolanmışsa). Bu, salt tutarlılık tercihinden çok gerçek bir staleness riski.

**Karar:** `ContextGraphProjection.handles` ayrıca `FieldDefined` ve `FieldArchived`'ı içerir — projeksiyon, sonra gelecek bir `FieldValueChanged`'ın konu-değerli olup olmadığını (`fieldType ∈ {'select','multiSelect'}`) sınıflandırmaya yetecek kendi minimal `(workspaceId, objectType, fieldKey) → fieldType` farkındalığını, TAMAMEN ham olay akışından, bağımsız olarak türetir ve saklar.

**Depolama mekanizması — implementer seviyesi detay olarak bırakılıyor:** bu ya küçük bir dahili izleme tablosu (`context_graph_field_types` benzeri) ya da konu-düğümü doğal anahtarının içine gömülü bir arama olarak kodlanabilir. TAM mekanizma implementer'a bırakılıyor; BAĞLAYICI olan mimari taahhüt şu: `ContextGraphProjection` hiçbir zaman başka bir projeksiyonun materyalize tablosunu okumaz.

### (d) `entity–topic` kenarı GÜNCELLEME semantiği — sil-sonra-ekle (full refresh), yalnızca-ekle DEĞİL

`FieldValueChanged`'ın payload'ı YALNIZCA yeni değeri taşır, eskisini asla (`{objectId, fieldKey, value}`, `oldValue` yok — doğrulandı). Her `FieldValueChanged`'da "yeni bir `entity–topic` kenarı ekle, `onConflictDoNothing`" şeklinde saf-ekleme bir uygulama, eski kenarı ASLA kaldırmaz: bir `select` alanı `"bug"`'dan `"feature"`'a değişirse, ya da bir `multiSelect` dizisinden bir değer çıkarılırsa, ESKİ `entity–topic` kenar(lar)ı sonsuza dek kalır — nesnenin gerçek konularını kalıcı olarak yanlış temsil eder (context drift). Bu, F2-T4'ün ilgililik skorlamasını besleyen AKTİF OLARAK YANLIŞ veridir — eksik veriden daha kötü.

**Karar:** `FieldValueChanged` handler'ı, değişen alanın (Karar c'ye göre) konu-değerli olduğunu belirlediğinde, önce o SPESİFİK `(entityId, fieldKey)` çifti için `context_graph_edges`'teki (KENDİ tablosu — bu bir çapraz-projeksiyon okuması DEĞİL, projeksiyonun kendi daha önce yazdığı satırları silmesi, `RelationsViewProjection`'ın `RelationRemoved` hard-delete'iyle ya da `ObjectsViewProjection`'ın checklist read-modify-write'ıyla AYNI emsal) TÜM mevcut `entity–topic` kenarlarını SİLER, SONRA yeni değer(ler) için taze kenar(lar) EKLER. Bu, o alanın konu kenarları için her değişiklikte sil-sonra-ekle (full-refresh) desenidir, ekleme-yalnızca birikim değil.

**Not:** bu karar, ilk araştırmanın değil, insan plan incelemesinin yakaladığı bir açıktı — koddan önce bir ADR inceleme sürecinin tam olarak yakalaması gereken türden ince bir doğruluk sorunu örneği.

### (e) Zaman bucket granülerliği — gün

Zaman düğümleri gün granülerliğinde bucketlanır (spec'in kendi önerisi, insan onaylı). **Gerekçe:** F2-T4'ün gelecekteki zaman-sönümleme/ilgililik-skorlama ihtiyacına göre — gün bucket'ı anlamlı bir recency-decay için yeterince ince taneli, gerçekçi kullanım ufuklarında workspace başına `time` düğüm sayısını sınırlı tutacak kadar kaba.

### (f) Depolama stratejisi — ayrı, index'lenmiş tablolar, sorgu-zamanı view/join DEĞİL

`context_graph_nodes`/`context_graph_edges` ayrı, materyalize, index'lenebilir tablolardır — `objects_view`+`relations_view` üzerine kurulu sorgu-zamanı bir view/join DEĞİL.

**Gerekçe:** F2-T2'nin (ayrı, gelecekteki bir görev) `<100ms` sorgu hedefi materyalize, bağımsız index'lenebilir depolama gerektirir. Bu aynı zamanda kurulu kuralla eşleşir: `objects_view`/`relations_view`/`search_index` HEPSİ ayrı materyalize tablolardır, hiçbiri view değildir.

### (g) Kişi düğümleri ve agent/system aktörler

`entity–person` kenarları YALNIZCA `actor.type === 'user'` için oluşturulur (bir `person` düğümü kavramsal olarak bir insanı temsil eder, otomatik bir aktörü değil). Kritik olarak, bu agent/system-tetiklemeli olayların grafikten TAMAMEN düşürüldüğü anlamına GELMEZ: `entity` ve `entity–time` düğümleri/kenarları HER olay için, aktör tipinden bağımsız olarak oluşturulur — YALNIZCA `entity–person` kenarı `user`-olmayan aktörler için atlanır.

**Gerekçe:** `agent`/`system` tipli aktörler kod tabanında ZATEN üretimde kullanılıyor — `command-parser`, `ai-gateway` `agent`-tipli aktörler olarak (`apps/server/src/objects/objects.service.ts`, `apps/server/src/commands/commands.service.ts`, `apps/server/src/ai/ai-usage.service.ts`); `workspace-creation-seed`, `doc-collab-gateway` snapshot'ı, formula-engine `system`-tipli aktörler olarak. Bu aktörlerin olaylarının entity/time katkısını tamamen düşürmek, bağlam grafiğini gerçek, zaten canlı bir workspace-aktivite dilimine kör bırakırdı (ör. AI-tetikli görev oluşturma zaman çizelgesinden tamamen kaybolurdu) — bu, bir eyleme "kişi" atfetmemekten daha kötü bir sonuç.

### (h) `handles` listesi ve kablolama kapsamı — F2-T1 TEK PR olarak sevk edilir, servis kablolaması DEĞİL

`ContextGraphProjection.handles` açık bir listedir (`['*']` DEĞİL — `ObjectsViewProjection`'ın kendi kuralıyla eşleşir; `projection.ts`'in kendi doküman yorumuna göre wildcard daha çok workspace-agnostik/örnek projeksiyonlar için düşünülmüş):

- `ObjectCreated`, `ObjectSoftDeleted`, `ObjectRestored` — entity düğümü yaşam döngüsü (soft-deleted → entity düğümünü VE kenarlarını hard-delete et, `RelationsViewProjection`'ın hard-delete-on-remove felsefesini yansıtarak grafiğin yalnızca "aktif" bağlamı yansıtması sağlanır; restored → yeniden oluştur).
- `RelationCreated`/`RelationRemoved` — entity–entity kenarları, `RelationsViewProjection`'ın dinlediği AYNI ham olaylara DOĞRUDAN abone olunarak (`relations_view`'i OKUMADAN — Karar c'nin aynı çapraz-projeksiyon-okuması-yok disiplini).
- `FieldDefined`/`FieldArchived` — dahili alan-tipi farkındalığı (Karar c).
- `FieldValueChanged` — entity–topic kenarları (Karar b/d).

**Kapsam sınırı (insan onaylı, ikinci yeni karar):** F2-T1'in kendi PR'ı YALNIZCA `ContextGraphProjection` sınıfını + iki yeni Drizzle şema tablosunu + testleri sevk eder — `ObjectsService`/`RelationsService`/`FieldDefinitionsService`'in yazma yollarına HİÇBİR DEĞİŞİKLİK yapmaz (o servislerin post-append akışlarına yeni bir `catchUp` çağrısı kablolanmaz). Projeksiyon tam işlevsel ve bağımsız test edilebilir (testler `projectionRunner.catchUp(contextGraphProjection)`'ı, normal servis API'leriyle düzenlenen olaylardan sonra doğrudan çağırır), ama üretimde her yazmada otomatik güncellenen "canlı" bir okuma modeli DEĞİLDİR henüz — mevcut servislerin yazma yollarına kablolamak açıkça F2-T2'ye (bağlam-sorgu API görevi) ya da ayrı bir takip görevine ERTELENİR, çünkü yalnızca kullanıcıya-dönük bir okuma yolu read-your-writes tazeliğine gerçekten ihtiyaç duyar ve F2-T1'in kendi kabul kriterleri (şema var, doğru kat ediyor, rebuild deterministik) canlı kablolama gerektirmiyor.

**Gerekçe:** bu, F2-T1'in PR'ını odaklı ve mimari-kritik bir görev için CLAUDE.md'nin ±400 satır rehberliğine uygun tutuyor; hiçbir tüketicinin henüz talep etmediği bir fayda (canlı güncelleme) için N mevcut servis dosyasına dokunmaktan kaçınıyor; spec'in kendi "Kapsam DIŞI"nın F2-T2'nin sorgu API'sini zaten hariç tutmasının doğal bir uzantısı.

## Alt-PR ayrıştırması

Karar (h) F2-T1'in TEK PR olarak sevk edildiğini doğruladığından, bu bölüm kısa: tek PR, içeriği —

- `apps/server/src/db/schema/context-graph-nodes.ts` + `context-graph-edges.ts` (yeni Drizzle tabloları).
- `apps/server/src/context/context-graph.projection.ts` (yeni `ContextGraphProjection`; implementer'a ad/konum serbestliği bırakılır, ama kodun oturduğu `apps/server/src/<özellik>/` kuralına uygun yeni bir `apps/server/src/context/` dizini önerilir).
- Yeni bir entegrasyon test dosyası — `projection-rebuild.integration.test.ts`'in yapısını klonlayarak rebuild-determinizm kabul kriteri için, artı spec'in kabul kriterlerine göre entity/person/time/topic düğüm+kenar oluşturma testleri.

## Alternatifler ve Reddedilme Gerekçeleri

- **Seçenek B (embedding-tabanlı konu kümeleme).** v1 için reddedildi — Karar (b)'ye göre; `EmbeddingProvider`'a henüz bütçelenmemiş yeni bir tüketici ekler, deterministik rebuild garantisiyle gerilimli.
- **`field_definitions`'ı doğrudan `ContextGraphProjection.apply()`'dan okumak.** Reddedildi — Karar (c)'ye göre; gerçek bir staleness riski, salt bir stil tercihi değil.
- **Yalnızca-ekle `entity–topic` kenarları (sil-sonra-ekle yenileme olmadan).** Reddedildi — Karar (d)'ye göre; alan-değeri değişikliklerinde kalıcı context drift'e yol açardı.
- **`objects_view`+`relations_view` üzerine sorgu-zamanı view.** Reddedildi — Karar (f)'ye göre; F2-T2'nin gelecekteki gecikme hedefini karşılamıyor ve yerleşik materyalize-tablo kuralından sapıyor.
- **`agent`/`system` aktörleri `person` düğümü olarak dahil etmek.** Reddedildi — Karar (g)'ye göre; otomatik eylemleri insan kimliğiyle karıştırır; seçilen orta yol (entity/time katkısını korumak, yalnızca kişi kenarını atlamak) hepsi-ya-da-hiçbiri dahil/hariç yerine tercih edildi.
- **`catchUp`'ı mevcut servislerin yazma yollarına F2-T1'in bir parçası olarak kablolamak.** Bu görev için reddedildi — Karar (h)'ye göre; F2-T2'ye/bir takip göreve ertelendi, PR'ı uygun kapsamda tutmak için.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- "Bağlam grafiği türetilir, yazılmaz" değişmezi ilk kez somut, test edilebilir bir şemaya kavuşuyor.
- F2-T2/F2-T4, üzerine inşa edecekleri kararlı bir düğüm/kenar sözleşmesi devralıyor.
- Gerçek bir doğruluk hatası (kalıcı `entity–topic` context drift) kod yazılmadan önce, ADR incelemesi sırasında yakalanıp önleniyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- v1'de embedding-tabanlı konu zekası yok (yalnızca kural-tabanlı).
- Grafik henüz "canlı" değil — F2-T2/bir takip görev `catchUp` çağrılarını kablolayana kadar hiçbir üretim yazma yolu onu beslemiyor.
- Agent/system-tetiklemeli aktivite entity/time bağlamına katkıda bulunuyor ama kişi atfı yok.
- F2-T2'nin sorgu API'si, F2-T3'ün masaüstü sinyal toplayıcıları ve F2-T4'ün ilgililik/sönümleme skorlaması bu ADR'nin kapsamı dışında kalmaya devam ediyor (spec'in kendi Kapsam DIŞI'sı değişmedi).
- FieldArchived, o alandan türetilmiş birikmiş entity–topic kenarlarını temizlemiyor (Karar (d)'nin FieldValueChanged için yaptığı sil-sonra-ekle yenilemesinin arşivleme eşdeğeri yok) — düşük etkili, bilinçli kabul edilmiş bir sınır; alan arşivlendiğinde yeni FieldValueChanged gelmeyeceği için aktif context drift üretmez, yalnızca statik kalıntı bırakır.
