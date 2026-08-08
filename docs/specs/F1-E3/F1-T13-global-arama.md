# F1-T13 — Global Arama (Tam Metin + Vektör; Komut Paleti)

**Epik:** F1-E3 (Görev + Doküman + Takvim Çekirdeği) · **Durum:** Tamamlandı (Kabul Kriterleri 5/5)
**Bağımlılık:** F1-T1 (varlık çekirdeği), F1-T5 (ai-gateway deseni), F1-T11 (doküman içeriği), F0-T5 (RBAC), F0-T7 (tasarım sistemi)

## Amaç

Nesne başlığı ve doküman içeriğinde hem anahtar kelime hem de anlamsal (semantic) arama; komut paleti (Cmd/Ctrl+K) içinde sunulur.

## Kapsam

1. **`object_search_index` projeksiyonu** (F0-T6 projeksiyon çatısı kullanılır): `{ objectId, workspaceId, tsvector, embedding: vector, updatedAt }`. Kaynak: nesne `title` + `doc` tipi için F1-T11'deki blok ağacından türetilmiş düz metin. **v1'de Custom Field metin değerleri indexlenmez** (bilinçli kapsam sınırlaması, bkz. Kapsam Dışı).
2. **Embedding üretimi yalnızca `ai-gateway` üzerinden** (F1-T5 desenine uyar — sağlayıcı SDK'sı doğrudan import edilmez). İçerik değiştikten sonra debounce'lu (5 sn, F1-T5'teki `AIRefreshScheduler` deseninin genellenmiş hâli) yeniden hesaplama.
3. **Hibrit sıralama:** Anahtar kelime skoru (`ts_rank`) birincil sıralama kriteri; anlamsal (cosine similarity) skor ikincil re-rank için kullanılır. Ağırlıklar sabit config değeridir (ileride ayarlanabilir).
4. **API:** `POST /workspaces/:workspaceId/search { query, limit }`. **Güvenlik kuralı:** RBAC süzgeci sorgu SIRASINDA uygulanır (post-filter değil) — erişimi olmayan bir nesnenin varlığı sonuç sayısı veya zamanlamayla bile sızdırılmaz.
5. **Komut paleti UI** (`packages/ui` bileşenleri, `apps/web`): Cmd/Ctrl+K ile açılır, 250ms debounce, sonuçlar tipe göre gruplanır (Görevler/Dokümanlar/Notlar), klavye navigasyonu (yukarı/aşağı/enter).

## Kapsam DIŞI

- Custom Field metin değerlerinin indexlenmesi (ileride ayrı görev).
- Dış kaynak (MCP) arama birleşimi — Connected Search (F2-T11).
- Yazım hatası toleransı/fuzzy match ötesinde gelişmiş NLP sorgu ayrıştırma.

## Kabul Kriterleri

- [x] Tam eşleşen başlık, anahtar kelime aramasında ilk sırada döner (testli). — PR5 ([#86](https://github.com/sirfurkansahin/luminaos/pull/86), `search.integration.test.ts` AC1: `ts_rank`/`plainto_tsquery` sıralaması).
- [x] Anlamsal arama, farklı kelimelerle ama anlamca yakın içeriği bulur (MockProvider ile deterministik testli — F1-T5'teki gibi). — PR1 (`EmbeddingProvider`+`MockEmbeddingProvider`, [#81](https://github.com/sirfurkansahin/luminaos/pull/81)), PR4 (embedding scheduler, [#85](https://github.com/sirfurkansahin/luminaos/pull/85)), PR5 (aday havuzu = `ts_rank` top-N ∪ brute-force kosinüs top-N UNION; AC5 sıfır-ortak-kelime testi bunu doğrudan kanıtlıyor, [#86](https://github.com/sirfurkansahin/luminaos/pull/86)).
- [x] Guest/yetkisiz kullanıcı erişimi olmayan bir nesneyi ne sonuç listesinde ne de sayaçta/zamanlamada görebilir (security-reviewer + testli). — PR5 ([#86](https://github.com/sirfurkansahin/luminaos/pull/86)): `WorkspaceMembershipGuard` + sorgu-içi `workspace_id`/`lifecycle != 'deleted'` filtresi (asla fetch-then-filter), AC2/AC3 testli; security-reviewer: RBAC/SQL-injection/DoS temiz.
- [x] Doküman içeriği değiştikten debounce (5 sn) sonrası embedding güncellenir (testli). — PR3b (Yjs doküman içeriği indeksleme, [#84](https://github.com/sirfurkansahin/luminaos/pull/84)), PR4 (`SearchIndexEmbeddingScheduler`, gerçek WebSocket+debounce uçtan-uca testli, [#85](https://github.com/sirfurkansahin/luminaos/pull/85)).
- [x] Komut paleti 250ms debounce ile gereksiz istek göndermediği testli. — PR6 (`useDebouncedValue`, [#87](https://github.com/sirfurkansahin/luminaos/pull/87)), PR7 (`CommandPalette`, [#88](https://github.com/sirfurkansahin/luminaos/pull/88)).

## İlerleme Notu (Tamamlandı)

Görev, ADR-0013 (mimari-kritik, insan onaylı) + 7 alt-PR ile gerçekleştirildi:

- **ADR-0013** ([#80](https://github.com/sirfurkansahin/luminaos/pull/80)): pgvector YOK — `embedding real[]` (native Postgres dizisi) + kosinüs benzerliği Node katmanında; aday havuzu `ts_rank` top-N ∪ brute-force kosinüs top-N BİRLEŞİMİ (kullanıcı düzeltmesi — yalnızca `ts_rank` tabanlı tasarım sıfır-ortak-kelimeli semantik eşleşmeleri sistematik olarak kaçırırdı); `AIProvider`'dan ayrı, Mock-öncelikli `EmbeddingProvider`; embedding yeniden-hesaplaması ayrı debounce scheduler'ı (projeksiyon side-effect'i değil).
- **PR1** ([#81](https://github.com/sirfurkansahin/luminaos/pull/81)): `packages/ai-gateway`'e `EmbeddingProvider`+`MockEmbeddingProvider` (SHA-256 tabanlı deterministik, 16-boyutlu, birim-normalize).
- **PR2** ([#82](https://github.com/sirfurkansahin/luminaos/pull/82)): `packages/core-objects`'e `blocksToPlainText` (Block[] → düz metin) — **not:** implementasyon sırasında F1-T11'in gerçek doküman kalıcılık yolunun `Block[]` değil ham Yjs CRDT blob'u kullandığı keşfedildi; bu fonksiyon paket içinde saf/test edilmiş bir yardımcı olarak duruyor ama asıl doküman indekslemesi PR3b'nin Yjs-özel çözümünü kullanıyor.
- **PR3a** ([#83](https://github.com/sirfurkansahin/luminaos/pull/83)): `search_index` tablosu (customType tsvector, GIN indeks) + `SearchIndexProjection` (yalnızca başlık: `ObjectCreated`/`ObjectRenamed`).
- **PR3b** ([#84](https://github.com/sirfurkansahin/luminaos/pull/84)): `extractPlainTextFromYjsUpdate` (Yjs `XmlFragment`'ı iteratif/stack-tabanlı gezip düz metin çıkarır, katlanmış/toggle başlık çocukları dahil — kullanıcı talebiyle netleştirildi) + `SearchIndexProjection`'a `DocumentContentSnapshotted` desteği.
- **PR4** ([#85](https://github.com/sirfurkansahin/luminaos/pull/85)): `SearchIndexEmbeddingScheduler` (`AIRefreshScheduler`'ın genellenmiş hâli) + `EMBEDDING_PROVIDER` DI + `doc-collab.gateway.ts`'in `SearchIndexProjection` için hiç `catchUp` çağırmadığı bir bağlantı boşluğu düzeltildi (dokuman içerik indekslemesi gerçek collab yolunda hiç çalışmıyordu).
- **PR5** ([#86](https://github.com/sirfurkansahin/luminaos/pull/86)): `POST /workspaces/:workspaceId/search` API'si. **Ayrıca**: implementasyon sırasında `ProjectionRunner.catchUp()`'ta gerçek bir eşzamanlılık hatası bulundu ve kullanıcı onayıyla düzeltildi — checkpoint kilitsiz okunuyordu, eşzamanlı çağrılar aynı event'i iki kez uygulayıp sistemdeki HER projeksiyonda (yalnızca arama değil) duplicate-key crash'ine yol açabiliyordu; düzeltme `pg_advisory_xact_lock` ile projeksiyon-adına göre serileştirme.
- **PR6** ([#87](https://github.com/sirfurkansahin/luminaos/pull/87)): `apps/web` arama client'ı (`searchWorkspace`) + `useDebouncedValue`/`useSearchQuery` hook'ları.
- **PR7** ([#88](https://github.com/sirfurkansahin/luminaos/pull/88)): Komut paleti (`CommandPalette.tsx`) — Cmd/Ctrl+K, tipe göre gruplama, klavye navigasyonu.

**Kalan (bilinçli erteleme, ayrı görev):** Gerçek embedding sağlayıcısı (F1-T12'nin CalendarConnector erteleme disipliniyle aynı — şu an yalnızca Mock'a karşı kanıtlanmış). pgvector/korpus-ölçekleme (ADR-0013'ün kendi gelecek-ölçek notu — v1'in küçük-hacim varsayımı geçerli olduğu sürece gerekmiyor). Custom Field metin indexlemesi ve Connected Search (spec'in kendi Kapsam Dışı maddeleri).

F1-E3 epiği ("Görev + Doküman + Takvim Çekirdeği") bu görevle tamamlandı — F1-T13, epiğin son planlanan görevidir. Sıradaki epik F1-E4 (AI Servisi v1 + Veri Çıkışı), ilk görevi F1-T14 (`ai-gateway`: sağlayıcı soyutlama, model yönlendirme kuralları, maliyet/kota ölçümü, `docs/PLAN.md` satır 227) — ancak `docs/specs/F1-E4/` klasörü ve F1-T14'ün spec dosyası henüz YOK. CLAUDE.md'nin Çalışma Ritüeli madde 1 gereği ("Görevin spec dosyası olmadan kod yazma"), sıradaki adım F1-T14'e kod yazmak değil, önce spec'ini yazmaktır.

Sıradaki adım:

```
docs/PLAN.md dosyasının F1-T14 satırını (227) ve F1-T5/F1-T13 PR1'in ai-gateway'e bugüne kadar ne eklediğini (packages/ai-gateway/src/) oku, sonra docs/specs/F1-E4/F1-T14-ai-gateway.md spec dosyasını yaz
```
