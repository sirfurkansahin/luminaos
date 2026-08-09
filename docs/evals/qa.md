# QA / RAG Eval Golden-Set (F1-T17 PR1)

Bu dosya, `answerQuestion` fonksiyonunun (F1-T15, ADR-0014) davranışını
sabitleyen 40 golden senaryoyu insan-okunur biçimde açıklar. `AI Fields`
eval'inin (`docs/evals/ai-fields.md`, F1-T5, 10 senaryo) doğrudan devamıdır —
aynı desen: gerçek bir Anthropic çağrısı gerektirmeden, `MockProvider` ile
deterministik olarak CI'da (`pnpm test`) koşar.

## Nerede yaşıyor

- **Senaryolar (bu dosya):** insan-okunur açıklama, aşağıda.
- **Uygulama:** `apps/server/src/ai/qa.eval.test.ts` — aynı 40 senaryoyu
  `answerQuestion` (`apps/server/src/ai/answer-question.ts`) ve
  `@luminaos/ai-gateway`'in `MockProvider` / `MockProvider.fixed`'i üzerinden
  test eder. NestJS DI yok, Testcontainers yok, düz `vitest` ile koşar.
- **Karakterizasyon (F1-T15 orijinali):** `apps/server/src/ai/answer-question.test.ts`
  — bu golden-set'in ÖNCESİNDE yazılmış temel davranış testleri; bu dosya
  onları TEKRARLAMAZ, tamamlar.
- **Uçtan uca kanıt:** `apps/server/src/qa/qa.integration.test.ts` aynı
  davranışı gerçek Postgres + Redis üzerinden (RBAC filtreleme, kota, HTTP
  katmanı dahil) doğrular — bu dosyanın kapsamı dışında.

`answerQuestion`, `QAService.answer`'ın (F1-T15) kullandığı saf, DB'siz RAG
orkestratörüdür: `resolveAIFieldValue`'nun kardeşi, aynı biçim — provider/
model/`recordUsage` dışarıdan enjekte edilir. `passages` boşsa provider HİÇ
çağrılmaz, sabit "no relevant content" cevabı döner (maliyetsiz, halüsinasyon
riski sıfır). Aksi halde yalnızca verilen pasajlardan cevap vermesini emreden
bir prompt render eder, `provider.complete`'i TAM BİR KEZ çağırır, kullanımı
kaydeder ve `{ answer: result.text, sources: input.passages }` döner —
`sources` HER ZAMAN girdi pasajlarının aynısıdır, modelin metninden asla
yeniden türetilmez (atıfta halüsinasyon karşıtı tasarım).

## Senaryolar

### Grup A — Temel pasaj işleme ve prompt oluşturma (1-6)

| #   | Senaryo                                    | Girdi                                           | Beklenen Sonuç                                                                                                                    |
| --- | ------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tek pasaj, doğrudan soru                   | P_REMOTE tek pasaj, uzaktan çalışma günü sorusu | Prompt soru + başlık + snippet içerir; `provider.complete` tam bir kez çağrılır; `sources = [P_REMOTE]`; `answer` provider metni. |
| 2   | İki pasaj sentezi                          | P_ROLLBACK + P_DEPLOY                           | Prompt her iki pasajı da içerir; `sources.length === 2`, girdi sırasıyla aynı.                                                    |
| 3   | Üç pasaj numaralandırma                    | P_ROLLBACK, P_DEPLOY, P_SECURITY                | Prompt'ta `[1]`,`[2]`,`[3]` numaralandırması girdi sırasıyla görünür.                                                             |
| 4   | Beş pasaj (SearchService TOP_K üst sınırı) | 5 pasaj                                         | Yine tam bir kez çağrı; `sources.length === 5`.                                                                                   |
| 5   | Sekiz pasaj (TOP_K'nin ötesinde)           | 8 pasaj                                         | Saf fonksiyon üst sınır dayatmaz (bu QAService'in sorumluluğu); yine tek çağrı, `sources.length === 8`.                           |
| 6   | Alakasız provider yanıtı                   | Provider `"I'm not sure."` döner                | `answer` AYNEN o metindir; tekrar denenmez, tek çağrı kalır (`resolveAIFieldValue`'nun select-retry'sinden kasıtlı fark).         |

### Grup B — Sıfır-pasaj kısa devresi (7-9)

| #   | Senaryo                                | Girdi                       | Beklenen Sonuç                                                                                              |
| --- | -------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 7   | Boş pasaj listesi + kısa soru          | `passages: []`, kısa soru   | Sabit "No relevant content..." cevabı; `sources = []`; provider HİÇ çağrılmaz; `recordUsage` HİÇ çağrılmaz. |
| 8   | Boş pasaj listesi + uzun/karmaşık soru | `passages: []`, uzun soru   | AYNI sabit cevap (davranış soru içeriğinden bağımsız).                                                      |
| 9   | Boş pasaj listesi + Türkçe soru        | `passages: []`, Türkçe soru | Yine AYNI sabit İngilizce cevap (yerelleştirme dalı yok).                                                   |

### Grup C — Kaynak (source) sadakati (10-15)

| #   | Senaryo                               | Girdi                                                           | Beklenen Sonuç                                                                                                            |
| --- | ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 10  | Tek pasaj deep-equal                  | Tek pasaj                                                       | `sources` girdi pasajıyla deep-equal, aynı sırada.                                                                        |
| 11  | Çoklu pasaj sırası korunur            | Çoklu pasaj                                                     | `sources` sırası girdi sırasıyla birebir aynı (relevans sırası korunur, yeniden sıralanmaz).                              |
| 12  | Aynı başlık, farklı objectId          | İki `'Meeting Notes'` pasajı, `obj-meeting-a` / `obj-meeting-b` | `sources` ayrı objectId'leri korur, birleştirilmez.                                                                       |
| 13  | Sonuç şekli tam                       | Herhangi bir geçerli girdi                                      | `result` nesnesi TAM OLARAK `{answer, sources}` alanlarını içerir, fazladan alan sızmaz.                                  |
| 14  | Sources provider metninden türetilmez | Provider metninde bahsedilmeyen bir pasaj                       | `sources` girdi referanslarıyla değer-eşit ama sağlayıcı yanıtından yeniden türetilmez; pasaj yine de `sources`'ta kalır. |
| 15  | Hiçbir başlıktan bahsedilmese bile    | Provider metni hiçbir pasaj başlığından bahsetmez               | `sources` değişmez.                                                                                                       |

### Grup D — İçerik çeşitliliği ve özel karakterler (16-24)

| #   | Senaryo                              | Girdi                                          | Beklenen Sonuç                                                     |
| --- | ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| 16  | Boş string snippet                   | P_EMPTY_SNIPPET (`snippet: ''`)                | Prompt'a dahil edilir, hata fırlatmaz, pasaj `sources`'tan düşmez. |
| 17  | Uzun snippet                         | P_LONG (~300+ karakter)                        | Prompt'a kısaltılmadan tam dahil edilir.                           |
| 18  | Soruda özel karakterler              | Tırnak, süslü parantez, satır sonu içeren soru | Prompt'un `Question:` satırında AYNEN yer alır.                    |
| 19  | Pasajda markdown-benzeri karakterler | `*`,`[`,`]`,`#` içeren snippet                 | AYNEN (kaçışsız) dahil edilir.                                     |
| 20  | Türkçe karakterler                   | P_TURKISH                                      | UTF-8 sadakatiyle AYNEN dahil edilir.                              |
| 21  | Sayısal/para birimi içeriği          | P_BUDGET (`"$42,000"` içeren snippet)          | String olarak AYNEN korunur.                                       |
| 22  | Gömülü alıntı                        | P_QUOTE (tırnak içinde alıntı cümle)           | Prompt yapısını bozmadan AYNEN dahil edilir.                       |
| 23  | Baştaki/sondaki boşluklar            | P_WHITESPACE (literal leading/trailing boşluk) | TRIM edilmeden AYNEN dahil edilir.                                 |
| 24  | Başlık = soru metni                  | Pasaj başlığı soru metniyle aynı string        | `Question:` satırı ile pasaj başlığı karışmaz.                     |

### Grup E — Halüsinasyon karşıtı talimat kalıcılığı (25-27)

| #   | Senaryo                       | Girdi              | Beklenen Sonuç                                                                     |
| --- | ----------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| 25  | Tek pasajla talimat varlığı   | Tek pasaj          | Prompt "yalnızca pasajlardaki bilgiyi kullan / uydurma" talimatını içerir.         |
| 26  | Beş pasajla talimat seyrelmez | Beş pasaj          | AYNI talimat seyrelmeden mevcuttur.                                                |
| 27  | Talimat sırası                | Herhangi bir girdi | Talimat HER ZAMAN pasaj içeriğinden ÖNCE render edilir (prompt'taki index sırası). |

### Grup F — Model yönlendirme ve kullanım (usage) kaydı (28-33)

| #   | Senaryo                        | Girdi                                      | Beklenen Sonuç                                                                                    |
| --- | ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 28  | `model` belirtildiğinde iletim | `model: 'claude-x'` gibi bir değer         | `provider.complete` isteğine AYNEN iletilir.                                                      |
| 29  | `model` belirtilmediğinde      | `model` alanı verilmez                     | İstekte model anahtarı yoktur / `undefined`'dır.                                                  |
| 30  | Tek pasajlı usage kaydı        | Provider tam token sayıları döner          | `recordUsage` provider'ın döndürdüğü TAM token sayılarıyla bir kez çağrılır.                      |
| 31  | Beş pasajlı usage kaydı        | 5 pasaj, provider tam token sayıları döner | `recordUsage` yine provider'ın rakamlarıyla bir kez çağrılır (fonksiyon kendi tahminini üretmez). |
| 32  | Provider hatası                | `provider.complete` reddedilir/throw eder  | `answerQuestion` hatayı yutmadan dışarı fırlatır VE `recordUsage` hiç çağrılmaz.                  |
| 33  | `recordUsage` reddi            | `recordUsage` reddedilen bir promise döner | `answerQuestion`'ın döndürdüğü promise de reddedilir (sessizce yutulmaz).                         |

### Grup G — Loglama disiplini (34)

| #   | Senaryo                               | Girdi                                           | Beklenen Sonuç                                                           |
| --- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| 34  | Hassas görünümlü içerikte loglama yok | İşaretli (marker) hassas görünümlü snippet/soru | `console.log`/`error`/`warn` HİÇ çağrılmaz (ADR-0008 yapısal disiplini). |

### Grup H — Gerçekçi uçtan uca senaryolar (35-40)

| #   | Senaryo                      | Girdi                                                     | Beklenen Sonuç                                                                                                                                               |
| --- | ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 35  | İK senaryosu                 | P_REMOTE tek pasaj, uzaktan çalışma sorusu                | Standart tek-pasaj akışı, gerçekçi soru metniyle.                                                                                                            |
| 36  | Mühendislik senaryosu        | P_ROLLBACK + P_DEPLOY iki pasaj, rollback sorusu          | İki pasaj sentezi, gerçekçi soru metniyle.                                                                                                                   |
| 37  | Güvenlik senaryosu           | P_SECURITY tek pasaj, 2FA sorusu                          | Hassas görünen ama YALNIZCA pasajdan cevap; provider'a gönderilen prompt talimatla sınırlı.                                                                  |
| 38  | Müşteri destek senaryosu     | P_REFUND + P_SHIPPING iki pasaj                           | `sources` her ikisini içerir.                                                                                                                                |
| 39  | Proje yönetimi senaryosu     | P_SPRINT tek pasaj, sprint önceliği sorusu                | Standart tek-pasaj akışı.                                                                                                                                    |
| 40  | Kapsayıcı (capstone) senaryo | 5 pasaj (Türkçe + İngilizce karışık), `model` belirtilmiş | `recordUsage` doğru; `sources` girdiyle birebir; halüsinasyon-karşıtı talimat mevcut — AI Fields dosyasının 10. senaryosuna paralel "hepsi bir arada" kanıt. |

## Kapsam DIŞI (bu dosyada)

- Gerçek Anthropic API çağrıları (yok, yalnızca `MockProvider` /
  `MockProvider.fixed`).
- RBAC/kota/HTTP/DB katmanı — `apps/server/src/qa/qa.integration.test.ts`'te
  kanıtlı, bu saf eval senaryolarına dahil değil.
- Komut ayrıştırma (F1-T16) golden-set'i — ayrı dosya, F1-T17 PR2 kapsamı.
- İnsan-değerlendirmeli skorlama / model karşılaştırma — F1-T17'nin açık
  sorusu, v1 kapsamı dışı.
