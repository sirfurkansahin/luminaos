# F2-T1 — Olaylardan Bağlam Grafiği Türetme (Varlık-Kişi-Zaman-Konu Düğümleri)

**Epik:** F2-E1 (Lumina Context Fabric) · **Durum:** Tamamlandı — ADR-0017 (#117), implementasyon PR (bkz. commit geçmişi)
**Bağımlılık:** F0-T6 (event store + projeksiyon çatısı), F1-T1 (varlık tipi kayıt defteri), F1-T3 (ilişki sistemi), F1-T13 (arama/embedding altyapısı — bkz. Açık Sorular)

> ⚠️ MİMARİ-KRİTİK GÖREV: Bu görev, Faz 2'nin ilk görevi olarak CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir" değişmezini ilk kez somut bir şemaya döker. Burada tanımlanan düğüm/kenar sözleşmesi F2-T2 (bağlam API'si) ve F2-T4'e (ilgililik skorlama) dayatılacak. CLAUDE.md'nin ADR kriteri (b)'ye göre ADR gerekir — architect subagent ile yazılıp insan onayından önce kod yazılmamalı.

## Amaç

Event log'dan (F0-T6) türetilen, workspace-izole bir **bağlam grafiği** kurmak: varlık (object), kişi (person/actor), zaman (time) ve konu (topic) düğümleri ile aralarındaki kenarlar. Bu grafik, F2-T2'nin "bu nesneyle ilgili her şey" sorgusunun ve F2-T4'ün ilgililik skorlamasının okuma modelidir.

## Mevcut Durum

- **Event store + projeksiyon çatısı** (F0-T6): `Projection` arayüzü (`handles[]`, `apply(event)`), checkpoint takibi, `rebuild` komutu — `objects_view`, `relations_view`, `search_index` bu çatı üzerine kurulu. Bağlam grafiği de aynı çatıyı kullanmalı, yeni bir projeksiyon mekanizması icat edilmemeli.
- **`objects_view`** (`apps/server/src/db/schema/objects-view.ts`): her Lumina Object için tek satır — `id` (ULID), `type`, `workspaceId`, `title`, `createdBy`, `createdAt`/`updatedAt`, `lifecycle`, `fieldValues` (jsonb, select/multiSelect dahil custom alanlar).
- **`relations_view`** (`apps/server/src/db/schema/relations-view.ts`): `fromId`/`toId`/`kind` (`parentChild|reference|dependency|recurrenceOf|blocks-time-for`) — varlık-varlık kenarlarının zaten var olan kaynağı.
- **`actor` şeması** (`packages/shared/src/events/domain-event.ts`): `{type: 'user'|'agent'|'system', id}` — kişi düğümlerinin ham kaynağı, ama bilinçli olarak minimal (zengin ajan-aksiyon sözleşmesi ADR-0015 ile yalnızca `ActionsProposed`/`ActionsDecided` payload'ında var, ortak zarfa dokunmuyor).
- **Konu/embedding altyapısı** (ADR-0013, F1-T13): `EmbeddingProvider` soyutlaması + `search_index` (`real[]` kolon, Node içi brute-force cosine — pgvector reddedildi). `AIProvider`'dan ayrı tutuluyor. Bu görev için doğrudan yeniden kullanılabilir bir "konu" kavramı YOK — `search_index` benzerlik için var, kümeleme/etiketleme için değil.
- Faz 1 tamamen bitti (F1-T18 ile); bu, Faz 2'nin ve Context Fabric epiğinin ilk görevi.

## Kapsam

1. **Düğüm/kenar şeması (sözleşim, ADR'de sabitlenir):**
   - Düğüm türleri: `entity` (bir Lumina Object'e 1:1), `person` (bir actor kimliğine 1:1), `time` (bir zaman aralığı bucket'ına 1:1), `topic` (bkz. Açık Soru 1).
   - Kenar türleri: `entity–entity` (relations_view'dan miras), `entity–person` (`createdBy` + olay `actor`'larından türetilen "ilişkili kişi"), `entity–time` (nesnenin/olayın zaman bucket'ı), `entity–topic` (bkz. Açık Soru 1).
2. **`context_graph_nodes` / `context_graph_edges` projeksiyonları:** F0-T6 `Projection` arayüzü kullanılarak, workspace-izoleli yeni tablolar. `rebuild` ile sıfırdan aynı sonucu üretmesi F0-T6 kabul kriteriyle tutarlı şekilde zorunlu.
3. **Varlık düğümleri:** `ObjectCreated`/`ObjectUpdated`/`ObjectDeleted` olaylarından türetilir; `objects_view`'i tekrarlamaz, ona referans taşır (`entityId` = `objects_view.id`).
4. **Kişi düğümleri:** olay `actor`'larından ve `createdBy`'dan türetilir (Açık Soru 4: agent aktörler dahil mi).
5. **Zaman düğümleri:** olay `occurredAt`'ından bucket'lanır (Açık Soru 2: granülerlik).
6. **Konu düğümleri:** Açık Soru 1'e bağlı — v1 kural-tabanlı öneri: yalnızca `select`/`multiSelect` custom-field değerleri + nesne `type`'ı, YENİ bir AI-gateway/embedding bağımlılığı EKLEMEDEN.
7. **Workspace izolasyonu:** her düğüm/kenar `workspaceId` taşır; tüm sorgular bununla süzülür (mevcut `objects_view`/`relations_view` deseniyle tutarlı).
8. **ADR:** `architect` subagent ile `docs/adr/ADR-0017-baglam-grafigi.md` — düğüm/kenar şeması, konu türetme yaklaşımı, depolama stratejisi (ayrı tablo vs. sorgu-zamanı join) insan onayından önce yazılır.

## Kapsam DIŞI

- **F2-T2** (bağlam API'si, `<100ms` sorgu, izin süzgeci) — bu görev yalnızca okuma modelini kurar, sorgu endpoint'i ayrı görev.
- **F2-T3** (masaüstü sinyal toplayıcılar — takvim durumu, aktif pencere başlığı) — açık rıza + yerinde işleme gerektiren ayrı görev, bu görevin ürettiği grafiğe girdi sağlayacak ama burada YOK.
- **F2-T4** (ilgililik skorlama + zaman aşımıyla sönümleme) — bu görevin ürettiği `entity–time`/`entity–topic` kenarlarını kullanacak ayrı görev.
- Embedding/LLM tabanlı konu çıkarımı (NLP kümeleme, otomatik etiketleme) — v1 kural-tabanlı kalır (bkz. Açık Soru 1); gelecekte ai-gateway ile zenginleştirme ayrı görev.
- Kişi düğümlerinin workspace-dışı (ör. dış e-posta gönderenleri) kimliklerle zenginleştirilmesi — yalnızca sistemdeki bilinen actor'lar.

## Açık Sorular

1. **[KRİTİK — mimari karar]** Konu (topic) düğümü v1'de nasıl türetilir?
   - **Seçenek A (öneri — bütçe kısıtı nedeniyle):** Yalnızca var olan `select`/`multiSelect` custom-field değerleri + nesne `type`'ından kural-tabanlı türetim. Yeni AI-gateway/embedding çağrısı yok, ek maliyet yok.
   - **Seçenek B:** `search_index`'teki embedding'lerden (ADR-0013) benzerlik kümeleme ile otomatik konu çıkarımı. Yeni hesaplama maliyeti + `EmbeddingProvider`'a yeni bir tüketici ekler.
   - Bu, ADR'de karara bağlanmalı; Seçenek A öneriliyor ama insan onayı gerekiyor (gelecekteki görevlere dayatılan sözleşim).
2. Zaman düğümleri hangi granülerlikte bucketlanacak (gün/hafta/ay)? F2-T4'ün zaman-aşımı ihtiyacına göre **gün** öneriliyor, ama ADR'de sabitlenmeli.
3. `context_graph_nodes`/`edges` ayrı depolanan tablolar mı, yoksa `objects_view`+`relations_view` üzerine sorgu-zamanı bir görünüm mü? F2-T2'nin `<100ms` hedefi bu karara bağlı — ayrı tablo önerilir (index'lenebilir), ama ADR'de gerekçelendirilmeli.
4. Kişi düğümleri yalnızca `actor.type === 'user'` mü, yoksa ADR-0015'teki agent aktörler (`actor.type === 'agent'`) de dahil mi? Ajan aksiyonlarının bağlama girmesi Faz 3'ün "Cam Kutu Ajanlar" vizyonuyla ilgili olabilir — dahil etmek gelecek işi kolaylaştırır ama kapsamı büyütür.

## Kabul Kriterleri

- [x] `context_graph_nodes`/`context_graph_edges` şeması ADR-0017'de tanımlandığı gibi kurulu; workspace izolasyonu testli.
- [x] Bir `ObjectCreated` olayı işlendiğinde karşılık gelen `entity` düğümü ve `createdBy`'a karşılık gelen `entity–person` kenarı oluştuğu testli.
- [x] `relations_view`'daki her aktif ilişki, karşılık gelen `entity–entity` kenarı olarak grafikte göründüğü testli.
- [x] Zaman düğümleri, ADR'de kararlaştırılan granülerlikte tutarlı şekilde bucketlandığı testli.
- [x] Konu düğümleri, ADR'de kararlaştırılan yaklaşıma göre (Seçenek A/B) türetildiği testli.
- [x] `rebuild` komutu sıfırdan aynı grafiği ürettiği testli (F0-T6 determinizm kabul kriteriyle tutarlı).
- [x] ADR-0017 yazıldı ve insan tarafından onaylandı.
- [x] security-reviewer: cross-workspace veri sızıntısı riski (düğüm/kenar sorgularının `workspaceId` süzgeci) denetlendi.
