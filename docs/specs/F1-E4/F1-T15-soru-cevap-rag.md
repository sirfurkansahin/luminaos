# F1-T15 — Soru-Cevap: Workspace Bağlamıyla RAG + Kaynak Gösterimi

**Epik:** F1-E4 (AI Servisi v1 + Veri Çıkışı) · **Durum:** Yapılacak
**Bağımlılık:** F1-T13 (`search_index` tablosu + `SearchService` hibrit retrieval + `EmbeddingProvider`/`MockEmbeddingProvider`, ADR-0013), F1-T14 (`AIProvider.complete()` + model yönlendirme + maliyet/kota ölçümü, ADR-0008), F0-T5 (RBAC — `WorkspaceMembershipGuard`)

## Amaç

PLAN.md (satır 228) bu görevi "workspace bağlamıyla RAG (pgvector) + kaynak gösterimi" olarak tanımlıyor: kullanıcı doğal dilde bir soru sorar, sistem workspace içeriğinden (nesne başlıkları + doküman metni) alakalı pasajları bulur, bunları bağlam olarak `ai-gateway` üzerinden bir modele geçirir ve yalnızca bulunan pasajlara dayanan, kaynak gösteren (hangi nesne(ler)den geldiği belirtilen) bir cevap üretir. Bu görev, F1-T13'ün retrieval altyapısını (arama değil, RAG için) ve F1-T14'ün tamamlama/maliyet altyapısını birleştiren ilk "üretici" (generative, salt arama değil) AI özelliğidir.

## Mevcut Durum (keşif — koddan doğrulandı)

- `apps/server/src/search/search.service.ts` (`SearchService.search`, F1-T13 PR5): workspace-scoped hibrit retrieval ZATEN var — `ts_rank` top-N ∪ brute-force kosinüs top-N birleşimi, sabit ağırlıklı (`KEYWORD_WEIGHT=0.5`/`SEMANTIC_WEIGHT=0.5`) rescore, query-time RBAC (`workspace_id = :workspaceId` WHERE içinde, asla fetch-then-filter). Bu görev YENİ bir retrieval motoru İCAT ETMEZ — `SearchService`'i reuse eder.
- **Önemli sınırlama:** `search_index` (F1-T13 ADR-0013 §d) nesne-başına **TEK** satır tutuyor — `{ objectId, workspaceId, title, tsv, embedding }`; embedding tüm doküman metninin (title + F1-T11'in Yjs içeriğinden çıkarılmış düz metin) TEK bir vektörü. `SearchService.search()` de yalnızca `{ objectId, title, type, score }` döndürüyor — **ham pasaj/snippet metni döndürmüyor**. RAG için LLM'e geçirilecek gerçek metin parçası ve kaynak gösterimi için okunabilir bir alıntı gerekiyor; bugünkü retrieval sonucu bunun için yetersiz (yalnızca "hangi nesne" bilgisi var, "nesnenin hangi kısmı" yok).
- `packages/ai-gateway`: `AIProvider.complete()` (F1-T14) — `model?` alanıyla en az iki gerçek model (`claude-haiku-4-5-20251001` ucuz/hızlı, `claude-sonnet-5` güçlü) arasında seçim yapılabiliyor; `selectAIModel` (apps/server, F1-T14 PR3) görev tipine göre saf bir yönlendirme kuralı uyguluyor — QA görev tipi bu kurala henüz kayıtlı değil.
- `apps/server/src/ai/`: `AIUsageRecorded` olayı artık `model`+`costUsd` taşıyor (F1-T14 PR2), `recordAIUsage` best-effort (log-and-swallow), `assertAICostBudgetNotExceeded` istek ÖNCESİ $ bütçe kontrolü yapıyor (F1-T14 PR4) — QA tamamlama çağrıları da bu disipline tabi olmalı (yeni bir kota/maliyet mekanizması icat edilmez).
- **PLAN.md'nin "(pgvector)" notu ile ADR-0013 arasında gerilim:** PLAN.md bu satırı Temmuz 2026'da, F1-T13 henüz uygulanmadan önce yazmış. ADR-0013 §a, pgvector'ı BİLİNÇLİ OLARAK reddetti (`docker-compose.yml` + 8 entegrasyon-test dosyasının blast radius'u; v1'in küçük-hacim varsayımı) ve `embedding real[]` + Node-tarafı brute-force kosinüs kararını verdi; pgvector'ı "korpus büyüdüğünde yeniden değerlendirilecek" bir gelecek-ölçek notu olarak bıraktı (§a, §Sonuçlar). Bu görev PLAN.md'nin orijinal "(pgvector)" varsayımını miras almaz — ADR-0013'ün kararı hâlâ geçerli; aksi bir karar (gerçek pgvector'a geçmek) YENİ bir ADR gerektirir (bkz. Açık Sorular).
- **Hassas veri değişmezi:** ADR-0013 §g'nin bıraktığı not geçerliliğini koruyor (`ADR-000X-hibrit-ai.md` hâlâ doldurulmamış placeholder, sınıflandırıcı yok, F3-T12'ye ertelenmiş) — ancak F1-T5 (AI Fields) ZATEN workspace içeriğini (field bağlamı) `AnthropicProvider.complete()`'e ham geçiriyor; bu görev aynı ÖNCEDEN KABUL EDİLMİŞ deseni miras alıyor (retrieved pasajlar da aynı şekilde tamamlama isteğine ham geçer), YENİ bir risk sınıfı AÇMIYOR.
- `apps/server/src/search/dto/search-workspace.schema.ts`: "DoS-cap-via-validation-rejection" deseni (query max 200 karakter, limit max 50, `.strict()`) — QA soru endpoint'i için emsal alınacak.
- ADR-0008'in yapısal loglama disiplini (prompt/tamamlanma metni ASLA loglanmaz) hem F1-T5 hem F1-T14'te korunuyor; bu görevde de (soru metni, retrieved pasajlar, üretilen cevap) aynı disiplin geçerli.

## Kapsam

1. **Pasaj-seviyeli retrieval genişletmesi:** `SearchService`'in nesne-seviyeli sonucu (`objectId, title, type, score`) RAG için yetersiz — cevap üretimi ve kaynak gösterimi için okunabilir bir metin parçası (snippet) gerekir. Tasarım kararı (plan aşamasında netleşir, olası ADR tetikleyicisi — bkz. Açık Sorular): (a) top-K nesnenin tam düz-metnini retrieval SONRASI ayrıca çekip basit bir paragraf/karakter-sınırlı kırpma ile snippet türetmek (şema değişikliği YOK, en düşük blast-radius), (b) `search_index`'i chunk-seviyesine genişletmek (şema migration, ADR-0013'ün sözleşimini değiştirir), veya (c) ayrı bir `qa_passages` tablosu.
2. **Retrieval:** `SearchService.search()` (F1-T13) AYNEN reuse edilir — soru metni embed edilir, top-K nesne bulunur (hibrit skor, mevcut RBAC deseni miras alınır).
3. **Cevap üretimi:** `AIProvider.complete()` (F1-T14) üzerinden, retrieved pasajlar + soru sabit bir prompt şablonuna yerleştirilir; `selectAIModel`'e QA görev tipi eklenir (görev karmaşıklığına göre hangi modelin kullanılacağı — tasarım kararı, plan aşamasında netleşir). Prompt şablonu modele YALNIZCA retrieved pasajlara dayanarak cevap vermesini, pasajlarda olmayan bilgiyi UYDURMAMASINI talimatlandırır.
4. **Kaynak gösterimi:** Cevap, hangi nesne(ler)den geldiğini gösteren bir referans listesiyle (`objectId`, `title`, kullanılan snippet) birlikte döner. RBAC filtresi retrieval aşamasında zaten uygulandığından, cevap hiçbir zaman erişimsiz bir nesneye referans veremez (F1-T13 §f deseninin doğal sonucu).
5. **API:** `POST /workspaces/:workspaceId/qa { question }` — `SessionAuthGuard` + `WorkspaceMembershipGuard` (F1-T13 `SearchController` deseni), `question` için aynı DoS-cap-via-rejection konvansiyonu (`MAX_QUESTION_LENGTH`, `.strict()`).
6. **Maliyet/kota entegrasyonu:** QA tamamlama çağrıları `recordAIUsage`/`assertAICostBudgetNotExceeded` (F1-T14) ile AYNI disiplinde ölçülür ve kotalanır — yeni bir mekanizma icat edilmez.

## Kapsam DIŞI

- Çok turlu konuşma/takip sorusu bağlamı, çok-adımlı aksiyonlar (F1-T16'nın kapsamı).
- Custom Field metin içeriğinin retrieval'a dahil edilmesi (F1-T13'ün kendi kapsam-dışı maddesi; bu görev de miras alır).
- Gerçek pgvector/ANN indeksine geçiş (ADR-0013 §a'nın ertelediği gelecek-ölçek konusu; bu görev PLAN.md'nin "(pgvector)" notuna rağmen ADR-0013'ün kararını miras alır — aksi ayrı bir ADR/görev).
- Gerçek (bulut) embedding sağlayıcısı — hâlâ `MockEmbeddingProvider` (ADR-0013 §c/§g'nin erteldiği ayrı görev).
- Eval altyapısı, golden-set regresyon testleri (F1-T17'nin kapsamı).
- Streaming cevap (F1-T16/ADR-0008'in kendi kapsam-dışı maddesi).

## Açık Sorular (Plan Aşamasında Netleşecek)

- Pasaj-seviyeli retrieval için (a)/(b)/(c) seçeneklerinden hangisi? (b) `search_index` şemasını değiştirirse ADR-0013'ün sözleşimine dokunur — CLAUDE.md "ADR Ne Zaman Gerekir" madde 2'ye (çok-paketli/gelecek-görevlere dayatılan sözleşim) girebilir, ayrı bir ADR gerektirebilir. (a) şema değişikliği gerektirmediği için daha düşük risklidir ama uzun dokümanlarda snippet kalitesi düşebilir.
- PLAN.md'nin "(pgvector)" notu bilinçli mi terk ediliyor (ADR-0013'ün kararına uyularak), yoksa bu görev kapsamında pgvector'ı yeniden mi değerlendiriyoruz (yeni bir ADR ile)? Varsayılan öneri: ADR-0013'ün kararına uyulur, pgvector ertelenir — ancak bu insan onayı gerektiren bir sapma noktasıdır.
- `selectAIModel`'e eklenecek QA görev tipi hangi modele yönlendirilecek (maliyet/kalite dengesi — retrieved pasaj sayısı arttıkça prompt uzar, ucuz model mi yoksa güçlü model mi varsayılan olacak)?

## Kabul Kriterleri

- [ ] Bir soru sorulduğunda, workspace içeriğinden (nesne başlığı + doküman metni) alakalı pasajlar retrieval ile bulunur ve cevap yalnızca bu pasajlara dayanarak üretilir (testli, `MockProvider` + `MockEmbeddingProvider` ile deterministik).
- [ ] Cevap, kaynak gösterdiği nesnelerin listesini (`objectId`, `title`, snippet) döner; pasajlarda bulunmayan bilginin uydurulmadığı (prompt şablonunun bunu zorladığı) testli doğrulanır.
- [ ] Erişimi olmayan bir nesnenin içeriği ne cevapta ne kaynak listesinde sızmaz (RBAC query-time filtresi F1-T13 deseniyle miras alınır, testli).
- [ ] QA tamamlama çağrıları `aiUsageRecords`'a model + `$` maliyetiyle kaydedilir ve mevcut $ bütçe/token kotası kontrolüne (istek ÖNCESİ, `QuotaExceededError`) tabidir; regresyonsuz (testli).
- [ ] security-reviewer: soru metni, retrieved pasajlar, prompt ve tamamlanma metninin hiçbir yerde loglanmadığı doğrulanır (ADR-0008 disiplini korunur).
