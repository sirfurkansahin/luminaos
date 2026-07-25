# ADR-0008: AI Alanları — Sağlayıcıdan Bağımsız ai-gateway, Yapısal AI→AI Kademelenme Koruması ve Kümülatif Kota

**Durum:** Kabul edildi
**Tarih:** 2026-07-25
**İlgili görev:** [F1-T5 — AI Fields + ai-gateway v0](../specs/F1-E1/F1-T5-ai-fields.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E1: Lumina Object Modeli" (F1-T5 satırı) ve CLAUDE.md "Kodlama Sözleşmeleri": _"AI çağrıları yalnızca `packages/ai-gateway` üzerinden; sağlayıcı SDK'sını doğrudan import etme."_ — ayrıca "Asla Yapma": _"Kullanıcı verisini veya API anahtarını log'a yazma."_

> Bu ADR dokümantasyon amaçlıdır (F1-T2/ADR-0005, F1-T3/ADR-0006, F1-T4/ADR-0007 emsali): kararlar planlama sırasında gerekçelendirildi ve 4 PR boyunca (`packages/ai-gateway` iskeleti → `ai` alan tipi → sunucu entegrasyonu → eval iskeleti) sırayla uygulandı, her biri `security-reviewer` denetiminden geçti. Bu ADR, koddan SONRA, gerçekleşen mimariyi belgeler.

## Bağlam

F1-T4 (ADR-0007), değeri her zaman HESAPLANAN ilk alan tipini (`formula`) kurmuştu — deterministik, saf bir ifade motoruyla. F1-T5, aynı "asla doğrudan yazılamaz, her zaman hesaplanır" desenini tekrarlıyor, ama hesaplama artık deterministik değil: bir LLM sağlayıcısına (Anthropic) gerçek bir ağ çağrısı. Bu, CLAUDE.md'nin daha önce yalnızca bir kural olarak var olan ("AI çağrıları yalnızca ai-gateway üzerinden") maddesini ilk kez gerçek koda dönüştüren görev.

Çözülmesi gereken merkezi sorular: (1) sağlayıcı SDK'sı (`@anthropic-ai/sdk`) repo genelinde nasıl TEK bir pakete hapsedilir, hem sözleşme hem de derleme-öncesi zorunlu kılınmış bir kuralla; (2) `ANTHROPIC_API_KEY` yokken sunucu nasıl davranır (spec önkoşul olarak anahtarı zorunlu gösteriyordu, ama üretim-dışı/geliştirme ortamlarının anahtarsız açılabilmesi gerekiyordu); (3) bir AI alanının KENDİ sistem-hesaplanmış yazımı, `onSourceChange` tetikleyicisi üzerinden BAŞKA bir AI alanının yenilenmesini tetikleyip sonsuz/kontrolsüz bir kademelenmeye yol açabilir mi, ve bu yapısal olarak nasıl imkansız kılınır (çalışma-zamanı kontrolü değil); (4) bir workspace'in AI harcamasını sınırlayan kota nasıl modellenir ve eşzamanlı isteklere karşı nasıl korunur; (5) prompt içeriği (potansiyel olarak hassas kullanıcı verisi taşıyan) hiçbir logta asla görünmediği nasıl kanıtlanır.

## Karar

### (a) `packages/ai-gateway` — sağlayıcıdan bağımsız kapı, iki bağımsız katmanda zorunlu kılınmış sınır

`AIProvider` arayüzü (`provider.ts`): `complete(request: {prompt, maxTokens?}): Promise<{text, usage: {inputTokens, outputTokens}}>` — hem `AnthropicProvider` (gerçek SDK, API anahtarı constructor parametresi olarak alınır, `db/client.ts`'in "bağlantı stringi parametre olarak gelir" deseniyle aynı) hem `MockProvider` (deterministik, testler için, sabit veya fonksiyon-tabanlı responder) bu tek arayüzü uygular. `withRetry` (`retry.ts`), üstel geri çekilme + varsayılan max 2 deneme sağlayan, saf ve fake-timer'la test edilebilir küçük bir yardımcı.

**Sınır iki bağımsız katmanda zorunlu kılınmış:**

1. **Lint-seviyesi (derleme öncesi).** `tooling/eslint/base.js`'e repo-geneli bir `no-restricted-syntax` kuralı eklendi (`@anthropic-ai/sdk` import/import-expression'larını hedefler), yalnızca `packages/ai-gateway/eslint.config.js` bu kuralı kendi paketi için kapatır. **Bilinçli olarak `no-restricted-imports` DEĞİL** — ESLint flat-config, aynı isimli kuralları cascade boyunca TAMAMEN üzerine yazar, birleştirmez; `packages/core-objects/eslint.config.js` zaten kendi `no-restricted-imports` bloğunu taşıyor (React/NestJS yasağı için) ve bu, aynı isimli bir Anthropic-yasağını SESSİZCE ezerdi. `no-restricted-syntax`, bu paket dışında hiçbir yerde kullanılmayan, çakışmasız bir kural adı seçilerek bu tuzaktan kaçınıyor — `tooling/eslint/anthropic-sdk-ban.test.ts` bunu, hem yasağın `packages/core-objects`'te (kendi `no-restricted-imports` override'ına rağmen) hayatta kaldığını hem `packages/ai-gateway`'de doğru şekilde kapalı olduğunu doğrulayarak kanıtlıyor.
2. **Sözleşme-seviyesi.** `ObjectsService`/`ai-provider.module.ts` yalnızca `@luminaos/ai-gateway`'in genel tiplerini/sınıflarını (`AIProvider`, `AnthropicProvider`, `MockProvider`) import eder — hiçbir yerde `@anthropic-ai/sdk` doğrudan import edilmez.

**Loglama disiplini:** `AnthropicProvider`, `MockProvider`, `retry.ts`, `AIRefreshScheduler` ve `ObjectsService`'in hiçbiri prompt/tamamlanma METNİNİ hiçbir log çağrısına argüman olarak geçirmez — yalnızca meta (model adı, token sayıları, deneme sayısı gibi) loglanabilir, bu da `apps/server/src/observability/redact.ts`'in bilinen kör noktasına (yalnızca OBJE ANAHTARLARINI maskeler, string DEĞER içeriğini değil) güvenmek yerine YAPISAL olarak sağlanır — redaction katmanına bel bağlanmadı. `pino-http`'nin `quietReqLogger`/`quietResLogger` yapılandırması zaten hiçbir request body'sini serileştirmiyor, bu yüzden `defineField`'ın `promptTemplate`'i de dolaylı olarak sızmıyor. `security-reviewer`, ayrı bir test (`anthropic-provider.test.ts`) ile bunu doğruladı.

### (b) `ai` alan tipi — 14. `FieldType`, formül alanının paralel ama AYRI ikizi

`field-type-registry.ts`'e 14. case: `config: {promptTemplate, sourceFields[], outputType: 'text'|'select', refreshMode: 'manual'|'onSourceChange', options?}` — `outputType: 'select'` iken `options` zorunlu+boş-olmayan, `'text'` iken yasak (zod `.strict()` + cross-field `.refine()`).

`field-commands.ts`'teki `assertAIFieldRules`, F1-T4'ün `assertFormulaFieldRules`'ıyla İKİ kuralı PAYLAŞIR (ortak `assertNoDefaultValueOrEditPermission` yardımcısına çıkarıldı — `defaultValue` reddi, `'edit'` izni reddi), ama KASITLI OLARAK döngü tespiti YAPMAZ: bir `ai` alanı `sourceFields` ile başka bir `ai` alanına referans verebilir, hiçbir graf-döngü reddi olmadan (spec'in AC'si yalnızca "AI kaynaklı değişiklik yeni AI yenilemesi tetiklemez" istiyor — bkz. (d) — tam bir AI-AI bağımlılık-grafiği döngü reddi istemiyor; kapsam dışı bırakıldı).

**Hata değeri paralel, PAYLAŞILMAMIŞ:** `AIFieldErrorValue = {aiFieldError: true, message: string}` (`fields/ai/ai-value.ts`), F1-T4'ün donmuş `FormulaErrorValue`'sunu YENİDEN KULLANMAK yerine standalone tanımlandı — aynı "hiçbir birincil değer tipiyle çakışmaz, jsonb'a sorunsuz round-trip eder" gerekçesiyle (ADR-0007 §b), ama ayrı bir tip olarak, formül alanının donmuş kodunu hiç değiştirmeden.

### (c) Sunucu entegrasyonu — `refreshAIField`, ilk gerçek `'agent'` aktör kullanımı, ve senkron-olmayan bir yazım deseni

`ObjectsService.refreshAIField(workspaceId, objectId, fieldKey, actor, callerRole)`, F1-T4'ün `recomputeFormulaFields`'ının ASYNC versiyonu — ama KAVRAMSAL olarak benzer, LİTERAL olarak paylaşılmıyor: formül yeniden-hesaplaması senkron ve `setFieldValues`'ın kendi request-cycle'ı içinde `wrapDrafts` ile İKİ KEZ çağrılıp TEK bir `append()`'e birleştiriliyordu; AI yenilemesi asenkron (ağ çağrısı) olduğundan bu deseni birebir paylaşamıyor — kendi, ayrı bir atomik `append()` çağrısı yapıyor (manuel `POST .../refresh` veya zamanlanmış `onSourceChange` kademesinden bağımsız).

`AI_GATEWAY_ACTOR = {type: 'agent', id: 'ai-gateway'}` — `packages/shared`'ın `Actor` zarfındaki `'agent'` tipinin İLK GERÇEK ÜRETİM KULLANIMI (ADR-0007'nin `'system'` tipini formula-engine için ilk gerçek kullanıma açması gibi). Her refresh'in kendi sistem-hesaplanmış `FieldValueChanged` yazımı, DAİMA bu aktörle damgalanır — tetikleyen ne olursa olsun (manuel veya `onSourceChange`).

`setFieldValues`, `formula`'nın direkt-yazım reddiyle AYNI desende `ai` alanlarına doğrudan yazımı reddeder (`ValidationError`, 400) — alan gerçekten var ve tipi `GET` ile keşfedilebilir olduğundan, bu bir izin-403 veya varlık-gizleyen-404 değil, yapısal-doğrulama 400'ü.

### (d) `onSourceChange` — in-process debounce, AI→AI kademelenmesi ÇALIŞMA-ZAMANI KONTROLÜ değil, YAPISAL imkansızlık

Yeni `AIRefreshScheduler` (`apps/server/src/ai/`), basit bir `Map<string, NodeJS.Timeout>` (anahtar: `` `${objectId}:${fieldKey}` ``) — `schedule()` aynı anahtar için tekrar çağrılırsa mevcut zamanlayıcıyı iptal edip süreyi baştan başlatır (klasik debounce), `refreshFn` başarısızlıklarını `InProcessEventBus.logRejection`'ın (F0-T6) "asla ham içerik loglama" disipliniyle aynı şekilde, generic bir mesajla yutar.

**Merkezi mimari karar:** "değişen bir alan, `onSourceChange` bir AI alanının kaynağı mı?" kontrolü SADECE `ObjectsService.setFieldValues` içinde (kullanıcı-tetiklemeli yazım yolu) yaşıyor, ve `refreshAIField`'ın KENDİ iç `FieldValueChanged` yazımından HİÇBİR ZAMAN çağrılmıyor. `refreshAIField`'ın kendi yazımı asla `setFieldValues`'a geri girmediğinden, kademelenme YAPISAL OLARAK imkansız — bir çalışma-zamanı "bu AI-kaynaklı mı" kontrolüne (unutulabilir, test edilmesi gereken bir invariant) değil, kod yoluna bağlı. `object-ai-refresh.integration.test.ts`, bunu iki zincirli `ai` alanıyla (`summary` ← `price`, `summaryOfSummary` ← `summary`) uçtan uca kanıtlıyor: `summaryOfSummary` HİÇBİR ZAMAN otomatik tetiklenmiyor.

`AIRefreshScheduler`'ın kendi kurucusu bir `number` (debounce gecikmesi) alıyor — NestJS DI, bir çıplak `Number` token'ını otomatik çözemediğinden (yapıcı-parametre yansımasıyla ilkel tipler enjekte edilemez), `ObjectsModule`'de bu bir `useFactory` provider'ı olarak (`AI_PROVIDER`'ın kendi `useFactory`'siyle aynı desende) `env.aiRefreshDebounceMs` ile kaydediliyor.

### (e) Kota — hiç sıfırlanmayan kümülatif toplam, workspace-bazlı Postgres advisory lock'la TOCTOU-güvenli

**Kullanıcı-onaylı tasarım kararı:** kota, dönemsel/faturalama-döngüsü sıfırlaması OLMAYAN, workspace başına kümülatif bir toplam — `ai_usage_records` (append-only, her `AIUsageRecorded` olayı/sağlayıcı-çağrı-denemesi için bir satır) üzerinden `SUM(inputTokens + outputTokens)` ile hesaplanır, `refreshAIField` başına TAM BİR KEZ kontrol edilir (iki select-retry denemesi arasında YENİDEN kontrol edilmez).

**`ANTHROPIC_API_KEY` opsiyonel (kullanıcı-onaylı):** yoksa (`env.anthropicApiKey === undefined`), DI otomatik olarak `MockProvider`'a düşer (`ai-provider.module.ts`'nin `unconfiguredResponder`'ı) — `DATABASE_URL`/`REDIS_URL` gibi sert bir `process.exit` YOK. Testler, hiçbir zaman gerçek bir anahtar ayarlamadan, prompt'a gömülü bir `"RETURN:<değer>"` yönergesiyle yanıtı deterministik olarak script'liyor.

**Güvenlik denetiminde bulunan ve kapatılan bir TOCTOU yarışı:** ilk sunucu-entegrasyonu implementasyonu, kota kontrolünü (bir `SELECT`) ile kullanım kaydını (sağlayıcı çağrısından SONRA bir `INSERT`) arasında hiçbir eşzamanlılık koruması taşımıyordu — aynı workspace için iki eşzamanlı `POST .../refresh` isteği, her ikisi de AYNI ön-çağrı toplamını okuyup ikisi de ilerleyebilir, workspace'in gerçek harcamasını kotanın katbekat üzerine çıkarabilirdi. Bu, ELDE EDİLEN bir entegrasyon testiyle (`object-ai-refresh.integration.test.ts`'in "two CONCURRENT refresh operations" senaryosu) doğrulandı — düzeltme öncesi çalıştırıldığında, iki eşzamanlı istek beklenmedik bir `409` (nesnenin kendi event-stream'inde iyimser-eşzamanlılık çakışması) üretiyordu, ki bu da düzeltmenin yalnızca kota-kontrolünü değil `refreshAIField`'ın TÜM kritik bölümünü (kota kontrolünden son `FieldValueChanged` yazımına kadar) serileştirmesi gerektiğini kanıtladı.

**Çözüm:** `withWorkspaceAILock` — havuzdan çıkarılmış ADANMIŞ bir bağlantı üzerinde `pg_advisory_lock(hashtext(workspaceId)::bigint)`/`pg_advisory_unlock`, `refreshAIField`'ın tüm gövdesini (kota kontrolünden son yazıma kadar) sarmalıyor. Kilit, gerçek `AIProvider.complete()` çağrısı boyunca AÇIK tutuluyor — bu, dış bir HTTP çağrısı boyunca bir DB transaction'ı açık tutmak yerine BİLİNÇLİ OLARAK kabul edilen bir v0 ödünleşimi (yenilemeler sık bir yol değil: manuel veya debounce'lu), basit ve iyi anlaşılır bir doğruluk garantisi karşılığında. Yalnızca AYNI workspace'teki eşzamanlı yenilemeler serileşiyor; farklı workspace'lerin yenilemeleri hiçbir zaman birbirini beklemiyor.

### (f) Eval iskeleti — F1-T17'nin tohumu, `pnpm test` altında Testcontainers'sız koşan saf bir karar fonksiyonu

`refreshAIField`'ın "prompt render et → sağlayıcıyı çağır → select doğrula/tekrar dene → hata değeri üret" karar mantığı, `ObjectsService`'ten `apps/server/src/ai/resolve-ai-field-value.ts` (+`render-ai-prompt.ts`) altında SAF, DB'den bağımsız bir fonksiyona ÇIKARILDI (davranış değişmedi — mevcut PR-C testleri, hem birim hem entegrasyon, değişmeden yeşil kaldı). Bu ayrıştırma, `docs/evals/ai-fields.md` + `ai-fields.eval.test.ts`'in 10 golden senaryosunun, gerçek Postgres/HTTP'ye ihtiyaç duymadan, düz `pnpm test` altında (spec'in kendi şartı: "Normal CI test koşusunda çalışır") koşabilmesini sağlıyor — F1-T17'nin tam eval altyapısının tohumu.

### (g) Güvenlik-denetimi bulguları ve çözümleri (özet)

1. **Orta bulgu — kota kontrolünün TOCTOU yarışı (yukarıda §e).** Workspace-bazlı Postgres advisory lock ile kapatıldı, yeni bir eşzamanlılık entegrasyon testiyle kanıtlandı.
2. **Düşük/orta bulgu — kabul edilen v0 sınırlaması: rate-limiting altyapısı yok.** `apps/server`'ın hiçbir yerinde (bu görevden ÖNCE de) rate-limiting altyapısı (`@nestjs/throttler` vb.) yok — bu, maliyeti doğrudan gerçek paraya bağlı İLK route (`POST .../refresh`) olduğundan daha önemli hale geliyor, ama altyapısı hiç var olmayan bir şeyi bu görev kapsamında eklemek kapsam-dışı bırakıldı; ayrı bir takip görevi önerildi.
3. **Bilgi amaçlı/kabul edilen — sınırsız kaynak-alan boyutu.** `text`/`longText` alanlarının `.max()` uzunluk doğrulaması yok (F1-T2'den beri var olan, bu görevin YARATMADIĞI bir boşluk) — artık gerçek bir ücretli API çağrısına bağlı olduğundan önemi arttı, ama düzeltmesi bu görevin kapsamı dışında bırakıldı.
4. **Prompt/tamamlanma içeriğinin hiçbir yerde loglanmadığı doğrulandı** (§a) — spec'in kendi AC'si.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- Tüm AI sağlayıcı çağrıları, hem lint-seviyesinde (derleme-öncesi, çakışmasız bir kural adıyla) hem sözleşme-seviyesinde tek bir pakete (`ai-gateway`) hapsedildi.
- `ai` alanı, `formula`'nın "asla doğrudan yazılamaz, her zaman hesaplanır, asla throw etmez" desenini paylaşıyor ama kendi bağımsız hata tipini ve (bilinçli olarak) döngü-serbest bir bağımlılık modelini taşıyor.
- AI→AI kademelenme, çalışma-zamanı kontrolüne değil, kod-yolu yapısına (kademelenme tetikleyicisinin yalnızca kullanıcı-tetiklemeli yazım yolunda yaşaması) dayanan, yapısal olarak imkansız bir garanti.
- Workspace-bazlı kümülatif kota, gerçek bir eşzamanlılık yarışına (test edilip kanıtlanmış) karşı bir Postgres advisory lock'la korunuyor.
- `ANTHROPIC_API_KEY` opsiyonel — sunucu anahtarsız da güvenle açılıyor, MockProvider'a düşüyor; hiçbir test gerçek bir anahtar gerektirmiyor.
- Eval altyapısının tohumu, gerçek karar mantığını (DB'den ayrıştırılmış, saf bir fonksiyon olarak) `pnpm test` altında deterministik koşan 10 golden senaryoyla kanıtlıyor.

**Neyi erteliyoruz:**

- Rate-limiting altyapısı (bu görevin YARATMADIĞI, ama önemi artan bir ön-koşul boşluğu) — ayrı bir takip görevi.
- `text`/`longText` alan değeri uzunluk sınırı (F1-T2'den beri var olan boşluk) — ayrı bir takip görevi.
- Çoklu model yönlendirme, streaming, sohbet arayüzü (spec'in kendi kapsam-dışı maddesi, F1-T14/T15/T16).
- `ai` alanları için tam bağımlılık-grafiği döngü tespiti (spec'in AC'si yalnızca AI→AI kademelenme-yok istiyor, tam döngü reddi istemiyor — bilinçli olarak kapsam dışı).
- F1-T17'nin tam eval altyapısı (skorlama, insan değerlendirmesi, model karşılaştırması) — bu görev yalnızca tohumu attı.
