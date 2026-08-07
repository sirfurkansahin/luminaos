# ADR-0013: Global Arama — pgvector'sız Hibrit Anahtar Kelime + Anlamsal Arama, Mock-Öncelikli `EmbeddingProvider`

**Durum:** Kabul edildi
**Tarih:** 2026-08-08
**İlgili görev:** [F1-T13 — Global Arama (Tam Metin + Vektör; Komut Paleti)](../specs/F1-E3/F1-T13-global-arama.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E3: Görev + Doküman + Takvim Çekirdeği" (F1-T13 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesi — birinci fıkra: embedding depolama/karşılaştırma kararı `docker-compose.yml` ve mevcut 8 `@testcontainers/postgresql` entegrasyon-test dosyasının tamamını etkileyebilecek bir altyapı kararı (F1-T12'nin `CalendarConnector` kararına benzer büyüklükte); ikinci fıkra: arama API'si + `ai-gateway`'in yeni `EmbeddingProvider` sözleşimi, gelecekteki görevlere (F2-T11 Connected Search, spec'in kendi Kapsam Dışı notunda referans veriyor) dayatılan bir kontrat tanımlıyor.

> Bu ADR mimari-kritiktir. F1-T13 spec'i anlamsal arama istiyor (Kabul #2: "farklı kelimelerle ama anlamca yakın içeriği bulur") ve bunun en doğal çözümü olan pgvector extension'ı, repodaki `docker-compose.yml`'in Postgres imajını VE bağımsız olarak `new PostgreSqlContainer('postgres:16')` başlatan 8 farklı entegrasyon-test dosyasını değiştirmeyi gerektirir — büyük bir blast radius. Ayrıca aday-seçim stratejisi (yalnızca `ts_rank` top-N mi, yoksa ayrı bir semantik havuz mu) doğrudan Kabul #2'nin doğrulanıp doğrulanamayacağını belirliyor; yanlış seçilirse sıfır-ortak-kelimeli semantik eşleşmeler asla bulunamaz hâle gelir. Bu ADR, o iki kararı ve `EmbeddingProvider` soyutlamasının sınırlarını koddan ÖNCE belgeler (ADR-0011/F1-T11, ADR-0012/F1-T12 emsali) ve koda geçilmeden önce AYRI bir insan onayı gerektirir.

## Bağlam

F1-T13, LuminaOS'e nesne başlığı ve doküman içeriği üzerinde hibrit (anahtar kelime + anlamsal) arama ve bunu sunan bir komut paleti (Cmd/Ctrl+K) kazandırıyor. Kod tabanında bugün buna hazır bazı parçalar var, bazıları yok:

1. **Projeksiyon çatısı hazır.** `ProjectionRunner.catchUp` (`apps/server/src/event-store/projections/projection-runner.service.ts:41-76`) event'leri 500'lük batch'lerle tek transaction içinde uygular; `objects.service.ts`'deki `eventStore.append(...)` sonrası inline `catchUp` çağrı noktaları (satır 233, 799, 1057, vb.) yeni bir `Projection` implementasyonunu aynı desenle takabilir — `objects-view.projection.ts` emsali.
2. **Debounce emsali hazır.** `AIRefreshScheduler` (`apps/server/src/ai/ai-refresh-scheduler.service.ts`): `Map<string, Timeout>` anahtarlı, 5 sn `setTimeout` debounce, hatalar yalnızca statik mesajla loglanır (kullanıcı verisi asla). F1-T5 desenidir.
3. **`ai-gateway` yalnızca `complete()` sunuyor.** `AIProvider` (`packages/ai-gateway/src/provider.ts:23`) hiçbir embedding metodu tanımlamıyor; `AI_PROVIDER` DI deseni (`ai-provider.module.ts:50-64`, `ai-provider.token.ts:9`) yalnızca tamamlama (completion) sağlayıcısı içindir.
4. **Vektör/tam-metin depolama için extension seçimi henüz yok.** `docker-compose.yml:3` → `postgres:16` imajı — `pgvector` extension'ı İÇERMİYOR. `tsvector`/`to_tsvector`/`ts_rank` Postgres CORE özellikleridir (extension gerekmez); `vector` tipi ve ANN indeksleri (`ivfflat`/`hnsw`) YALNIZCA `pgvector` extension'ıyla gelir. Drizzle'da her ikisi için de native column helper yok — raw `sql` template gerekiyor (`objects-view.projection.ts`'nin jsonb sql kullanımı emsali).
5. **Entegrasyon test altyapısı Postgres imajına doğrudan bağımlı.** 8 farklı dosya (`event-store.integration.test.ts`, `tenant-isolation.integration.test.ts`, `calendar-sync-poller.integration.test.ts`, vb.) her biri bağımsız olarak `new PostgreSqlContainer('postgres:16')` başlatıyor — merkezi bir tek fixture/factory yok. `postgres:16` → `pgvector/pgvector:pg16` geçişi, teorik olarak davranışsal olarak eşdeğer olsa da, 8 dosyanın TAMAMINDA image string'inin değiştirilmesini ve CI'da yeni bir imajın çekilmesini gerektirir.
6. **RBAC yalnızca workspace-seviyeli.** `WorkspaceMembershipGuard` + `WHERE workspace_id = :id` deseni (`workspace-membership.service.ts:35-65`) zaten mevcut; obje-seviyeli ACL yok. Arama sorgusu bu deseni miras alabilir — yeni bir yetkilendirme modeli icat etmeye gerek yok.
7. **`ADR-000X-hibrit-ai.md` mevcut değil.** CLAUDE.md "Mimari Değişmezler"de referans verilen bu ADR doldurulmamış bir placeholder'dır; hassas-veri sınıflandırıcısı da yoktur (F3-T12'ye, Faz 3'e ertelenmiş).
8. **Komut paleti / doküman düz-metin / debounce hook'u — hepsi greenfield.** `packages/ui`'de cmdk/combobox yok (yalnızca Radix primitifleri, `@radix-ui/react-dialog` temel alınabilir); `apps/web`'de global Cmd/Ctrl+K altyapısı ve hiçbir debounce utility'si yok; `packages/core-objects/src/doc/block.ts`'te `Block`→düz-metin helper'ı yok.

Çözülmesi gereken merkezi sorular: (1) embedding nasıl depolanacak ve benzerlik nasıl hesaplanacak — pgvector'ın getirdiği geniş blast radius'a değer mi; (2) "farklı kelimelerle ama anlamca yakın" aramayı gerçekten bulabilecek aday-seçim stratejisi nedir; (3) embedding üretimi hangi soyutlama sınırında, `ai-gateway`'in mevcut `AIProvider` sözleşimini bozmadan nasıl eklenir; (4) embedding yeniden-hesaplaması hangi katmanda, hangi tetikleyiciyle yaşar.

## Karar

### (a) Depolama ve benzerlik hesaplama — pgvector YOK; `embedding` native `real[]`, kosinüs uygulama katmanında

`embedding` sütunu **`real[]`** (native Postgres dizisi, extension gerektirmez) olarak saklanır. `tsvector`/`to_tsvector`/`ts_rank` zaten Postgres core'un parçasıdır — extension gerektiren tek şey `vector` tipi ve onun ANN indeksleridir (`ivfflat`/`hnsw`), ve bu görev onları KULLANMAZ. Kosinüs benzerliği Node uygulama katmanında (TypeScript, düz aritmetik) hesaplanır.

Gerekçe: pgvector eklemek `docker-compose.yml`'in imajını (`postgres:16` → `pgvector/pgvector:pg16`) VE bağımsız olarak `new PostgreSqlContainer('postgres:16')` başlatan **8 entegrasyon-test dosyasının TAMAMINI** değiştirmeyi gerektirirdi — büyük ve bu görevin gerçek ihtiyacına oranla gereksiz bir blast radius. v1'in anlamsal arama gereksinimi yalnızca `MockEmbeddingProvider` ile deterministik olarak doğrulanacak (spec Kabul #2); gerçek ANN-hızlı vektör indeksine ihtiyaç yok. Workspace-başına veri hacmi bugün küçük (bir workspace'in nesne+doküman sayısı, tam-tarama kosinüs hesaplamasını pahalı kılacak ölçekte değil) — bu yüzden bir ANN indeksinin getirisi, kurulum/bakım/test-altyapısı maliyetini haklı çıkarmıyor.

**Gelecek-ölçek notu:** korpus büyürse hem Node-tarafı tam-tarama maliyeti hem de pgvector ihtiyacı yeniden değerlendirilmeli — bu, ADR-0012'nin "çoklu-örnek polling tekilleştirmesi kapsam dışı" notuyla aynı ruhta, bilinçli ve belgelenmiş bir erteleme (bkz. Sonuçlar).

### (b) Aday seçimi — `ts_rank` top-N ∪ brute-force kosinüs top-N (KRİTİK düzeltme)

Spec Kabul Kriteri #2 ("farklı kelimelerle ama anlamca yakın içeriği bulur") şu anlama gelir: sorgu ile semantik olarak yakın bir doküman arasında **hiç ortak kelime olmayabilir**. Aday havuzunu yalnızca `ts_rank`/`plainto_tsquery` top-N'den türetmek bu nedenle **YANLIŞTIR**: anahtar-kelime skoru sıfır olan semantik-yakın bir doküman o top-N'e hiçbir zaman girmez ve dolayısıyla asla bulunamaz — Kabul #2 sistematik olarak başarısız olur.

Doğru tasarım: aday havuzu, iki bağımsız top-N'in **BİRLEŞİMİDİR (union)**:

1. `ts_rank`/`plainto_tsquery` üzerinden top-N (config sabiti, ör. **50**),
2. workspace'teki `search_index` tablosunun **TÜM** satırları üzerinde, Node tarafında brute-force kosinüs benzerliği hesaplanarak elde edilen semantik top-N.

Küçük-hacim varsayımı (§a'da pgvector'ı atlamanın gerekçesi) burada da geçerli: tam-tarama kosinüs hesaplaması, aynı veri hacminde ucuz kalıyor — ekstra bir maliyet sınıfı eklenmiyor. Birleşik havuz üzerinde nihai sıralama, sabit-ağırlıklı bir kombine skorla yapılır:

```
finalScore = keyword_weight * ts_rank_norm + semantic_weight * cosine
```

Ağırlıklar (`keyword_weight`, `semantic_weight`) sabit config değerleridir (ileride ayarlanabilir, ama v1'de hard-coded sabit — spec madde 3 ile uyumlu).

**Gelecek-ölçek notu (tekrar):** korpus büyüdükçe hem tam-taramanın maliyeti hem pgvector ihtiyacı birlikte artacak — bu ikisi aynı gelecekteki görevin (§Kapsam Dışı) kapsamına girer, birbirinden ayrılmaz.

### (c) `EmbeddingProvider` soyutlaması — Mock-öncelikli, `AIProvider`'dan AYRI arayüz (`CalendarConnector`/`AI_PROVIDER` emsali)

`AIProvider`'a (`packages/ai-gateway/src/provider.ts:23`) zorunlu bir `embed()` metodu eklemek yerine — bu, mevcut `AnthropicProvider`'ı da değiştirmeyi zorunlu kılardı ve henüz verilmemiş bir gerçek embedding-sağlayıcı kararını (ör. Voyage AI, OpenAI) önceden varsaymış olurdu — **ayrı** bir `EmbeddingProvider` arayüzü tanımlanır:

```ts
interface EmbeddingProvider {
  embed(text: string): Promise<{ vector: number[] }>;
}
```

`packages/ai-gateway` içinde bir `MockEmbeddingProvider` eklenir: deterministik (aynı metin → aynı vektör), hash-tabanlı (metinden sabit-boyutlu bir pseudo-vektör türetir), birim-normalize edilmiş (`|v| = 1`, kosinüs hesaplamasını basitleştirir). Yeni bir **`EMBEDDING_PROVIDER`** DI token'ı + factory (`apps/server`'da, `AI_PROVIDER`'ın `ai-provider.module.ts:50-64`'teki `useFactory` deseni ve F1-T12'nin `CALENDAR_CONNECTOR`'ı ile birebir aynı desen) eklenir ve **her zaman Mock döner** — gerçek sağlayıcı entegrasyonu AYRI bir gelecek göreve ertelenir (kullanıcı kararı, F1-T12'nin gerçek Google/Outlook adaptörlerini ertelemesiyle birebir aynı disiplin: şu an gerçek bir embedding-sağlayıcı seçimi/kimlik bilgisi yok).

Bu tasarım, CLAUDE.md'nin "AI çağrıları yalnızca `packages/ai-gateway` üzerinden; sağlayıcı SDK'sını doğrudan import etme" değişmezini (F1-T5) korur — embedding üretimi de, `complete()` gibi, yalnızca `ai-gateway`'in dışa açtığı bir sözleşim üzerinden çağrılır; `apps/server`'ın geri kalanı `EmbeddingProvider`'ın somut implementasyonunu asla bilmez.

### (d) `search_index` projeksiyonu + tablosu

Yeni bir **`search_index`** tablosu: `objectId` (ULID, FK), `workspaceId`, `tsv tsvector`, `embedding real[]` (nullable), `updatedAt`. Migration, eşlenik down-script'iyle birlikte (`apps/server/src/db/migrations/NNNN_<slug>.sql` + `down/NNNN_<slug>.down.sql`, CLAUDE.md L55 konvansiyonu).

`SearchIndexProjection`, F0-T6'nın `Projection` arayüzünü implemente eder (`objects-view.projection.ts` emsali): nesne başlık-değişim olaylarını VE F1-T11'in doküman-snapshot olaylarını dinler, `to_tsvector`'ı **senkron** hesaplar — `packages/core-objects`'e eklenecek yeni `blocksToPlainText` yardımcısını (Block ağacını gezip düz metne çevirir, saf/framework-free) kullanarak. `embedding` sütunu başlangıçta **NULL**'dır (embedding üretimi asenkron, §e). Projeksiyon, `objects.service.ts`'deki mevcut inline `catchUp` çağrı noktalarına eklenir (yeni bir tetikleme mekanizması icat edilmez).

Drizzle'ın `tsvector`/vektör-dizisi için native column helper'ı olmadığından, hem şema tanımı hem projeksiyonun yazma yolu raw `sql` template'lerine dayanır — `objects-view.projection.ts`'nin jsonb sql kullanım deseni doğrudan emsal alınır.

### (e) Embedding yeniden-hesaplama — 5 sn debounce'lu AYRI scheduler; projeksiyon side-effect'i DEĞİL

`SearchIndexEmbeddingScheduler`, `AIRefreshScheduler`'ın (`apps/server/src/ai/ai-refresh-scheduler.service.ts`) genellenmiş hâlidir: `Map<string, Timeout>` (objectId anahtarlı), 5 sn `setTimeout` debounce, hatalar yalnızca statik bir mesajla loglanır (kullanıcı verisi/içerik ASLA loglanmaz). Debounce penceresi dolduğunda `EMBEDDING_PROVIDER.embed(text)` çağrılır ve sonuç `search_index.embedding` sütununa düz bir `UPDATE` ile yazılır.

Bu yazma, **`SearchIndexProjection`'ın `apply()` metodunun İÇİNDE DEĞİL**, ondan tamamen ayrı bir servis çağrısı olarak yapılır. Gerekçe (F1-T12 PR5d dersi, doğrudan uygulanır): projeksiyonlar `EventStoreService.replay`/`catchUp` tarafından tekrar tekrar çağrılabilir (rebuild, checkpoint kaybı sonrası yeniden oynatma, vb.) — eğer embedding üretimi bir projeksiyonun `apply()`'ı içinde yapılsaydı, her replay turunda dış bir servise (gerçek sağlayıcı geldiğinde: gerçek bir AI API çağrısı) tekrar tekrar istek gidilirdi. Asenkron, dış-servise bağımlı bir side-effect projeksiyonda YAŞAYAMAZ; kullanıcı-yazma yolunun dışında, tek seferlik (one-shot) bir servis çağrısı olmalıdır. Scheduler, `search_index` satırının `tsv`/`title` içeriği değiştiğinde (aynı yazma yollarından — title/doc değişimi) tetiklenir.

### (f) Query-time RBAC — mevcut workspace-seviyeli desenin miras alınması

Arama uç noktası (`POST /workspaces/:workspaceId/search`), erişim süzgecini sorgu SIRASINDA uygular: `WorkspaceMembershipGuard` + `WHERE workspace_id = :id` (`workspace-membership.service.ts:35-65`'teki mevcut desen) — asla fetch-then-filter değil. Bu sayede erişimi olmayan bir nesnenin varlığı, sayısı veya zamanlaması (timing) hiçbir şekilde sızdırılmaz (spec Kabul #3).

Kod tabanında bugün yalnızca workspace-seviyeli RBAC var, obje-seviyeli ACL yok — bu karar YENİ bir yetkilendirme modeli icat etmiyor, yalnızca mevcut deseni miras alıyor. Obje-seviyeli ACL bir gün eklenirse, arama sorgusunun süzgeci o zaman genişletilir; bugün için mevcut desenin ötesine geçmek kapsam dışıdır.

### (g) Hassas-veri değişmezi ile ilişki — açık boşluk notu

CLAUDE.md "Mimari Değişmezler": _"Hassas veri sınıfları buluta ham gönderilmez (bkz. `docs/adr/ADR-000X-hibrit-ai.md`)"_ — ancak bu ADR **mevcut değildir** (doldurulmamış placeholder) ve hiçbir sınıflandırıcı yoktur (F3-T12'ye, Faz 3'e ertelenmiş).

F1-T13 yalnızca `MockEmbeddingProvider`'ı bağladığı için (gerçek bulut çağrısı yok), bu değişmezle **bugün hiçbir gerilim yoktur**. Ancak açıkça not düşülüyor: gerçek bir bulut embedding sağlayıcısı eklendiğinde (§c'de ertelenen gelecek görev), nesne başlıkları ve doküman düz-metinleri bu çözülmemiş sınıflandırma/redaksiyon boşluğuna doğrudan çarpar — o görev, embedding çağrısını buluta göndermeden ÖNCE hassas-veri sınıflandırmasını/redaksiyonunu çözmek ZORUNDADIR (F3-T12 / `ADR-000X-hibrit-ai.md`'ye referansla). Bu, F1-T12'nin gerçek Google/Outlook adaptörlerini ertelerken aynı disiplinle bıraktığı bir notla birebir aynı yapıdadır.

## Alt-PR ayrıştırması (kayıt amaçlı)

ADR onayından sonra, her biri test-writer → implementer → security-reviewer turundan geçecek yedi alt-PR öngörülüyor (tek plan onayı hepsini kapsar, CLAUDE.md "Çalışma Ritüeli" madde 2):

- **PR1** — `packages/ai-gateway`: `EmbeddingProvider` arayüzü + `MockEmbeddingProvider`.
- **PR2** — `packages/core-objects`: `blocksToPlainText` düz-metin helper'ı (`doc/block.ts` yanına).
- **PR3** — `apps/server`: `search_index` migration + `SearchIndexProjection`.
- **PR4** — `apps/server`: `SearchIndexEmbeddingScheduler` (5 sn debounce).
- **PR5** — `apps/server`: `POST /workspaces/:workspaceId/search` API'si (aday-birleşimi + hibrit skor + RBAC).
- **PR6** — `apps/web`: arama client + `useDebouncedValue`/`useSearchQuery` hook'ları.
- **PR7** — `apps/web` + `packages/ui`: komut paleti (Cmd/Ctrl+K, Radix Dialog tabanlı, tipe göre gruplama, klavye navigasyonu); boyut zorlarsa 7a/7b'ye bölünür (F1-T12 PR8a/8b emsali).

## Alternatifler ve Reddedilme Gerekçeleri

- **pgvector extension'ı ile `vector` sütunu + ANN indeksi (`ivfflat`/`hnsw`).** Reddedildi — `docker-compose.yml`'in imajını VE 8 bağımsız entegrasyon-test dosyasının TAMAMINI değiştirmeyi gerektiren büyük bir blast radius; v1'in doğrulama ihtiyacı (yalnızca `MockEmbeddingProvider`'a karşı deterministik test) ve küçük veri hacmi bu maliyeti haklı çıkarmıyor. Korpus büyüdüğünde yeniden değerlendirilecek (bkz. Kapsam Dışı).
- **Aday havuzunu yalnızca `ts_rank` top-N'den türetmek.** Reddedildi (kritik) — Kabul #2'nin "farklı kelimelerle ama anlamca yakın" senaryosunda, keyword skoru sıfır olan semantik-yakın dokümanlar bu top-N'e hiç girmez ve asla bulunamaz. Birleşim (§b) zorunlu.
- **`AIProvider`'a zorunlu `embed()` eklemek.** Reddedildi — mevcut `AnthropicProvider`'ı değiştirmeyi zorunlu kılar ve henüz verilmemiş bir gerçek embedding-sağlayıcı kararını önceden varsayar. Ayrı `EmbeddingProvider` arayüzü, `AIProvider`'ın mevcut sözleşimini bozmadan aynı Mock-öncelikli disiplini uygular.
- **Embedding üretimini `SearchIndexProjection.apply()` içinde yapmak.** Reddedildi — F1-T12 PR5d dersi: projeksiyonlar replay/rebuild'de tekrar tekrar çağrılabilir; asenkron dış-servis çağrısı (gerçek sağlayıcı geldiğinde) bu döngüde tekrar tekrar tetiklenirdi. Ayrı, debounce'lu, tek-seferlik bir scheduler servisi gerekli.
- **Custom Field metin değerlerini de indexlemek (v1'de).** Reddedildi — spec'in kendi Kapsam Dışı maddesi; ayrı bir gelecek görev.
- **Obje-seviyeli ACL icat etmek arama için.** Reddedildi — kod tabanında bugün obje-seviyeli ACL yok; arama, mevcut workspace-seviyeli RBAC desenini miras alıyor, yeni bir yetkilendirme modeli bu görevin kapsamında değil.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- Embedding depolama kararı (§a), `docker-compose.yml` ve mevcut 8 entegrasyon-test dosyasının HİÇBİRİNE dokunmadan çözülüyor — kapsam daralıyor, risk ortadan kalkıyor.
- Aday-seçim birleşimi (§b), spec Kabul #2'nin gerçekten doğrulanabilir olmasını sağlıyor — yalnızca `ts_rank` tabanlı bir tasarımda sistematik olarak başarısız olacak bir sınıf senaryo (sıfır ortak kelime) artık kapsanıyor.
- `EmbeddingProvider` soyutlaması (§c), `ai-gateway`'in kanıtlanmış Mock-öncelikli + DI-fabrikası desenini (`AI_PROVIDER`/`CALENDAR_CONNECTOR`) yansıtıyor — gerçek sağlayıcı, çekirdek mantık değişmeden ayrı bir görevde takılabilir; "AI çağrıları yalnızca ai-gateway üzerinden" değişmezi korunuyor.
- Embedding yeniden-hesaplamasının projeksiyondan ayrılması (§e), F1-T12 PR5d'nin öğrettiği dersi genelliyor ve gelecekteki başka async-side-effect ihtiyaçları için de bir emsal bırakıyor.
- RBAC (§f) hiçbir yeni mekanizma icat etmeden mevcut, kanıtlanmış workspace-seviyeli desenle çözülüyor.

**Neyi erteliyoruz / kabul ediyoruz (Kapsam Dışı / Ertelenen):**

- **pgvector migration'ı** — korpus büyüdüğünde (ve ANN-hızlı indeksin gerçekten gerekli olduğu ölçekte) ayrı bir gelecek görev; bugünkü `real[]`/brute-force tasarımı bilinçli bir v1 sınırlaması.
- **Gerçek embedding sağlayıcısı** (ör. Voyage AI) — ayrı bir gelecek görev; F1-T13 tamamen `MockEmbeddingProvider`'a karşı kanıtlanır (F1-T12'nin gerçek Google/Outlook adaptörlerini ertelemesiyle aynı disiplin). O görev, hassas-veri sınıflandırma boşluğunu (§g) da çözmek ZORUNDADIR.
- **Korpus-ölçekleme (tam-tarama kosinüs maliyeti)** — pgvector ihtiyacıyla aynı geleceğe ertelenmiş, birbirinden ayrılmaz bir sorun kümesi.
- **Custom Field metin değerlerinin indexlenmesi** — spec'in kendi Kapsam Dışı maddesi; ayrı gelecek görev.
- **Connected Search (dış kaynak/MCP arama birleşimi)** — F2-T11'e ertelenmiş; bu ADR'nin `EmbeddingProvider`/arama API sözleşimi o göreve bir temel bırakıyor ama onu kapsamıyor.
