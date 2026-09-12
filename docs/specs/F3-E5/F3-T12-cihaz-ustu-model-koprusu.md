# F3-T12 — Cihaz Üstü Model Köprüsü: Hassas Veri Sınıflandırıcısı → Yerel/Bulut Yönlendirme Politikası

**Epik:** F3-E5 (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]) · **Durum:** Planlandı — Epiğin İLK görevi, Epik F3-E4 (F3-T10/ADR-0044 + F3-T11/ADR-0045) `main`'e tam olarak merge edildikten sonra. Mimari karar `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** ADR-0029 (`docs/adr/ADR-0029-hibrit-ai-veri-siniflandirmasi.md`) — dört-kademeli hassas-veri sınıflandırması (bu görev Kademe 0-3'ü kod-seviyesinde ilk kez somutlaştırıyor). ADR-0045 Karar (i) — ham sayısal agregat + sorgu alan anahtarlarının Kademe 3'e sınıflandırılması emsali, bu görevin "kademe her zaman çağrı yerinde beyan edilir, otomatik çıkarsanmaz" tasarımına doğrudan girdi sağlıyor. `packages/ai-gateway`'in mevcut `AIProvider`/`AnthropicProvider`/`MockProvider` sözleşmesi (bu görev OKUR, sıfır değişiklik yapar — yalnızca ÜÇÜNCÜ bir uygulama, `LocalProvider`, ekler).

## Amaç

`docs/PLAN.md` satır 298'in vaadi: LuminaOS'in gelecekte cihaz-üstü (on-device) model çıkarımına geçebilmesi için, hangi verinin yerel bir modele, hangisinin buluta gidebileceğine karar veren bir sınıflandırıcı/yönlendirme SÖZLEŞİMİ kurmak. ADR-0046'da tam sabitlendi: bu görev GERÇEK bir cihaz-üstü çıkarım motoru KURMUYOR — yalnızca ADR-0029'un dört kademesini kod olarak temsil eden bir tip (`SensitivityTier`), o kademeye göre yerel/bulut kararı veren saf bir politika (`AIRoutingPolicy`), ve bu kararın gerçekten bir `AIProvider`'a dispatch edilebildiğini yapısal olarak kanıtlayan sabit-yanıtlı bir stub (`LocalProvider`) inşa ediyor.

## Kapsam

1. `packages/ai-gateway/src/sensitivity-tier.ts` (YENİ) — `SensitivityTier` tipi (`'tier0'|'tier1'|'tier2'|'tier3'`, ADR-0029'un Kademe 0-3'üne birebir karşılık), `SENSITIVITY_TIERS` sabit dizisi, `isSensitivityTier()` type-guard (ADR-0046 Karar b).
2. `packages/ai-gateway/src/routing-policy.ts` (YENİ) — `AIRoutingDestination` (`'local'|'cloud'`), `ClassifiedAIRequest` (`{tier, request}` — `request` mevcut `AICompletionRequest`'i AYNEN kullanır), `AIRoutingPolicy` arayüzü + v0 somut uygulaması `StaticTierRoutingPolicy` (Kademe 0/1/2 → `'local'`, Kademe 3 → `'cloud'`, geçersiz `tier` için `ValidationError`) (ADR-0046 Karar b/c).
3. `packages/ai-gateway/src/local-provider.ts` (YENİ) — `LocalProvider implements AIProvider`: sabit/mock bir `AICompletionResult` döner (`usage: {inputTokens:0, outputTokens:0}`), GERÇEK model ağırlığı/çıkarım İÇERMEZ (ADR-0046 Karar c).
4. `packages/ai-gateway/src/index.ts` genişlemesi — üç yeni dosyanın `AnthropicProvider`/`MockProvider`'la AYNI desende re-export edilmesi.
5. `packages/shared`'in `ValidationError`'ının (mevcut, değişiklik YOK) `StaticTierRoutingPolicy`'nin geçersiz-`tier` durumunda fırlatılması için import edilmesi (`packages/ai-gateway`'in `@luminaos/shared`'e ZATEN var olan bağımlılığı, YENİ bir paket-bağımlılığı DEĞİL).

## Bağlayıcı İnsan Kararları (ADR-0046'dan, AYNEN kayıtlı — tekrar tartışılmaz)

1. **Yönlendirme YERİ: istemci-tarafı, `apps/desktop` (Tauri).** Düşük kademeli veri (yerelde çıkarsanabildiği ölçüde Kademe 0-2) cihaz-üstü modele; Kademe 3 veya yerel model yokken MEVCUT sunucu-taraflı ai-gateway/bulut yoluna DEĞİŞMEDEN düşer. `apps/server/src/ai/*` ve tüm mevcut orkestratörler (`parseCommand`/`answerQuestion`/`compileWidgetQuery`/`generateArtifact`/`explainDeviation`) SIFIR değişiklik görür.
2. **Kapsam: arayüz-öncelikli, yerel sağlayıcı bir STUB.** Bu görev (a) saf `classify`/tip; (b) `AIProvider`-şekilli, GERÇEK model ağırlığı/çıkarım OLMAYAN bir `LocalProvider` stub'ı; (c) beyan edilen kademeye göre yönlendirme kararı veren bir sözleşim (`AIRoutingPolicy`) inşa eder. Gerçek bir çıkarım motorunun (ONNX/WebGPU/llama.cpp/Ollama vb.) seçimi/entegrasyonu, gerçek model ağırlıkları, gerçek çıkarım — KAPSAM DIŞI, gelecekteki bir görev.
3. **Sınıflandırma girdi modeli: statik, çağrı-yerinde-beyan edilen kademe.** `classify()`/`route()` çağırandan AÇIKÇA BEYAN EDİLMİŞ bir kademe alır (ADR-0045 Karar i'nin emsali) — ham metin/içeriği PARSE EDEREK hassasiyeti algoritmik olarak ÇIKARSAMAZ.

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0046-cihaz-ustu-model-koprusu.md` Karar (a)-(d) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Yerleşim:** `packages/ai-gateway` içinde (`apps/desktop` içinde DEĞİL) — `AIProvider`/`AnthropicProvider`/`MockProvider`'ın ZATEN yaşadığı paket, "sağlayıcı SDK'sı/uygulaması tek pakete hapsedilir" ilkesinin doğrudan devamı. `apps/desktop` bu paketi bugün TÜKETMİYOR bile (bu görev bunu da DEĞİŞTİRMİYOR — bkz. Kapsam Dışı) ama gelecekteki wiring görevi bunu doğrudan tüketecek.
- **(b) `SensitivityTier`/`isSensitivityTier`:** ADR-0029'un Kademe 0-3'ünün kapalı, İngilizce-tanımlayıcılı (`tier0..tier3`, kod tabanının `aggregateFn`/`outputType` konvansiyonuyla tutarlı) enum karşılığı. Hiçbir fonksiyon içerik PARSE ETMEZ.
- **(c) `AIRoutingPolicy`/`StaticTierRoutingPolicy`:** `route({tier, request}): 'local'|'cloud'` — v0 sabit eşleme (Kademe 0/1/2→local, Kademe 3→cloud), geçersiz `tier`'da `ValidationError`.
- **(d) `LocalProvider`:** `AIProvider`'ın üçüncü somut uygulaması, sabit/mock yanıt, `MockProvider`'dan (test-double) kasıtlı olarak AYRI bir sınıf (kimlik karışıklığını önlemek için).
- **(e) Dispatch:** Bu görev hiçbir "hepsi-bir-arada" dispatcher sınıfı KURMUYOR — `route()`'un döndürdüğü karara göre HANGİ somut `AIProvider`'ın çağrılacağına ÇAĞIRAN karar verir; bu görev bu kablolamayı `apps/desktop`'a YERLEŞTİRMİYOR (Kapsam Dışı).

## PR Bölünmesi (1 PR, tek plan onayı kapsar)

1. **PR1 — `packages/ai-gateway` sözleşim + stub (tek paket, sıfır I/O, sıfır framework).** `sensitivity-tier.ts`, `routing-policy.ts`, `local-provider.ts`, `index.ts` genişlemesi. **Neden TEK PR (2 değil):** üç dosya da aynı paket içinde, aynı mimari kararın (ADR-0046) üç tamamlayıcı parçası — `SensitivityTier` olmadan `AIRoutingPolicy`'nin `tier` alanı anlamsız, `AIRoutingPolicy` olmadan `LocalProvider`'ın hangi kararla çağrılacağı test edilemez; bunları ayrı PR'lara bölmek yalnızca yapay bir ara-durum (ör. "kademe tipi var ama hiçbir yönlendirme mantığı yok") yaratır, gözden geçirilebilirlik kazandırmaz. Toplam kod ölçeği (3 kaynak dosya + 3 test dosyası, tümü saf/senkron/sıfır-mock-collaborator) mimari-kritik ±400 satır sınırının rahatça altında kalacak kadar küçük. Testler: `isSensitivityTier` geçerli/geçersiz değerler için doğru `true`/`false` döndürüyor; `StaticTierRoutingPolicy.route()` `tier0`/`tier1`/`tier2` için `'local'`, `tier3` için `'cloud'` döndürüyor; geçersiz/bilinmeyen bir `tier` string'i için `ValidationError` fırlatıyor (İnsan kararı 3'ün "yalnızca gerçek enum değerini doğrula" sınırının regresyon kanıtı); `LocalProvider.complete()` her zaman `usage: {inputTokens:0, outputTokens:0}` içeren sabit bir `AICompletionResult` döndürüyor, girdi `request`'ten BAĞIMSIZ (gerçek çıkarım YAPMADIĞININ regresyon kanıtı); `packages/ai-gateway/src/index.ts`'in üç yeni sembolü de re-export ettiği (paket-dışından `import { SensitivityTier, AIRoutingPolicy, StaticTierRoutingPolicy, LocalProvider } from '@luminaos/ai-gateway'` çalışıyor).

## Kapsam Dışı

- **Gerçek bir cihaz-üstü çıkarım motorunun (ONNX Runtime/WebGPU/llama.cpp/Ollama vb.) seçilmesi veya entegrasyonu** (İnsan kararı 2'nin reddettiği alternatif) — Açık Soru (a).
- **Gerçek model ağırlıkları veya gerçek çıkarım** — `LocalProvider` sabit/mock bir metin döner.
- **`apps/server/src/ai/*` veya mevcut herhangi bir orkestratörde (`parseCommand`/`answerQuestion`/`compileWidgetQuery`/`generateArtifact`/`explainDeviation`) değişiklik** (İnsan kararı 1'in bağlayıcı sınırı) — sıfır değişiklik.
- **Bu yeni sözleşimin `apps/desktop`'a bağımlılık olarak eklenmesi veya herhangi bir UI/kullanıcı-görünür akışa kablolanması** — `apps/desktop/package.json`'a `@luminaos/ai-gateway` bağımlılığı bu görevde EKLENMİYOR (henüz hiçbir `apps/desktop` kodu bu paketi tüketmeyecek, kullanılmayan bir bağımlılık eklemek erken/gereksiz olurdu) — takip görevi bu bağımlılığı, GERÇEK bir tüketim noktasıyla BİRLİKTE ekleyecek.
- **İçerik-analizi tabanlı otomatik hassasiyet tespiti** (İnsan kararı 3'ün kesin biçimde reddettiği alternatif).
- **Kademe→yönlendirme eşlemesinin workspace-bazlı yapılandırılabilir hale getirilmesi** — v0 `StaticTierRoutingPolicy` sabit, Açık Soru (b).
- **Yerel sağlayıcının gerçek token/maliyet raporlaması** — Açık Soru (c).

## Kabul Kriterleri

- [x] **PR1:** `isSensitivityTier()` dört geçerli değer (`'tier0'`,`'tier1'`,`'tier2'`,`'tier3'`) için `true`, geçersiz/rastgele string ve `undefined`/`null`/sayı gibi tip-dışı girdiler için `false` döndürüyor.
- [x] **PR1:** `StaticTierRoutingPolicy.route()` `{tier:'tier0'|'tier1'|'tier2', request}` girdisinde `'local'`, `{tier:'tier3', request}` girdisinde `'cloud'` döndürüyor.
- [x] **PR1:** `StaticTierRoutingPolicy.route()` geçersiz/bilinmeyen bir `tier` değeriyle çağrıldığında `ValidationError` fırlatıyor (içerik-analizi YOK, yalnızca enum-doğrulama regresyon kanıtı).
- [x] **PR1:** `LocalProvider.complete(request)` girdi `request`'in içeriğinden BAĞIMSIZ, her zaman sabit bir `text` + `usage:{inputTokens:0,outputTokens:0}` içeren `AICompletionResult` döndürüyor (gerçek çıkarım YAPMADIĞININ regresyon kanıtı).
- [x] **PR1:** `packages/ai-gateway/src/index.ts`, `SensitivityTier`/`isSensitivityTier`/`AIRoutingPolicy`/`ClassifiedAIRequest`/`AIRoutingDestination`/`StaticTierRoutingPolicy`/`LocalProvider`'ın TÜMÜNÜ paket-dışından import edilebilir şekilde re-export ediyor.
- [x] **PR1:** `apps/desktop/package.json` VE `apps/server/src/ai/*` dosyalarının HİÇBİRİNDE değişiklik yok (import-graph/diff regresyon-doğrulaması).
- [x] **PR1:** `pnpm --filter @luminaos/ai-gateway typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.

## Done

1 PR `main`'e merge edildi:

- **PR1 — `packages/ai-gateway` sözleşim + stub** ([#260](https://github.com/sirfurkansahin/luminaos/pull/260)): `sensitivity-tier.ts` (`SensitivityTier`/`SENSITIVITY_TIERS`/`isSensitivityTier`, ADR-0029'un Kademe 0-3'üne birebir karşılık, kapalı 4-değerli enum), `routing-policy.ts` (`AIRoutingDestination`/`ClassifiedAIRequest`/`AIRoutingPolicy`/`StaticTierRoutingPolicy` — v0 sabit eşleme tier0/1/2→`'local'`, tier3→`'cloud'`, geçersiz `tier`'da `ValidationError`), `local-provider.ts` (`LocalProvider implements AIProvider` — sabit/mock `AICompletionResult`, girdiden BAĞIMSIZ her zaman `usage:{inputTokens:0,outputTokens:0}`, gerçek çıkarım YOK), `index.ts`'in üç yeni dosyayı `AnthropicProvider`/`MockProvider`'la AYNI desende re-export etmesi. Kanıt:
  - `packages/ai-gateway/src/sensitivity-tier.test.ts` — 4 geçerli tier değeri için `true`; geçersiz/malformed string'ler (`'tier4'`, `'TIER0'`, `''`, boşluklu varyantlar) ve tip-dışı girdiler (`undefined`/`null`/sayı/obje/dizi/boolean) için `false`; `SENSITIVITY_TIERS`'in tam olarak 4 elemanlı, sabit sırada olduğu.
  - `packages/ai-gateway/src/routing-policy.test.ts` — `tier0`/`tier1`/`tier2` için `'local'`, `tier3` için `'cloud'`; geçersiz `tier` (`'garbage'`) için `ValidationError` fırlatıldığı (İnsan kararı 3'ün "yalnızca enum-doğrulama, içerik-analizi YOK" regresyon kanıtı); `route()`'un saf/deterministik olduğu ve girdiyi mutasyona uğratmadığı.
  - `packages/ai-gateway/src/local-provider.test.ts` — girdi `request`'in içeriğinden (prompt uzunluğu/model/`maxTokens`) TAMAMEN BAĞIMSIZ, her zaman `usage:{inputTokens:0,outputTokens:0}` döndüğü (gerçek çıkarım YAPMADIĞININ regresyon kanıtı); dönen `text`/`model` alanlarının dolu string olduğu.
  - `packages/ai-gateway/src/index.test.ts` — `isSensitivityTier`/`SENSITIVITY_TIERS`/`StaticTierRoutingPolicy`/`LocalProvider`'ın runtime değer olarak, `AIRoutingDestination`/`ClassifiedAIRequest`/`AIRoutingPolicy`/`SensitivityTier`'ın tip olarak `index.ts` üzerinden paket-dışından import edilebildiği (tip-only re-export'lar `import type` + tip-check ile kanıtlanıyor, davranışsal test mümkün olmadığından).
  - Kaynak kodda doğrulandı (bu kapanış sırasında): `apps/desktop/package.json`'da `@luminaos/ai-gateway` bağımlılığı YOK (`apps/desktop` bu paketi hâlâ tüketmiyor — İnsan kararı 1/kapsam dışı maddesinin regresyon kanıtı); `packages/ai-gateway/src/index.ts`'in yalnızca `sensitivity-tier.ts`/`routing-policy.ts`/`local-provider.ts`'i `export *` ile eklediği, `apps/server/src/ai/*`'a dokunmadığı.

**Epik F3-E5 (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]) durumu:** Bu görev (F3-T12) epiğin İLK görevi — epik HENÜZ KAPANMIYOR. Epiğin İKİNCİ ve SON görevi F3-T13 ("Bildirim bütçeleri, bağlam-değiştirme sayacı, ajan sessiz saatleri, aşırı yük sinyali → yeniden dengeleme önerisi") hâlâ bekliyor; ne ADR'si ne spec dosyası var.

## Açık Sorular

- **(a) Gerçek cihaz-üstü çıkarım motoru seçimi (ONNX Runtime / WebGPU / llama.cpp / Ollama vb.)** — bu görev BİLİNÇLİ OLARAK çözmüyor; ayrı, gelecekteki bir görev/ADR gerektirecek (donanım-uyumluluğu, Tauri'nin native-binding yetenekleri, model-boyutu/indirme stratejisi gibi kendi başına büyük bir karar kümesi).
- **(b) Kademe→yönlendirme eşlemesinin workspace-bazlı yapılandırılabilir hale gelmesi** — bugün `StaticTierRoutingPolicy` SABİT bir kural (Kademe 0-2→local, Kademe 3→cloud); gerçek bir yerel motor devreye girdiğinde bazı workspace'lerin (ör. düşük donanım) hiçbir zaman yerel çalıştıramaması veya bazı workspace'lerin Kademe 2'yi bile buluta göndermeyi TERCİH etmesi gibi ihtiyaçlar doğarsa, bu sabit eşleme yerine bir yapılandırma katmanı gerekebilir — GERÇEK talep doğmadan bu görevde çözülmüyor.
- **(c) Gerçek `LocalProvider`'ın token kullanımı/maliyeti nasıl raporlanmalı** — bugünkü stub sıfırlanmış `AITokenUsage` döner (`inputTokens:0, outputTokens:0`), bu GEÇERLİ çünkü gerçek çıkarım hiç yok; ama gerçek bir cihaz-üstü model devreye girdiğinde "token" kavramının bulut-maliyeti karşılığı (`model-pricing.ts`'in `calculateCostUsd`'si) MUHTEMELEN anlamsız hale gelecek (yerel çıkarımın CPU/GPU/pil maliyeti var, ama sağlayıcı-faturalı bir dolar maliyeti YOK) — bu GERÇEK bir modelleme sorusu, bu görevde ÇÖZÜLMÜYOR, yalnızca not düşülüyor.
- **Bu görev hiçbir UI/kullanıcı-görünür akışa bağlanmıyor** — `SensitivityTier`/`AIRoutingPolicy`/`LocalProvider` bu görevin sonunda yalnızca `packages/ai-gateway`'in izole birim testleriyle doğrulanmış durumda olacak, hiçbir gerçek çağrı yolunda ÇALIŞTIRILMAYACAK; `apps/desktop`'a bağımlılık eklenmesi ve gerçek bir kullanım noktası (ör. bir komut/AI-alan akışının bu politikadan geçmesi) AYRI bir takip görevi.

## Sıradaki adım

F3-T12'nin tamamlanmasıyla Epik F3-E5 (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]) HENÜZ KAPANMADI — `docs/PLAN.md` satır 299'a göre epiğin İKİNCİ ve SON görevi F3-T13: **Bildirim bütçeleri, bağlam-değiştirme sayacı, ajan sessiz saatleri, aşırı yük sinyali → yeniden dengeleme önerisi**. Bu görevin ne ADR'si ne spec dosyası henüz var:

```
docs/PLAN.md'nin Epik F3-E5'inin (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]) ilk görevi
F3-T12'yi (ADR-0046, main'e merge edildi) tamamladığını doğrula; epiğin İKİNCİ ve SON görevi
F3-T13 -- Bildirim bütçeleri, bağlam-değiştirme sayacı, ajan sessiz saatleri, aşırı yük sinyali
→ yeniden dengeleme önerisi (henüz ne ADR'si ne spec dosyası var). Önce explorer ile şunları
keşfet: (1) kod tabanında mevcut bir bildirim/interrupt altyapısı var mı (varsa nerede, yoksa
bunu doğrula); (2) `apps/desktop/src/consent/` içindeki rıza/erişim modelini VE bu oturumdaki
ADR emsallerinde geçen `AvailabilitySelector`/kullanılabilirlik-durumu benzeri herhangi bir
kavramı -- "ajan sessiz saatleri" için doğrudan emsal olabilir mi; (3) mevcut herhangi bir
ajan-aksiyon-bütçesi/oran-sınırlama kavramını (ör. `InboundMcpRateLimitService`) -- "bildirim
bütçesi" kavramının yapısal emsali olabilir mi; (4) bağlam-değiştirme (context-switch) sayımı
veya aşırı-yük sinyali üreten mevcut herhangi bir mekanizma var mı. Sonra architect ile
docs/adr/ADR-0047-<konu>.md taslağını VE docs/specs/F3-E5/F3-T13-<konu>.md spec dosyasını
oluştur, insana onaylat; sonra plan mode'a geç.
```
