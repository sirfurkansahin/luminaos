# ADR-0002: Event Store — Olay Şeması, Sürümleme ve Projeksiyon Yaklaşımı

**Durum:** Kabul edildi
**Tarih:** 2026-07-22
**İlgili görev:** [F0-T6 — Event Store (Olay Günlüğü) Altyapısı](../specs/F0-E2/F0-T6-event-store.md)
**İlgili plan referansı:** `docs/PLAN.md` §7.1 ve CLAUDE.md "Mimari Değişmezler": _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_

## Bağlam

F0-T6, LuminaOS'in en temel mimari değişmezini uygulayan görevdir: tüm veri
değişiklikleri değişmez (immutable) olaylar olarak append-only bir günlüğe
yazılır; bağlam grafiği ve tüm okuma modelleri bu günlükten türetilir. Bu
altyapı yıllarca üzerine inşa edileceği için, henüz hiçbir tüketici yokken
(F1'deki `context-fabric` boş iskelet) zor değişmezleri şimdi doğru kurmak
kritiktir.

Üç ayrı zorluk aynı anda çözülmelidir:

1. **Olay sözleşmesi ve sürümleme.** Somut domain olayları henüz yoktur
   (F1+). Altyapı katmanı, var olmayan olay tiplerini bile saklayabilmelidir.
2. **İdempotency ile iyimser eşzamanlılık kontrolü aynı anda.** Spec iki farklı
   davranış ister: aynı `event.id`'nin ikinci yazımı sessiz no-op olmalı; iki
   yazıcının aynı stream `version`'ına yarışması ise biri reddedilerek
   çözülmelidir. İkisi de Postgres'te unique-constraint ihlali olarak yüzeye
   çıkar ve birbirinden güvenilir biçimde ayrılmalıdır.
3. **Projeksiyon çatısı.** Checkpoint takibi, sıfırdan deterministik yeniden
   inşa (`rebuild`) ve çökme-güvenli yayın (in-process bus + outbox iskeleti).

Repoda hazır bir event-bus/queue kütüphanesi yoktur ve spec dış kuyrukları
(Kafka vb.) kapsam dışı bırakır — soyutlama yeterlidir.

Uygulama iki PR'a bölündü: **PR-A** (olay sözleşmesi + `events` tablosu +
`append`/`readStream`/`readByWorkspace`) ve **PR-B** (event bus + projeksiyon
çatısı + örnek projeksiyon). Her iki PR da `security-reviewer` denetiminden
geçti; PR-A denetiminde `append()`'in `ON CONFLICT (id) DO NOTHING` sonrası
dala ait ciddi bir veri kaybı riski bulundu ve TDD ile (önce başarısız
regresyon testi, sonra düzeltme) kapatıldı — ayrıntı aşağıda "Karar" ve
"Sonuçlar" bölümlerinde.

## Karar

### Olay şeması ve sürümleme

`packages/shared/src/events/` altında zod ile doğrulanan bir `DomainEvent`
zarfı tanımlanır: `{ id, streamId, streamType, workspaceId, type, version,
payload, actor, occurredAt }`. `id` **çağıran tarafından üretilen** bir
UUID'dir (idempotency anahtarı olduğu için); diğer tablolardan farklı olarak
DB tarafından üretilmez. `payload` bu katmanda opak bir JSON nesnesidir
(`z.record`); somut olay tipleri F1+'ta kendi discriminated-union şemalarıyla
bu zarfın üzerine biner, altyapı şemasına dokunmadan.

`version`, **stream içi sıra pozisyonudur (1'den başlar) ve yalnızca iyimser
eşzamanlılık kontrolü içindir** — payload/şema sürümü DEĞİLDİR. Payload şema
evrimi zarfta bir alanla değil, `type` isimlendirmesi ve okuma/projeksiyon
sınırındaki upcaster'larla yürütülür; saklanmış olaylar asla değiştirilmez
(olaylar değişmezdir, düzeltme = yeni olay).

`actor` bilinçli olarak minimal tutuldu: `{ type: 'user'|'agent'|'system',
id }`. CLAUDE.md'nin zengin ajan aksiyon sözleşmesi
(`{niyet, gerekçe, kaynaklar[], geri_alma_planı}`) Faz 3 (Cam Kutu Ajanlar)
kapsamıdır; şimdi zarfa eklenmedi — ileride payload'da veya ayrı bir actor
uzantısında ele alınacak.

### İdempotency ve eşzamanlılığın birlikte çözümü

`events` tablosunda iki ayrı kısıt görev yapar:

- `PRIMARY KEY (id)` — idempotency.
- `UNIQUE (stream_id, version)` (`events_stream_id_version_key`) — iyimser
  eşzamanlılık hakemi.

`append(streamId, expectedVersion, events[])` tek bir transaction içinde
çalışır: mevcut stream başı okunur, `expectedVersion` başa eşit değilse ya
idempotent yeniden deneme (aynı id'ler zaten yazılı) olarak no-op döner ya da
`VersionConflictError` fırlatır. Eşitse, olaylar `INSERT ... ON CONFLICT (id)
DO NOTHING` ile yazılır. Bu son detay kritiktir: id çakışmaları bildirimsel
olarak yutulur, böylece transaction dışına kaçabilen tek `23505` yalnızca
`(stream_id, version)` kısıtı olabilir ve constraint **adına** bakılarak
kesin biçimde `VersionConflictError`'a çevrilir.

**Eşzamanlılık doğruluğu:** `MAX(version)` ön-okuması bir doğruluk bağımlılığı
değildir (READ COMMITTED altında iki yazıcı aynı değeri okuyabilir); gerçek
hakem, izolasyon seviyesinden bağımsız olarak tüm commit edilmiş satırlar
üzerinde uygulanan `(stream_id, version)` unique index'idir. Bu nedenle
`SELECT ... FOR UPDATE` veya SERIALIZABLE izolasyona gerek yoktur; varsayılan
READ COMMITTED yeterlidir. Aynı stream'e eşzamanlı iki farklı yazımda tam
olarak biri kazanır, diğeri 23505 ile reddedilir (gerçek Postgres üzerinde,
Testcontainers ile kanıtlanır).

**PR-A denetiminde bulunup düzeltilen hata:** `security-reviewer`, `id`
çakışması nedeniyle `inserted.length === 0` olduğunda çalışan yeniden-yükleme
dalının `loadByIds`'i `streamId`'ye göre filtrelediğini, ama `id` sütununun
**tabloya global** bir birincil anahtar olduğunu tespit etti. Çakışan `id`
farklı bir stream'e aitse, bu dal hiçbir satır bulamaz ve `append()` **sessizce
boş bir sonuçla başarıyla döner** — yazım hiçbir hata vermeden kaybolur. Önce
bu senaryoyu kanıtlayan bir regresyon testi yazıldı (TDD kırmızı adım), sonra
düzeltme uygulandı: bu dal artık `tryLoadIdempotentReplay`'in id+version
hizalama kontrolünü yeniden kullanıyor — gerçek bir idempotent tekrar
değilse `EventStoreConsistencyError` fırlatıyor. Bu, tasarımın "id çakışması
= güvenli no-op" varsayımının yalnızca **aynı stream içinde, tam beklenen
pozisyonda** doğrulanmış olduğunda geçerli olduğunu netleştirdi.

### Projeksiyon yaklaşımı: checkpoint + rebuild + log-as-outbox

- **Global konum:** `events` tablosunda per-stream `version`'dan ayrı bir
  `global_position` (bigint identity) tutulur; projeksiyonların çapraz-stream
  yakalaması bu toplam sıra üzerinden yapılır (`EventStoreService.readAllFrom`,
  yalnızca dahili altyapı için, üç genel API metodundan biri değil).
- **Checkpoint:** her projeksiyonun ilerlemesi `projection_checkpoints`'te
  tutulur. `ProjectionRunner.catchUp()` sırasında `apply(event)` ile
  checkpoint ilerletmesi **aynı transaction** içindedir → bir olay ya
  (uygulandı VE checkpoint ilerledi) ya da (hiçbiri) olur; çökmede replay
  yalnızca uygulanmamış olayları yeniden işler (etkin olarak tam-bir-kez,
  tek çağıran altında).
- **Rebuild:** projeksiyonun kendi durum tablosunu truncate eder, checkpoint'i
  0'a alır ve tüm günlüğü `global_position` sırasıyla yeniden oynatır.
  Determinizm, `apply`'ın sıralı olay akışı üzerinde saf bir fold olmasından
  gelir (duvar saati/rastgelelik/dış I/O yok). Örnek projeksiyon: workspace
  başına olay sayacı (`WorkspaceEventCounterProjection`), gerçek Postgres
  üzerinde canlı-yakalama ile `rebuild` sonrasının aynı sayıları ürettiği
  kanıtlandı (AC4).
- **Yayın (outbox iskeleti):** ayrı bir outbox tablosu KULLANILMAZ; günlüğün
  kendisi zaten dayanıklı ve sıralı olduğundan outbox rolünü o üstlenir.
  `InProcessEventBus` (Node `EventEmitter` üzerine, yeni bağımlılık yok)
  commit sonrası en-iyi-çaba, düşük gecikmeli bir hızlı yoldur; dayanıklılık
  garantisi ise checkpoint tabanlı yakalamadır (bir bildirim kaybolursa bir
  sonraki yakalama telafi eder). Bir listener'ın hatası (senkron fırlatma
  veya reddedilen promise) diğer listener'ları ya da `publish()`'in kendisini
  asla bozmaz — her çağrı izole edilmiş ve yalnızca olay `type`'ı loglanır
  (payload/actor asla). `EventBus` bir arayüzdür; ileride commit sonrası
  harici bir kuyruğa iten bir uygulama takılabilir, checkpoint yakalaması
  güvenlik ağı olarak kalır.

### Hata sınıfları

- `VersionConflictError` (409, `packages/shared/errors`) — iyimser
  eşzamanlılık ihlali; genel `ConflictError`'dan ayrı. Mesajı yalnızca
  `streamId` ve versiyon numaralarını içerir — hiçbir zaman payload/actor.
- `EventStoreConsistencyError` (500, sunucu tarafı) — "asla olmamalı"
  değişmez ihlalleri (partial-batch id çakışması, cross-stream id çakışması).

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- Tüm sistemin oturacağı append-only, değişmez, çapraz-stream sıralı bir olay
  günlüğü; idempotent yazımlar ve gerçek eşzamanlılık altında doğru iyimser
  kilitleme (Testcontainers ile kanıtlı, PR-A denetiminde bulunan veri-kaybı
  hatası dahil kapatıldı).
- İdempotency ve eşzamanlılık çakışmalarını constraint-adı yarışına bırakmadan
  kesin ayıran, ekstra kilit/izolasyon gerektirmeyen sade bir yazım yolu.
- Deterministik, sıfırdan yeniden inşa edilebilir projeksiyonlar (AC4 gerçek
  Postgres üzerinde kanıtlı) ve günlüğün kendisini outbox olarak kullanan,
  dış kuyruk eklemeden çökme-güvenli bir yayın iskeleti.
- Somut domain olaylarına (F1+) dokunmadan genişleyen, kararlı bir olay zarfı.

**Neyi erteliyoruz:**

- Gerçek harici kuyruk entegrasyonu (Kafka/BullMQ vb.) — bugün yalnızca
  `EventBus` arayüz dikişi var.
- `global_position` sıra-boşluğu (sequence gap) sertleştirmesi: eşzamanlı
  transaction'lar konumları commit sırasından farklı alabildiği için saf
  konum-yoklaması nadiren bir olayı atlayabilir. F0 iskeletinde birincil yol
  commit-sıralı in-process yayın olduğundan ve konum-yoklaması başlangıç/rebuild
  gibi durağan anlarda kullanıldığından kabul edilebilir; düşük-su-işareti /
  boşluk-takibi / logical replication çözümü harici kuyruk takıldığında ele
  alınacaktır.
- **`ProjectionRunner.catchUp()`/`rebuild()` için eşzamanlı çağrı kilidi
  yok.** `security-reviewer`'ın PR-B denetiminde belirttiği gibi, aynı
  projeksiyon için `catchUp` iki kez eşzamanlı çağrılırsa (ör. iki
  zamanlayıcı tick'i çakışırsa veya çoklu sunucu kopyası aynı projeksiyonu
  sürerse) checkpoint okuması bir kilit/transaction içinde olmadığından
  aynı batch iki kez uygulanabilir — `WorkspaceEventCounterProjection` gibi
  idempotent olmayan bir `apply()` bu durumda çift sayabilir. Bugün
  ulaşılabilir değil: hiçbir zamanlayıcı/`event-store.module.ts` henüz
  projeksiyonları tetiklemiyor, testler sıralı çağırıyor. Bir zamanlayıcı
  veya çoklu-kopya dağıtım eklendiğinde bu, projeksiyon adına göre bir
  Postgres advisory lock veya checkpoint satırında `SELECT ... FOR UPDATE`
  ile kapatılmalıdır — o işe kadar ertelendi.
- Snapshot'lar ve gerçek domain olayları (F1).
- `events.workspace_id` FK'sı bilinçli olarak `ON DELETE NO ACTION`'dır
  (cascade DEĞİL): değişmez günlük bir üst-satır silmesiyle sessizce yok
  edilemez. Workspace silme senaryosu geldiğinde arşivleme kararı ayrıca
  (muhtemelen kendi ADR'ıyla) verilecektir. (Projeksiyonların kendi durum
  tabloları — `projection_workspace_event_counts` — türetilmiş/yeniden
  inşa edilebilir olduğundan bu kısıt onlara uygulanmaz; onlar normal
  `cascade` konvansiyonunu kullanır.)
