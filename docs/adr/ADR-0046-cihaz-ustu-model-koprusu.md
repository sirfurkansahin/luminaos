# ADR-0046: Cihaz Üstü Model Köprüsü — Arayüz-Öncelikli Sınıflandırıcı/Yönlendirme Sözleşmesi, `packages/ai-gateway`'de Yaşayan `LocalProvider` İskeleti (Epik F3-E5'in İLK Görevi)

**Durum:** Kabul edildi
**Tarih:** 2026-09-12
**İlgili görev:** [F3-T12 — Cihaz üstü model köprüsü; hassas veri sınıflandırıcısı → yerel/bulut yönlendirme politikası](../specs/F3-E5/F3-T12-cihaz-ustu-model-koprusu.md). `docs/PLAN.md` satır 298. Epik F3-E5'in (Hibrit AI [Kapsam O] + Refah Katmanı [Kapsam P]) İLK görevi — Epik F3-E4 (F3-T10/ADR-0044 + F3-T11/ADR-0045) `main`'e tam olarak merge edildikten sonra.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin HER İKİ fıkrasını da tetikliyor: (1) bu karar CLAUDE.md'nin kendi "Mimari Değişmezler" listesindeki _"Hassas veri sınıfları buluta ham gönderilmez (bkz. `docs/adr/ADR-000X-hibrit-ai.md`)"_ maddesinin — yani ADR-0029'un — İLK somut kod-sözleşmesini kuruyor; (2) `packages/ai-gateway`'e YENİ bir sağlayıcı-seçici sözleşim (`AIRoutingPolicy`/`SensitivityTier`) ekliyor ve bunu tüketen İLK yeni tüketici olarak `apps/desktop`'ı `ai-gateway`'e bağımlı hale getiriyor — her ikisi de gelecekteki görevlere dayatılan bir kontrat.

> Bu ADR, ADR-0029'un Bilinen Sınırlamalar (a) maddesinin ("kademe sınıflandırması bir kod-seviyesi zorunlu kılma mekanizması İÇERMİYOR") açtığı boşluğu KISMEN kapatan ilk somut kod girişimidir — ama TAM olarak değil: bu görev bir kod-seviyesi ENFORCEMENT mekanizması değil, bir ROUTING SÖZLEŞMESİ kurar (bkz. Karar d, "Bilinen Sınırlamalar"). Aynı zamanda ADR-0029'un Bilinen Sınırlamalar (c) maddesinin ("her yeni sağlayıcı entegrasyonu kendi ADR'sinde bu politikaya göre değerlendirilmeli") gerektirdiği değerlendirmeyi, HENÜZ VAR OLMAYAN, saf bir arayüz-taslağı olan varsayımsal bir yerel sağlayıcı için ÖNCEDEN yapıyor.

## Bağlam

1. **Kod tabanında bugün HİÇBİR cihaz-üstü/yerel model altyapısı yok** (`explorer` doğruladı, tekrar teyit edildi): `packages/`/`apps/` genelinde ONNX/WASM/WebGPU/llama.cpp/Ollama'ya hiçbir referans yok, `packages/ai-gateway` yalnızca 2 somut `AIProvider` uygulaması içeriyor — `AnthropicProvider` (`packages/ai-gateway/src/anthropic-provider.ts`, gerçek, `@anthropic-ai/sdk`'yı sarmalıyor) ve `MockProvider` (`packages/ai-gateway/src/mock-provider.ts`, test double). Bu görev SIFIRDAN bir tasarımdır, mevcut bir yarım-kalmış girişimi TAMAMLAMAZ.
2. **`AIProvider` sözleşmesinin bugünkü tam şekli** (`packages/ai-gateway/src/provider.ts`, doğrulandı):
   ```ts
   export interface AICompletionRequest {
     prompt: string;
     maxTokens?: number;
     model?: string;
   }
   export interface AITokenUsage {
     inputTokens: number;
     outputTokens: number;
   }
   export interface AICompletionResult {
     text: string;
     usage: AITokenUsage;
     model?: string;
   }
   export interface AIProvider {
     complete(request: AICompletionRequest): Promise<AICompletionResult>;
   }
   ```
   `packages/ai-gateway/src/index.ts` bu tipleri + `AnthropicProvider`/`MockProvider`/`retry`/`embedding-provider`/`model-pricing`'i tek bir paket-yüzeyinden re-export ediyor — CLAUDE.md'nin "AI çağrıları yalnızca `packages/ai-gateway` üzerinden" değişmezinin somut kod karşılığı budur.
3. **Sunucu tarafında ZATEN VE BİLİNÇLİ OLARAK sıfır per-request yönlendirme var** (`apps/server/src/ai/ai-provider.module.ts`, doğrulandı): süreç BAŞLARKEN tam olarak BİR `AIProvider` seçilir (`ANTHROPIC_API_KEY` set ise `AnthropicProvider`, değilse `MockProvider`) ve tüm süreç boyunca SABİT kalır — hiçbir istek-bazlı "bu isteği hangi sağlayıcıya gönder" kararı yok. **Bu görev bu süreci DEĞİŞTİRMEZ** — insan kararı 1'in gerektirdiği gibi `apps/server/src/ai/*` ve `parseCommand`/`answerQuestion`/`compileWidgetQuery`/`generateArtifact`/`explainDeviation` orkestratörlerinin HİÇBİRİ bu görevde dokunulmaz.
4. **ADR-0029'un dört kademeli hassas-veri sınıflandırması** (`docs/adr/ADR-0029-hibrit-ai-veri-siniflandirmasi.md`, tam okundu, madde 10 özeti): Kademe 0 (ham biyometrik ses/görüntü — LuminaOS'in kendi sunucusundan ASLA geçmez, yalnızca zaten-entegre bir sağlayıcıya AÇIK onayla), Kademe 1 (ham kişisel-tanımlayıcı metin — zaten-entegre sağlayıcıya ek onay GEREKMEZ, YENİ sağlayıcıya Kademe 0 ile AYNI açık-onay şartı), Kademe 2 (türetilmiş/özetlenmiş metin — workspace-politikası yeterli), Kademe 3 (metadata — kısıtlama YOK).
5. **ADR-0045 Karar (i)** (`docs/adr/ADR-0045-sapma-aciklama-karti.md`, tam okundu): ADR-0029'a resmi bir ek getiriyor — ham sayısal iş-agregat değerleri (`sum`/`avg`/`count`/`min`/`max` gibi bir `QuerySpec` indirgemesi) + o sorgunun alan ANAHTARLARI, Kademe 3'ün (metadata) ruhuna Kademe 1/2'den daha yakın sınıflandırılır, Kademe 3'ün ÜZERİNE ÇIKMAZ. Bu ADR bu emsali DEĞİŞTİRMEZ, `classify()`'ın (Karar b) dört kademeyi AYNEN, yorumsuz kabul eden kapalı bir enum olarak tasarlanmasına doğrudan girdi sağlar — ADR-0045'in kendi somut örneği, "bir sayısal agregatın hangi kademede olduğu" sorusunun HER ZAMAN çağrı-yerinde (bu görev, F1-T15/F3-T11 gibi orkestratörlerin İÇİNDE) insan/mühendis tarafından KARARLAŞTIRILDIĞI, otomatik İÇERİK-analiziyle ÇIKARSANMADIĞI bir emsal oluşturuyor.
6. **Mevcut herhangi bir hibrit-AI (yerel/bulut) yönlendirme mantığı YOK** (`explorer` doğruladı) — ne `ai-gateway` içinde ne başka bir yerde. `select-ai-model.ts` (`apps/server/src/ai/select-ai-model.ts`) bir emsal TEŞKİL EDİYOR ama FARKLI bir eksende: HANGİ MODELİ (Haiku/Sonnet) seçtiğine karar veriyor, HANGİ SAĞLAYICIYI (yerel/bulut) DEĞİL — bu görevin `AIRoutingPolicy`'si `select-ai-model.ts`'in "kapalı input → deterministik string çıktı" BİÇİMSEL desenini ödünç alır ama kendi, ayrı bir ekseni (sağlayıcı seçimi) çözer.
7. **`apps/desktop` bugün `packages/ai-gateway`'e HİÇ bağımlı DEĞİL** (`apps/desktop/package.json`, doğrulandı) — yalnızca `@luminaos/ui`, `@tauri-apps/api`, `react`/`react-dom`. `apps/desktop/src/` bugün kimlik doğrulama (`auth/`), sinyal toplama (`signals/active-window*`, `signals/calendar-status-poller`), rıza ayarları (`consent/ConsentSettings.tsx`) ve ince bir `api/http-client.ts` (sunucuya HTTP çağrıları) içeriyor — hiçbir AI-çağrısı orkestrasyonu YOK. Bu görev `apps/desktop`'a `packages/ai-gateway`'i YENİ bir bağımlılık olarak EKLEMEYİ gerektiriyor (bkz. Karar a) — bu, `ai-gateway`'in bugüne kadar YALNIZCA `apps/server`'dan tüketildiği gerçeğini kıran, açıkça kayda geçirilmesi gereken bir genişleme.
8. **`packages/ai-gateway`'in framework-bağımsızlığı** (`packages/ai-gateway/package.json`, doğrulandı) — `dependencies`: yalnızca `@anthropic-ai/sdk` + `@luminaos/shared`; hiçbir React/Nest importu YOK, `provider.ts`/`mock-provider.ts` saf TypeScript. CLAUDE.md'nin "Domain paketleri (`core-objects`, `context-fabric`, `memory`, `automation`) framework import edemez" maddesi `ai-gateway`'i AÇIKÇA saymıyor, ama `ai-gateway`'in KENDİSİ zaten fiilen bu disiplini uyguluyor — hem Nest'ten (`apps/server`) hem React'ten (bu görevle `apps/desktop`) framework-agnostik biçimde tüketilebilir olması bu görevin (a) tercihini destekleyen bağımsız bir kanıt.

## Karar

### (a) Yerleşim: `packages/ai-gateway` içinde — `apps/desktop` içinde DEĞİL

Yeni kod `packages/ai-gateway/src/sensitivity-tier.ts` (saf tip+guard), `packages/ai-gateway/src/routing-policy.ts` (`AIRoutingPolicy`/`route()`), `packages/ai-gateway/src/local-provider.ts` (`LocalProvider implements AIProvider`, stub) olarak eklenir; `index.ts` bunları AYNI `AnthropicProvider`/`MockProvider` deseniyle re-export eder. `apps/desktop` bu üçünü YALNIZCA TÜKETİR, kendi paralel bir kopyasını YAZMAZ.

**Gerekçe — bu oturumun kendi emsali (ADR-0041→0045, "en ucuz, zaten-kurulmuş seçeneği genişlet"):**

- `AIProvider`, `AnthropicProvider`, `MockProvider` ZATEN `packages/ai-gateway`'de yaşıyor — `LocalProvider` bunların ÜÇÜNCÜ kardeşi, "sağlayıcı SDK'sı/uygulaması tek pakete hapsedilir" ilkesinin (CLAUDE.md, "AI çağrıları yalnızca `packages/ai-gateway` üzerinden") DOĞRUDAN devamı. `LocalProvider`'ı `apps/desktop` içine yazmak bu ilkeyi ihlal ederdi — "sağlayıcı" kelimesinin kendisi `ai-gateway`'in sahip olduğu bir kavram, hangi ÇAĞIRANIN (server/desktop) onu kullandığından BAĞIMSIZ.
- `classify()`/`AIRoutingPolicy` da AYNI mantıkla `ai-gateway`'e ait: "hangi `AIProvider`'ı kullanmalıyım" sorusu, TANIM GEREĞİ `ai-gateway`'in kendi sorumluluk alanı — `select-ai-model.ts`'in (hangi MODEL) `apps/server/src/ai/`'da değil `ai-gateway`'in DIŞINDA yaşamasının nedeni farklı: o, `AIUsageService`/kota gibi Nest-özel collaborator'larla iç içe geçmiş bir orkestrasyon kararı (madde 6). Bu görevin `route()`'u ise SAF, sıfır-I/O, sıfır-framework bir karar fonksiyonu — `ai-gateway`'in KENDİSİNİN zaten barındırdığı `retry.ts` (saf yardımcı fonksiyon) ile AYNI kategoride.
- `apps/desktop` bugün `ai-gateway`'e bağımlı DEĞİL (madde 7) — bu YENİ bir bağımlılık YÖNÜ, ama maliyeti düşük: `ai-gateway` zaten framework-agnostik (madde 8), Tauri/React'e hiçbir uyumsuzluk getirmiyor; kazanç ise gelecekte `apps/mobile` (varsa) veya `apps/web` de aynı sınıflandırma/yönlendirme mantığına ihtiyaç duyarsa (ör. web'de de bir gün WebGPU-tabanlı yerel çıkarım denenirse) kodun TEK bir yerde, TEK bir sözleşimle yaşaması.
- **Reddedilen alternatif (b): tamamen `apps/desktop` içinde.** Bunun tek avantajı "yalnızca bir tüketicisi var, neden paylaşılan bir pakete koyayım" minimalizmi olurdu — ama bu, `ai-gateway`'in KENDİ var oluş nedenini (sağlayıcı-agnostik AI çağrı sözleşmesinin TEK kaynağı olmak) ihlal eder ve CLAUDE.md'nin "AI çağrıları yalnızca `packages/ai-gateway` üzerinden" maddesini LAFZEN değil ama RUHEN çiğner — `apps/desktop` kendi paralel bir `AIProvider`-benzeri sözleşim İCAT ETMİŞ olurdu, `ai-gateway`'in KENDİSİNİ kullanmak yerine.

### (b) `classify()`/`AIRoutingPolicy` sözleşmesi — statik, çağrı-yerinde-beyan edilen kademe, İÇERİK-analizi YOK

```ts
// packages/ai-gateway/src/sensitivity-tier.ts (YENİ, saf tip+guard)

/**
 * ADR-0029'un dört-kademeli hassas-veri sınıflandırmasının (Kademe 0-3) kod
 * karşılığı. İngilizce tanımlayıcılar kullanılır -- kod tabanının mevcut
 * konvansiyonuyla (aggregateFn/targetFieldKey/outputType gibi, ADR-0045)
 * tutarlı; "Kademe" yalnızca dokümantasyon/prosa düzeyinde Türkçe kalır.
 *
 * ÖNEMLİ: bu tip bir İÇERİK-sınıflandırıcısı DEĞİLDİR -- hiçbir fonksiyon bu
 * dosyada ham metni/veriyi PARSE EDEREK bir tier ÇIKARSAMAZ. Tier her zaman
 * ÇAĞRI YERİNDE bir insan/mühendis tarafından BEYAN EDİLİR (ADR-0045 Karar
 * (i)'nin "bir sayısal agregatın kademesi çağrı yerinde insan tarafından
 * kararlaştırılır" emsalinin genellemesi) -- tıpkı `explainDeviation`'ın
 * kendi girdisini otomatik sınıflandırmak yerine ADR-0045'in ZATEN
 * kararlaştırdığı "Kademe 3" muamelesini doğrudan kod olarak yansıtması gibi.
 */
export type SensitivityTier = 'tier0' | 'tier1' | 'tier2' | 'tier3';

export const SENSITIVITY_TIERS: readonly SensitivityTier[] = ['tier0', 'tier1', 'tier2', 'tier3'];

export function isSensitivityTier(value: unknown): value is SensitivityTier {
  return typeof value === 'string' && (SENSITIVITY_TIERS as readonly string[]).includes(value);
}
```

```ts
// packages/ai-gateway/src/routing-policy.ts (YENİ)
import type { AICompletionRequest } from './provider.js';
import { isSensitivityTier, type SensitivityTier } from './sensitivity-tier.js';

export type AIRoutingDestination = 'local' | 'cloud';

export interface ClassifiedAIRequest {
  /** Çağıranın AÇIKÇA beyan ettiği kademe -- asla içerikten çıkarsanmaz. */
  tier: SensitivityTier;
  request: AICompletionRequest;
}

export interface AIRoutingPolicy {
  route(input: ClassifiedAIRequest): AIRoutingDestination;
}

/**
 * v0 sabit politika (ADR-0046 Karar c): Kademe 0/1/2 -> 'local' (yerel
 * modelin ilkesel olarak elverişli olduğu, ADR-0029 Karar (b)'nin bulut
 * kısıtlarının EN katı olduğu kademeler), Kademe 3 -> 'cloud' (kısıtlama
 * yok, mevcut sunucu-taraflı bulut yolu zaten yeterli/ucuz). Gelecekte
 * yerel modelin GERÇEKTEN çalışıp çalışmadığına göre bu sabit eşleme
 * yerine bir "yerel elveriş" kontrolü eklenmesi ayrı bir Açık Soru (spec'e
 * bkz.) -- v0 bu kontrolü YAPMAZ, LocalProvider bir stub olduğu için her
 * zaman "yerel mevcut" varsayılır.
 */
export class StaticTierRoutingPolicy implements AIRoutingPolicy {
  route(input: ClassifiedAIRequest): AIRoutingDestination {
    if (!isSensitivityTier(input.tier)) {
      throw new ValidationError(`Unknown sensitivity tier: ${String(input.tier)}`);
    }
    return input.tier === 'tier3' ? 'cloud' : 'local';
  }
}
```

**Neden İÇERİK-analizi değil, çağrı-yerinde-beyan:** İnsan kararı 3 (bağlayıcı, bu oturumda alındı) bunu AÇIKÇA istiyor — ADR-0045 Karar (i)'nin KENDİ emsali de bunu doğruluyor: `explainDeviation`'ın orkestratörü hiçbir noktada "bu prompt'un içeriği nedir, kaç kişi-tanımlayıcı kelime içeriyor" gibi bir analiz YAPMIYOR, kademe orkestratörün KENDİ kod-yazarının (mimarın/implementer'ın) ADR-0045'te ÖNCEDEN kararlaştırdığı, sabit "Kademe 3" ETİKETİNİ doğrudan taşıyor. Otomatik içerik-sınıflandırması (ör. bir regex/heuristik/ikinci bir AI çağrısıyla "bu metin kişisel mi" tespiti) YANLIŞLIKLA Kademe 1 verisini Kademe 3 sayıp bulut'a sızdırma riski taşırdı — CLAUDE.md'nin "Hassas veri sınıfları buluta ham gönderilmez" değişmezine karşı YANLIŞ-NEGATİF (false negative) riski çok yüksek bir tasarım; statik beyan modeli bu riski TAMAMEN çağrı-yerinin (kod incelemesiyle denetlenebilir, `explainDeviation`/`answerQuestion` gibi HER orkestratörün kendi ADR'sinde zaten yapması gerektiği gibi) sorumluluğuna taşır.

### (c) `LocalProvider` — sabit/mock yanıtlı stub, GERÇEK çıkarım YOK

```ts
// packages/ai-gateway/src/local-provider.ts (YENİ)
import type { AICompletionRequest, AICompletionResult, AIProvider } from './provider.js';

/**
 * v0 STUB -- gerçek bir cihaz-üstü çıkarım motoru (ONNX/WebGPU/llama.cpp/
 * Ollama vb.) İÇERMEZ, hiçbir model ağırlığı yüklemez. Amaç YALNIZCA
 * `AIRoutingPolicy`'nin `AIProvider`-şekilli bir "yerel" hedefe gerçekten
 * dispatch edebildiğini yapısal olarak kanıtlamak -- `MockProvider`'ın
 * (test-double) AKSİNE, `LocalProvider` PRODUCTION kod yolunun bir PARÇASI
 * olarak tasarlanmıştır (gelecekte gerçek bir motorla İÇİ DOLDURULACAK,
 * DEĞİŞTİRİLMEYECEK bir sınıf) -- bu ayrım `AI_PROVIDER`/`MockProvider`
 * karışıklığını önlemek için önemlidir.
 *
 * Token kullanımı sıfırlanmış döner (`inputTokens: 0, outputTokens: 0`) --
 * gerçek bir yerel model için "token" kavramının bulut-maliyeti karşılığı
 * olmayabileceği AÇIK bir modelleme sorusu (spec'in Açık Soruları'na bkz.),
 * bu stub'da BİLEREK çözülmüyor.
 */
export class LocalProvider implements AIProvider {
  constructor(private readonly fixedResponseText = '[local-provider-stub] not yet implemented') {}

  async complete(_request: AICompletionRequest): Promise<AICompletionResult> {
    return {
      text: this.fixedResponseText,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'local-stub-v0',
    };
  }
}
```

**Neden `MockProvider`'ı yeniden kullanmak yerine yeni bir sınıf:** `MockProvider` semantik olarak "test double" — adı ve `static fixed()` yardımcı metodu bunu açıkça işaret ediyor; `LocalProvider`'ı `MockProvider.fixed(...)`'in bir çağrısı olarak modellemek, gelecekte gerçek bir yerel motor `LocalProvider`'ın İÇİNİ doldurduğunda (implementasyon değişecek, isim/tip KALACAK) `MockProvider`'ın test-double kimliğini kalıcı olarak bulandırırdı. Ayrı, adı kendi amacını taşıyan bir sınıf, `AnthropicProvider`'ın (gerçek, üretim) `MockProvider`'dan (test-double) AYRI durduğu ile AYNI netliği korur.

### (d) Dispatch/kullanım deseni — çağıran taraf (`apps/desktop`) `route()`'u okuyup KENDİSİ provider seçer

Bu görev bir "hepsi-bir-arada dispatcher sınıfı" (ör. `HybridAIClient.complete(classifiedRequest)`) İCAT ETMİYOR — `AIRoutingPolicy.route()` yalnızca BİR KARAR (`'local'|'cloud'`) döner, hangi somut `AIProvider`'ın (yerel `LocalProvider` örneği veya var olan sunucu-taraflı bulut yolu) çağrılacağına ÇAĞIRAN karar verir:

```ts
// apps/desktop içinde gelecekteki bir tüketicinin taslak kullanım şekli
// (bu görevde HİÇBİR gerçek UI/çağrı-yeri KABLOLANMAZ -- yalnızca sözleşim
// birim testleriyle izole doğrulanır, spec Kapsam Dışı'na bkz.)
const destination = routingPolicy.route({ tier: 'tier1', request });
const result =
  destination === 'local'
    ? await localProvider.complete(request)
    : await existingServerAiClient(request); // apps/server'ın MEVCUT HTTP yüzeyi, DEĞİŞMEDİ
```

**Neden tek bir "dispatcher" sınıfı değil:** `existingServerAiClient` (bulut yolu) bugün BİLE `apps/desktop`'ın kendi `api/http-client.ts`'i üzerinden zaten var olan bir HTTP-çağrısı biçiminde MODELLENEBİLİR (bu görev bunu somutlaştırmıyor, insan kararı 2'nin "yalnızca stub" kapsamı gereği) — `AIProvider` arayüzüyle `complete()` şeklinde SARMAK bugün ZORUNLU değil, gelecekteki bir görev bunu netleştirebilir. Bu görev bilinçli olarak SADECE karar fonksiyonunu (`route()`) + yerel tarafın stub'ını (`LocalProvider`) teslim ediyor, ikisini KABLOLAYAN somut bir `apps/desktop` bileşeni YAZMIYOR (bkz. spec Kapsam Dışı) — erken bir dispatcher soyutlaması, henüz var olmayan bir bulut-tarafı-`AIProvider`-sarmalayıcısını İCAT ETMeyi gerektirirdi, bu da kapsamın ötesine geçerdi.

## Kapsam Dışı

- **Gerçek bir cihaz-üstü çıkarım motorunun (ONNX Runtime/WebGPU/llama.cpp/Ollama vb.) seçilmesi veya entegrasyonu** — spec'in Açık Soru (a)'sı, AYRI bir gelecekteki görev.
- **Gerçek model ağırlıkları veya gerçek çıkarım** — `LocalProvider` sabit/mock bir metin döner, HİÇBİR yerel süreç/binary çağırmaz.
- **`apps/server/src/ai/*` veya mevcut herhangi bir orkestratörde (`parseCommand`/`answerQuestion`/`compileWidgetQuery`/`generateArtifact`/`explainDeviation`) DEĞİŞİKLİK** — insan kararı 1'in bağlayıcı sınırı, sıfır değişiklik.
- **Bu yeni yeteneğin herhangi bir `apps/desktop` UI akışına (`ConsentSettings.tsx`, komut paleti benzeri bir yüzey vb.) KABLOLANMASI** — takip görevi; bu görev yalnızca sınıflandırıcı+yönlendirici+stub sözleşimini, izole test edilebilir biçimde kurar.
- **Kademe→yönlendirme eşlemesinin workspace-bazlı yapılandırılabilir hale getirilmesi** — v0 `StaticTierRoutingPolicy` SABİT bir eşleme; spec'in Açık Soru (b)'si.
- **Yerel sağlayıcının GERÇEK token/maliyet raporlaması** — spec'in Açık Soru (c)'si, bu stub'da sıfırlanmış `AITokenUsage` yeterli.
- **İçerik-analizi tabanlı otomatik hassasiyet tespiti** — Karar (b)'nin kesin biçimde reddettiği alternatif, İnsan kararı 3'ün bağlayıcı sınırı.

## Alternatifler ve Reddedilme Gerekçeleri

- **Yerleşim: `apps/desktop` içinde, `ai-gateway`'e dokunmadan.** Reddedildi (Karar a) — `ai-gateway`'in "tek sağlayıcı sözleşimi kaynağı" ilkesini RUHEN ihlal ederdi, `apps/desktop`'ın kendi paralel bir `AIProvider`-benzeri arayüz icat etmesine yol açardı.
- **`classify()`'ı ham girdiyi (metin/nesne) alıp OTOMATİK bir kademe ÇIKARSAYAN bir fonksiyon olarak tasarlamak.** Reddedildi (İnsan kararı 3, bağlayıcı) — yanlış-negatif riski (Kademe 1 verisinin yanlışlıkla Kademe 3 sayılıp bulut'a sızması) kabul edilemez; ADR-0045 Karar (i)'nin kendi emsali (kademe her zaman ÇAĞRI YERİNDE insan tarafından kararlaştırılır) zaten bu modelin doğru olduğunu gösteriyor.
- **`LocalProvider`'ı `MockProvider.fixed(...)`'in bir kullanımı olarak modellemek, ayrı sınıf açmadan.** Reddedildi (Karar c) — `MockProvider`'ın test-double kimliğini bulandırır; `LocalProvider` production kod yolunun kalıcı bir parçası, `MockProvider` yalnızca testler için.
- **Kademe→hedef eşlemesini ŞİMDİDEN workspace-yapılandırılabilir yapmak (ör. bir `RoutingPolicyConfig` DB tablosu).** Reddedildi — henüz gerçek bir yerel motor/gerçek kullanıcı geri bildirimi yokken bu erken optimizasyon olurdu; spec'in Açık Soru (b)'sine ertelendi.
- **Tek, hepsi-bir-arada bir `HybridAIClient.complete()` dispatcher'ı yazmak (bulut tarafını da `AIProvider` olarak sarmalayarak).** Reddedildi (Karar d) — bulut tarafının bugünkü somut şekli (`apps/desktop`'ın HTTP-çağrısı) `AIProvider`'a NASIL sarılacağı henüz netleşmemiş bir ayrı tasarım kararı; bu görev kapsamını yalnızca sözleşim+stub'a daraltıyor.

## Mimari Değişmezlerle İlişki

- **"Hassas veri sınıfları buluta ham gönderilmez (ADR-0029)."** Bu ADR bu değişmezin İLK somut kod-sözleşmesini (`SensitivityTier`/`AIRoutingPolicy`) kuruyor — ADR-0029'un Bilinen Sınırlamalar (a)'sının işaret ettiği "otomatik etiketleme mekanizması" HÂLÂ yok (bu ADR bunu ÇÖZMÜYOR, bkz. "Bilinen Sınırlamalar" altında), ama artık en azından KARARIN kodda TEMSİL EDİLEBİLECEĞİ bir tip/arayüz var.
- **"AI çağrıları yalnızca `packages/ai-gateway` üzerinden."** `LocalProvider` de `AnthropicProvider`/`MockProvider` gibi bu tek kapıdan geçiyor — `apps/desktop`'ın bu görevle `ai-gateway`'e YENİ bağımlı olması bu değişmezi GENİŞLETİYOR (artık server DIŞINDA bir tüketici de var), İHLAL ETMİYOR.
- **Domain paketleri framework import edemez.** `ai-gateway` CLAUDE.md'nin bu listesinde AÇIKÇA sayılmıyor ama zaten fiilen aynı disiplini uyguluyor (madde 8) — bu ADR'nin eklediği 3 yeni dosya da (saf TS, sıfır React/Nest import) bu disiplini KORUYOR.
- **Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar.** Bu görev bir AJAN-AKSİYONU değil, bir ALTYAPI/SDK sözleşimi kuruyor — `route()`'un kendisi hiçbir kullanıcı verisi üzerinde aksiyon ALMAZ, yalnızca hangi sağlayıcının çağrılacağına karar verir; bu değişmez bu görevde tetiklenmiyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** ADR-0029'un dört-kademeli politikasının kod-dünyasında somut, test edilebilir bir karşılığı (`SensitivityTier`/`AIRoutingPolicy`/`StaticTierRoutingPolicy`) var artık; `packages/ai-gateway` gelecekteki GERÇEK bir yerel-çıkarım motorunun ekleneceği YERİ (üçüncü `AIProvider` uygulaması olarak `LocalProvider`'ın İÇİNİN doldurulması) önceden belirlemiş oluyor; `apps/desktop` ilk kez `ai-gateway`'e bağımlı hale gelerek gelecekteki hibrit-AI özelliklerinin (Kapsam O'nun geri kalanı) üzerine inşa edeceği bir temel kazanıyor.

**Neyi erteliyoruz/kabul ediyoruz (Bilinen Sınırlamalar):**

- **(a) Bu ADR bir ENFORCEMENT mekanizması KURMUYOR, bir SÖZLEŞİM kuruyor** — `StaticTierRoutingPolicy.route()`'u YANLIŞ bir `tier` ile çağırmak (ör. gerçekte Kademe 1 olan bir veriyi `tier3` diye beyan etmek) hâlâ mümkün, kod bunu ENGELLEMEZ; ADR-0029'un Bilinen Sınırlamalar (a)'sının "her entegrasyon kendi mimarisinde bu politikaya uyması ayrı bir mühendislik/inceleme sorumluluğu" tespiti AYNEN geçerli kalıyor.
- **(b) Gerçek yerel çıkarım motoru seçimi tamamen ERTELENDİ** — `LocalProvider` HİÇBİR gerçek model çalıştırmıyor; spec'in Açık Soru (a)'sı.
- **(c) Kademe→hedef eşlemesi SABİT/hardcoded** — workspace-bazlı yapılandırma spec'in Açık Soru (b)'si.
- **(d) Yerel sağlayıcının gerçek maliyet/token-modeli çözülmedi** — spec'in Açık Soru (c)'si, gerçek bir yerel motorun "token başına bulut maliyeti yok" gerçeğinin `AITokenUsage`/`calculateCostUsd` (ai-gateway'in `model-pricing.ts`'i) ile nasıl uzlaşacağı AÇIK bir modelleme sorusu.
- **(e) Bu görev hiçbir UI/kullanıcı-görünür akışa bağlanmıyor** — `LocalProvider`/`AIRoutingPolicy` bugün hiçbir gerçek çağrı yolunda ÇALIŞTIRILMIYOR, yalnızca izole birim testleriyle doğrulanıyor.

## İnsan Kararları

Bu görevin en-yük-taşıyan üç kararı Plan Mode oturumunda İNSANA soruldu ve İNSAN TARAFINDAN karara bağlandı — mimarın çıkarımı DEĞİLDİR, aşağıda AYNEN kayıtlıdır:

1. **Yer: yönlendirme `apps/desktop` (Tauri) tarafında, İSTEMCİ tarafında olur.** Düşük-kademeli veri için (yerelde çıkarsanabildiği ölçüde) cihaz-üstü modele yönlendirilir; Kademe 3 için veya yerel model mevcut olmadığında MEVCUT sunucu-taraflı ai-gateway/bulut yoluna DEĞİŞMEDEN düşer. `apps/server/src/ai/*` ve tüm mevcut orkestratörler SIFIR değişiklik görür.
2. **Kapsam: arayüz-öncelikli, yerel sağlayıcı bir STUB.** Bu görev (a) ADR-0029'un dört kademesini + ADR-0045 emsalini kodlayan saf `classify`/tip; (b) `AIProvider`-şekilli, GERÇEK model ağırlığı/çıkarım OLMAYAN bir `LocalProvider` stub'ı; (c) beyan edilen kademeye göre `LocalProvider` stub'ı ile bulut yolu arasında seçim yapan bir yönlendirme sözleşimi (`AIRoutingPolicy`) inşa eder. Gerçek bir çıkarım motorunun seçimi/entegrasyonu KAPSAM DIŞI — spec'te bir "Açık Soru"/gelecekteki görev olarak not düşülür, ŞİMDİ çözülmez.
3. **Sınıflandırma girdi modeli: statik, çağrı-yerinde-beyan edilen kademe — asla otomatik içerik incelemesi değil.** `classify()`/`route()` çağırandan AÇIKÇA BEYAN EDİLMİŞ bir kademe alır (ADR-0045 Karar (i)'nin kendi emsalini yansıtarak — bir insan/mühendis çağrı yerinde kademeyi beyan eder) — ham metin/içeriği PARSE EDEREK hassasiyeti algoritmik olarak ÇIKARSAMAZ. Görevi, beyan edilen kademenin GERÇEK bir enum değeri olduğunu doğrulamak ve o kademeye göre bir yönlendirme KARARI (hangi sağlayıcı kullanılacak) vermektir, içerik analizi YAPMAK değildir.

---

**Sıradaki adım:** Bu ADR insan onayına sunulur. Onaylanırsa spec dosyası (`docs/specs/F3-E5/F3-T12-cihaz-ustu-model-koprusu.md`) zaten bu ADR ile birlikte taslak halinde hazırlanmıştır; onay sonrası `test-writer` ile PR1'e başlanır.
