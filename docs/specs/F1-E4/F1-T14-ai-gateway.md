# F1-T14 — `ai-gateway`: Sağlayıcı Soyutlama Genişletmesi, Model Yönlendirme Kuralları, Maliyet/Kota Ölçümü

**Epik:** F1-E4 (AI Servisi v1 + Veri Çıkışı) · **Durum:** Tamamlandı (Kabul Kriterleri 5/5)
**Bağımlılık:** F1-T5 (`packages/ai-gateway` temeli — `AIProvider`, `AnthropicProvider`, `MockProvider`, ADR-0008), F1-T13 (`EmbeddingProvider` soyutlaması — aynı Mock-öncelikli DI deseni emsal alınır)

## Amaç

Bugüne kadar `ai-gateway` (F1-T5, F1-T10, F1-T13 PR1 ile artımlı olarak inşa edildi) yalnızca TEK bir sağlayıcı (Anthropic) ve TEK bir yer-tutucu modeli (`DEFAULT_ANTHROPIC_MODEL = 'claude-placeholder-model'`) destekliyor; kullanım ölçümü yalnızca ham token sayısını (`inputTokens`/`outputTokens`) tutuyor ve workspace-başına TEK bir toplam-token eşiğiyle (`env.aiTokenQuotaPerWorkspace`) kotalanıyor. Bu görev üç somut boşluğu kapatır: (1) aynı sağlayıcı içinde birden fazla gerçek model arasında seçim yapabilme, (2) görev tipine göre hangi modelin kullanılacağına karar veren saf bir yönlendirme kuralı, (3) ham token sayısının ötesinde, model-başına gerçek $ maliyeti hesaplanan ve buna göre bütçelenebilen bir kota modeli.

## Mevcut Durum (keşif — koddan doğrulandı)

- `packages/ai-gateway/src/provider.ts`: `AIProvider.complete(request: {prompt, maxTokens?})` — model seçimi yok, çağıran taraf hangi modelin kullanılacağını hiçbir şekilde etkileyemiyor.
- `packages/ai-gateway/src/anthropic-provider.ts`: `AnthropicProviderOptions.model?` alanı var ama tek bir sabit değere (`DEFAULT_ANTHROPIC_MODEL`, kendi yorumunda "gerçek bir model-adı hiçbir yerde bulunamadı, fiyatlandırma referans dokümanı gelene kadar yer tutucu" diye işaretli) düşüyor — gerçek model adları/çoklu model desteği hiç yok.
- ADR-0008 (F1-T5) kendi "Kapsam Dışı" maddesinde bunu zaten F1-T14'e devretmiş: _"Çoklu model yönlendirme, streaming, sohbet arayüzü (spec'in kendi kapsam-dışı maddesi, F1-T14/T15/T16)."_
- `apps/server/src/ai/ai-usage.projection.ts` + `aiUsageRecords` tablosu: her `AIUsageRecorded` olayı `workspaceId, fieldDefinitionId, objectId, inputTokens, outputTokens` tutuyor — model bilgisi YOK, $ maliyeti YOK.
- `apps/server/src/objects/objects.service.ts` (~satır 1168-1195): kota kontrolü tek bir toplam token eşiğiyle (`totalTokensUsed >= env.aiTokenQuotaPerWorkspace`) yapılıyor, istek ÖNCESİ kontrol ediliyor (iyi bir emsal — bu görev de aynı "önce kontrol et" disiplinini korumalı).
- ADR-0008 kendi bulgularında ayrıca not düşmüş (bu görevin kapsamı DIŞINDA kalan, bilinçli kabul edilmiş bir v0 sınırlaması): `apps/server`'da hiçbir yerde rate-limiting altyapısı yok. Bu görev bunu ÇÖZMEZ, ama maliyet-bazlı kota eklerken bu boşluğu derinleştirmediğinden emin olunmalı.

## Kapsam

1. **Sağlayıcı soyutlama genişletmesi:** `AICompletionRequest`'e opsiyonel bir model-seçim alanı eklenir (ör. `model?: string` veya bir `taskHint`/`complexity` ipucu — tasarım kararı, plan aşamasında netleşir). `AnthropicProvider` gerçek, güncel en az İKİ model adını (ör. hızlı/ucuz bir model ve daha güçlü/pahalı bir model) destekler; `DEFAULT_ANTHROPIC_MODEL` yer-tutucusu gerçek bir varsayılan model adıyla değiştirilir. `MockProvider` de bu yeni alanı (varsa) doğru şekilde yansıtır (deterministik test edilebilirlik bozulmaz).
2. **Model yönlendirme kuralları:** Görev tipine/karmaşıklığına göre hangi modelin kullanılacağına karar veren SAF bir fonksiyon/kural seti (ağ çağrısı yapmaz, deterministik test edilir) — ör. basit sınıflandırma/kısa-metin görevleri ucuz modele, uzun/karmaşık üretim görevleri güçlü modele yönlendirilir. Kurallar sabit config değeridir (ileride genişletilebilir), gerçek bir ML/karar-motoru DEĞİLDİR.
3. **Maliyet ölçümü:** Model-başına sabit fiyatlandırma tablosu (input/output token başına $, config sabiti — gerçek zamanlı bir fiyatlandırma API'sinden ÇEKİLMEZ, v1 için sabit değerler yeterli). Her `AIUsageRecorded` olayı hangi modelin kullanıldığını VE o modelin fiyatlandırmasına göre hesaplanan $ maliyetini taşır. `aiUsageRecords` şeması buna göre genişler (yeni sütun(lar): `model`, `costUsd` veya benzeri).
4. **Maliyet-bazlı kota:** Mevcut token-sayısı kotasına (`aiTokenQuotaPerWorkspace`, GERİYE DÖNÜK UYUMLU kalır, kaldırılmaz) EK OLARAK, workspace-başına bir $ bütçe eşiği (`aiCostBudgetUsdPerWorkspace` veya benzeri env değişkeni) tanımlanabilir ve istek ÖNCESİ kontrol edilir (mevcut "önce kontrol et" deseni korunur, `QuotaExceededError` emsali kullanılır).

## Kapsam DIŞI

- Streaming, sohbet arayüzü, çok adımlı konuşma komutları (F1-T16'nın kapsamı, ADR-0008'in kendi kapsam-dışı maddesi).
- Gerçek RAG/pgvector soru-cevap ve kaynak gösterimi (F1-T15).
- Rate-limiting altyapısı eklemek (ADR-0008'de zaten bilinçli v0 sınırlaması olarak kabul edilmiş, ayrı bir gelecek görev — bu görev yalnızca mevcut boşluğu DERİNLEŞTİRMEDİĞİNDEN emin olur, ÇÖZMEZ).
- Gerçek zamanlı/dinamik model fiyatlandırma API entegrasyonu (v1'de sabit config tablosu yeterli).
- `EmbeddingProvider` için gerçek bir sağlayıcı (F1-T13/ADR-0013'ün kendi kapsam-dışı maddesi, ayrı görev — bu görev yalnızca `AIProvider`/completion tarafını kapsar).
- Eval altyapısı, model karşılaştırma/skorlama (F1-T17'nin kapsamı).

## Kabul Kriterleri

- [x] `AIProvider`/`AnthropicProvider`, en az iki gerçek model arasında seçim yapabilir; `DEFAULT_ANTHROPIC_MODEL` yer-tutucusu gerçek bir model adıyla değiştirilmiştir (testli, gerçek ağ çağrısı gerektirmez — `AnthropicClientLike` sahte istemci emsali).
- [x] Model yönlendirme kuralı saf bir fonksiyon olarak var, girdi (görev tipi/ipucu) → çıktı (seçilen model) eşlemesi deterministik test edilir.
- [x] Her yeni `AIUsageRecorded` olayı kullanılan modeli ve o modele göre hesaplanmış `$` maliyetini taşır; `aiUsageRecords` projeksiyonu bunları kalıcı kılar (testli).
- [x] Workspace-başına $ bütçe eşiği, mevcut token-kotası deseniyle aynı disiplinde (istek ÖNCESİ kontrol, `QuotaExceededError`) uygulanır; mevcut `aiTokenQuotaPerWorkspace` davranışı regresyonsuz kalır (testli).
- [x] security-reviewer: yeni model-seçim/fiyatlandırma mantığının hiçbir yerinde prompt/tamamlanma metni loglanmadığı doğrulanır (ADR-0008'in yapısal loglama disiplini korunur).

## İlerleme Notu

ADR gerekmedi (CLAUDE.md'nin iki gerçek ADR kriterine göre önyargısız değerlendirildi — bkz. plan dosyası: ne bir mimari değişmezle gerilim yaratıyor, ne de yeni bir çok-paketli sözleşim tanımlıyor; ADR-0008'in `AIProvider` sözleşimini artımlı/geriye-uyumlu genişletiyor). 4 alt-PR ile tamamlandı:

- **PR1** (#91): `packages/ai-gateway` — gerçek model ID'leri (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `claude-fable-5`), model→fiyat tablosu (Sonnet 5 için standart $3/$15 fiyatı bilinçli kullanıldı, tanıtım fiyatı değil), `calculateCostUsd`, `AICompletionRequest`/`Result.model?`.
- **PR2** (#92): `apps/server` — `aiUsageRecords` şemasına nullable `model`/`cost_usd` sütunları (geriye dönük uyumlu), projeksiyon genişletmesi.
- **PR3** (#93): `apps/server` — `selectAIModel` (outputType'a göre Haiku/Sonnet yönlendirmesi), `performAIFieldRefresh`'in seçilen modeli tek kaynaktan hem provider çağrısına hem kullanım kaydına iletmesi, `recordAIUsage`'ın best-effort (log-and-swallow) hale getirilmesi.
- **PR4** (#94): `apps/server` — `AI_COST_BUDGET_USD_PER_WORKSPACE` + `assertAICostBudgetNotExceeded`, mevcut token-kotası deseniyle aynı disiplinde.

Uygulama sırasında keşfedilenler: (1) `Number.parseFloat` tabanlı env okuyucular `'25.5abc'`/`'Infinity'` gibi değerleri sessizce kabul edebiliyor — PR4'te sıkı bir regex (`^\d+(\.\d+)?$`) ile kapatıldı, aksi halde bir yapılandırma hatası bütçe kotasını sessizce sınırsız hale getirebilirdi. (2) `recordAIUsage` başlangıçta maliyet hesaplama hatasını yutmuyordu — provider çağrısı zaten başarılı olduktan SONRA çalıştığından, teorik bir `calculateCostUsd` hatası zaten üretilmiş bir AI alan değerini geri alabilirdi; `scheduleTimeBlock` ile aynı best-effort desenine çevrildi (şu an `selectAIModel`'in ürettiği modellerin hepsi `MODEL_PRICING`'de olduğundan erişilemez bir risk, ama gelecekte model seçimi dinamikleşirse önemli).
