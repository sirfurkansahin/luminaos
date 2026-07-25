# AI Fields — Eval Başlangıcı (F1-T5)

Bu dosya, `ai` alan tipinin (F1-T5) davranışını sabitleyen 10 golden senaryoyu
insan-okunur biçimde açıklar. Bu, F1-T17'de kurulacak tam eval altyapısının
tohumudur: gerçek bir Anthropic çağrısı gerektirmeden, `MockProvider` ile
deterministik olarak CI'da (`pnpm test`) koşar.

## Nerede yaşıyor

- **Senaryolar (bu dosya):** insan-okunur açıklama, aşağıda.
- **Uygulama:** `apps/server/src/ai/ai-fields.eval.test.ts` — aynı 10 senaryoyu
  `resolveAIFieldValue` (`apps/server/src/ai/resolve-ai-field-value.ts`) ve
  `@luminaos/ai-gateway`'in `MockProvider`'ı üzerinden test eder.
  `resolveAIFieldValue`, `ObjectsService.refreshAIField`'ın kullandığı AYNI
  karar mantığıdır (prompt doldurma → sağlayıcı çağrısı → `select` doğrulama →
  tekrar deneme → hata değeri) — Postgres/EventStore'dan bağımsız, saf bir
  fonksiyon olarak ayrıştırılmıştır ki bu senaryolar Testcontainers olmadan,
  düz `vitest` ile koşabilsin.
- **Uçtan uca kanıt:** `apps/server/src/objects/object-ai-refresh.integration.test.ts`
  aynı davranışı gerçek Postgres + HTTP üzerinden (kota, `onSourceChange`
  debounce, AI→AI kademelenmeme dahil) doğrular — bu dosyanın kapsamı dışında.

## Senaryolar

| #   | Senaryo                                                  | Girdi                                                                                            | Beklenen Sonuç                                                                                                                  |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tek kaynak alan ile şablon doldurma                      | `promptTemplate: "Summarize: {description}"`, `description: "The server caught fire overnight."` | Render edilen prompt `"Summarize: The server caught fire overnight."`; dönen değer sağlayıcının metni.                          |
| 2   | Birden fazla kaynak alan ile şablon doldurma             | `"Title: {title}\nDescription: {description}"`                                                   | Her iki yer tutucu da bağımsız olarak doldurulur.                                                                               |
| 3   | Sayısal alan değeri                                      | `price: 9999`                                                                                    | `{price}` → `"9999"` (düz string, JSON değil).                                                                                  |
| 4   | Tanımlı ama değeri olmayan (`undefined`) alan            | `notes: undefined`                                                                               | `{notes}` → boş string (`""`), `"undefined"` literal'i DEĞİL.                                                                   |
| 5   | `sourceFieldValues`'ta hiç bulunmayan yer tutucu         | `{neverDefined}`, eşleşen anahtar yok                                                            | Yer tutucu OLDUĞU GİBİ kalır (savunmacı geri dönüş — `assertAIFieldRules` zaten tanım zamanında bilinmeyen referansı reddeder). |
| 6   | `outputType: select`, ilk yanıt geçerli seçenek          | Sağlayıcı `"medium"` döner, `options: [low, medium, high]`                                       | Değer `"medium"`; sağlayıcı YALNIZCA BİR KEZ çağrılır (tekrar deneme yok).                                                      |
| 7   | `outputType: select`, ilk yanıt geçersiz → tekrar dener  | İlk çağrı `"not-an-option"`, ikinci çağrı `"high"` döner                                         | Değer `"high"`; her iki çağrı da AYNI render edilmiş promptu kullanır; sağlayıcı iki kez çağrılır.                              |
| 8   | `outputType: select`, her iki deneme de geçersiz         | Her iki çağrı da `"still-not-an-option"` döner                                                   | Değer `{ aiFieldError: true, message: string }` (`AIFieldErrorValue`) — ASLA throw etmez.                                       |
| 9   | Kullanım kaydı sırası ve doğruluğu                       | İlk çağrı `{100,20}` token, ikinci çağrı `{50,10}` token kullanır                                | `recordUsage` her gerçek sağlayıcı çağrısından SONRA, o çağrının tam token sayısıyla, doğru sırada tetiklenir.                  |
| 10  | Gerçekçi "kategori ataması" (çok alanlı şablon + select) | `"Categorize \"{title}\": {description}"`, `options: [bug, feature-request, question]`           | Amaç bölümünün verdiği örneklerden biri ("kategori") uçtan uca: ham kaynak alan değerlerinden geçerli bir seçeneğe.             |

## Kapsam DIŞI (bu dosyada)

- Gerçek Anthropic API çağrıları (yalnızca `AnthropicProvider`'ın kendi
  birim testleri, `packages/ai-gateway/src/anthropic-provider.test.ts`, gerçek
  SDK tiplerine karşı doğrulanır — gerçek ağ çağrısı hiçbir testte yapılmaz).
  `AI_TOKEN_QUOTA_PER_WORKSPACE` kota reddi, `onSourceChange` debounce'u ve
  AI→AI kademelenmeme koruması ( `object-ai-refresh.integration.test.ts`'te
  kanıtlı, Postgres/EventStore'a bağımlı oldukları için bu saf eval
  senaryolarına dahil edilmedi).
- Çoklu model yönlendirme, streaming, sohbet arayüzü (F1-T14/T15/T16 — spec
  kapsam dışı).
- F1-T17'nin tam eval altyapısı (skorlama, insan değerlendirmesi, model
  karşılaştırması) — bu dosya yalnızca tohumdur.
