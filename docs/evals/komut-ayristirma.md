# Komut Ayrıştırma Eval Golden-Set (F1-T17 PR2)

Bu dosya, `parseCommand` fonksiyonunun (F1-T16, ADR-0015) davranışını
sabitleyen 50 golden senaryoyu insan-okunur biçimde açıklar. `QA/RAG` eval'inin
(`docs/evals/qa.md`, F1-T17 PR1, 40 senaryo) doğrudan devamıdır — aynı desen:
gerçek bir Anthropic çağrısı gerektirmeden, `MockProvider` ile deterministik
olarak CI'da (`pnpm test`) koşar.

## Nerede yaşıyor

- **Senaryolar (bu dosya):** insan-okunur açıklama, aşağıda.
- **Uygulama:** `apps/server/src/ai/commands.eval.test.ts` — aynı 50 senaryoyu
  `parseCommand` (`apps/server/src/ai/parse-command.ts`) ve
  `@luminaos/ai-gateway`'in `MockProvider`'ı üzerinden test eder. NestJS DI
  yok, Testcontainers yok, düz `vitest` ile koşar. Bu dosyanın tablosuyla
  1:1 senkron tutulur.
- **Karakterizasyon (F1-T16 orijinali):** `apps/server/src/ai/parse-command.test.ts`
  — bu golden-set'in ÖNCESİNDE yazılmış temel davranış (RED adımı) testleri;
  bu dosya onları TEKRARLAMAZ, tamamlar.
- **Uçtan uca kanıt:** `apps/server/src/commands/commands.service.integration.test.ts`,
  `apps/server/src/commands/commands.service.decide.integration.test.ts`,
  `apps/server/src/commands/commands.controller.integration.test.ts` ve
  `apps/server/src/commands/action-proposal.projection.integration.test.ts`
  aynı davranışı gerçek Postgres + HTTP üzerinden (RBAC, kota,
  `ActionsProposed`/`ActionsDecided` olayları ve `decide()` yürütme akışı
  dahil) doğrular — bu dosyanın kapsamı dışında.

`parseCommand`, `CommandsService.parse`'ın (F1-T16, ADR-0015) kullandığı saf,
DB'siz orkestratördür: `resolveAIFieldValue` ve `answerQuestion`'ın kardeşi,
aynı biçim — provider/model/`recordUsage` dışarıdan enjekte edilir. Modelden
ham bir JSON aksiyon dizisi ister (`type`/`intent`/`rationale`/`resources`/
`rollbackNote`/`params`), `JSON.parse` + `proposedActionSchema` (zod, kapalı
`type` birleşimi: `'createTask' | 'generateSubtasks' | 'assignPeople'`) ile
doğrular, ilk deneme ayrıştırma/doğrulamada başarısız olursa AYNI promptla
BİR KEZ tekrar dener, ikinci başarısızlıkta da güvenli bir sentinel döner
(`{ actions: [], parseError: true, message }`) — ASLA throw etmez, ASLA
aksiyon uydurmaz. Başarıyla doğrulanan her aksiyon, `parseCommand`'ın kendisi
tarafından basılan taze bir `crypto.randomUUID()` `actionId` alır (model asla
bir id sağlamış gibi güvenilmez). `recordUsage`, her `provider.complete`
çağrısı için bir kez tetiklenir (retry'de iki kez), yalnızca nihayetinde
başarılı olan deneme için değil.

## Senaryolar

### Grup A — Temel JSON ayrıştırma ve happy path (1-8)

| #   | Senaryo                                              | Girdi                                                | Beklenen Sonuç                                                                                                         |
| --- | ---------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Tek `createTask` aksiyonu, geçerli JSON ilk denemede | Geçerli tek elemanlı JSON dizisi                     | `provider.complete` 1 kez çağrılır; `intent`/`rationale`/`resources`/`rollbackNote`/`params` JSON'dan birebir taşınır. |
| 2   | Tek `generateSubtasks` aksiyonu                      | `type: 'generateSubtasks'`, `params: { count: N }`   | Tip doğru ayrıştırılır; `params` içindeki ek alan (`count`) korunur.                                                   |
| 3   | Tek `assignPeople` aksiyonu                          | `type: 'assignPeople'`, `params: { userIds: [...] }` | Tip doğru ayrıştırılır; `params` içindeki `userIds` korunur.                                                           |
| 4   | İki aksiyon aynı yanıtta                             | `createTask` + `assignPeople` aynı dizide            | `actions.length === 2`; girdi sırası korunur.                                                                          |
| 5   | Üç aksiyon aynı yanıtta                              | Üç farklı tip aynı dizide                            | Hepsi doğru ayrıştırılır, sırayla.                                                                                     |
| 6   | Boş `resources` dizisi                               | `resources: []`                                      | Geçerli kabul edilir (zod boş diziye izin verir); `action.resources` `[]`.                                             |
| 7   | Çok elemanlı `resources`                             | `resources: ['a', 'b', 'c']`                         | Tüm elemanlar sırasıyla korunur.                                                                                       |
| 8   | Boş `params` objesi                                  | `params: {}`                                         | Geçerli kabul edilir.                                                                                                  |

### Grup B — Retry-once: bozuk JSON çeşitleri (9-16)

| #   | Senaryo                         | Girdi                         | Beklenen Sonuç                                                                           |
| --- | ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| 9   | Yanıt tamamen düz metin         | JSON olmayan serbest metin    | Retry tetiklenir; ikinci deneme geçerli → sonuç retry'den.                               |
| 10  | Yanıt JSON obje, dizi değil     | `{ actions: [...] }` envelope | Şema `.array()` beklediği için geçersiz → retry.                                         |
| 11  | Yanıt boş dize                  | `''`                          | `JSON.parse` hata fırlatır → retry.                                                      |
| 12  | Trailing-comma'lı bozuk JSON    | `[{...},]`                    | Parse hatası → retry.                                                                    |
| 13  | Markdown code-fence içinde JSON | ` ```json\n[...]\n``` `       | Fence karakterleri `JSON.parse`'ı bozar (fonksiyon fence'i ayıklamaz) → retry.           |
| 14  | Kesik/eksik JSON                | Kapanmamış dizi               | Parse hatası → retry.                                                                    |
| 15  | Sayısal literal                 | `"42"`                        | `JSON.parse` başarılı ama şema `.array()` bekler, sayı değil → doğrulama hatası → retry. |
| 16  | `null` literal'i                | `"null"`                      | `JSON.parse` başarılı (`null`), şema array bekler → doğrulama hatası → retry.            |

### Grup C — Retry-once: şema doğrulama hataları (17-24)

| #   | Senaryo                                                           | Girdi                                      | Beklenen Sonuç                                                 |
| --- | ----------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| 17  | `type` alanı tamamen eksik                                        | Aksiyon objesinde `type` yok               | Zod hata → retry.                                              |
| 18  | `intent` boş string                                               | `intent: ''`                               | `min(1)` ihlali → retry.                                       |
| 19  | `rationale` eksik                                                 | Aksiyon objesinde `rationale` yok          | Retry.                                                         |
| 20  | `resources` dizi değil                                            | `resources: 'not-an-array'`                | Tip hatası → retry.                                            |
| 21  | `resources` içinde sayısal eleman                                 | `resources: [123]`                         | Eleman tipi hatası → retry.                                    |
| 22  | `rollbackNote` eksik                                              | Aksiyon objesinde `rollbackNote` yok       | Retry.                                                         |
| 23  | `params` dizi olarak gönderilmiş                                  | `params: [1, 2, 3]`                        | Tip hatası → retry.                                            |
| 24  | Dizideki birden fazla aksiyondan biri geçersiz, diğerleri geçerli | 2 geçerli + 1 geçersiz aksiyon aynı dizide | TÜM dizi reddedilir (all-or-nothing, kısmi kabul yok) → retry. |

### Grup D — Çift başarısızlık → hata-sentinel VE önemli bir istisna (25-29)

| #   | Senaryo                                              | Girdi                                                           | Beklenen Sonuç                                                                                                                   |
| --- | ---------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 25  | Her iki deneme de düz metin                          | İki çağrı da JSON olmayan metin döner                           | `actions = []`, `parseError = true`, dolu `message` string, tam 2 çağrı, üçüncü çağrı YOK.                                       |
| 26  | Her iki deneme de closed-union dışı `type`           | İki çağrı da `type: 'deleteEverything'` döner                   | Aynı fallback (25 ile aynı).                                                                                                     |
| 27  | İlk deneme bozuk JSON, ikinci deneme şema-geçersiz   | Farklı hata türü kombinasyonu (parse hatası + doğrulama hatası) | Yine fallback.                                                                                                                   |
| 28  | Her iki deneme de `[]` (boş ama GEÇERLİ JSON dizisi) | İki çağrı da `'[]'` döner                                       | Bu bir hata DEĞİLDİR: `actions = []`, `parseError = FALSE` — "aksiyon önerilmedi" ile "ayrıştırılamadı" arasındaki kritik ayrım. |
| 29  | Her iki deneme de hata-mesajı gibi görünen düz metin | `"Error: rate limited"`                                         | JSON değil → fallback.                                                                                                           |

### Grup E — actionId üretimi ve tekillik (30-33)

| #   | Senaryo                                                        | Girdi                                                 | Beklenen Sonuç                                                                                                 |
| --- | -------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 30  | Tek aksiyon                                                    | Geçerli tek elemanlı JSON dizisi                      | `actionId` UUID şeklinde, boş değil.                                                                           |
| 31  | Çoklu aksiyon (3 tane)                                         | Üç farklı tip aynı dizide                             | Her biri FARKLI `actionId` alır (tekillik).                                                                    |
| 32  | Retry sonrası başarılı olan ikinci denemedeki aksiyonlar       | İlk deneme başarısız, ikinci deneme geçerli           | Aksiyonlar da `actionId` alır; ilk başarısız denemeden sızıntı yok.                                            |
| 33  | Modelin JSON'unda yanlışlıkla gönderilmiş bir `actionId` alanı | Aksiyon objesinde ekstra `actionId: 'model-supplied'` | YOK SAYILIR — `parseCommand` yine kendi UUID'ini üretir; dönen `actionId` modelin gönderdiğiyle AYNI DEĞİLDİR. |

### Grup F — Model yönlendirme, sourceObjectId ve usage kaydı (34-39)

| #   | Senaryo                            | Girdi                                       | Beklenen Sonuç                                                                                                           |
| --- | ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 34  | `model` belirtildiğinde            | `model: 'claude-x'` gibi bir değer          | `provider.complete` isteğine AYNEN iletilir.                                                                             |
| 35  | `model` belirtilmediğinde          | `model` alanı verilmez                      | İstekte model alanı yok / `undefined`.                                                                                   |
| 36  | `sourceObjectId` belirtildiğinde   | `sourceObjectId: 'obj-123'`                 | Prompt'a `Source object id: obj-123` satırı eklenir.                                                                     |
| 37  | `sourceObjectId` belirtilmediğinde | `sourceObjectId` verilmez                   | Prompt'ta böyle bir satır YOKTUR.                                                                                        |
| 38  | Tek denemelik başarıda usage kaydı | İlk deneme geçerli                          | `recordUsage` provider'ın rakamlarıyla TAM BİR KEZ çağrılır.                                                             |
| 39  | Retry senaryosunda usage kaydı     | İlk deneme başarısız, ikinci deneme geçerli | `recordUsage` HER İKİ çağrı için de (başarısız ilk + başarılı ikinci) sırayla, doğru rakamlarla çağrılır (2 kez toplam). |

### Grup G — Loglama disiplini (40-41)

| #   | Senaryo                                            | Girdi                                                         | Beklenen Sonuç                                                 |
| --- | -------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| 40  | Hassas görünümlü içerikte loglama yok (happy path) | Hassas görünümlü komut/`sourceObjectId`/ayrıştırılmış aksiyon | `console.log`/`error`/`warn` HİÇ çağrılmaz.                    |
| 41  | Retry/fallback yolunda loglama yok                 | Bozuk yanıt içeriği, çift başarısızlık                        | Aynı disiplin geçerlidir — bozuk yanıt içeriği bile loglanmaz. |

### Grup H — Gerçekçi ve belirsiz komut senaryoları (42-50)

| #   | Senaryo                                            | Girdi                                                                         | Beklenen Sonuç                                                                                                                                                                                      |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 42  | Gerçekçi `createTask` komutu                       | "şu hatayı düzeltmek için görev oluştur"                                      | Doğru tip + `intent` + `rationale`.                                                                                                                                                                 |
| 43  | Gerçekçi `generateSubtasks` komutu                 | "bu epic'i alt görevlere böl"                                                 | Doğru tip; `params` içinde alt görev bilgisi.                                                                                                                                                       |
| 44  | Gerçekçi `assignPeople` komutu                     | "bu görevi bir takım üyesine ata"                                             | Doğru tip; `resources`/`params` içinde kullanıcı referansı.                                                                                                                                         |
| 45  | Çok-adımlı gerçekçi komut                          | "görev oluştur VE bir kullanıcıya ata"                                        | Tek yanıtta İKİ aksiyon (`createTask` + `assignPeople`).                                                                                                                                            |
| 46  | Belirsiz/aksiyon-dışı komut                        | "bugün hava nasıl?"                                                           | Model geçerli ama boş dizi döner (`[]`) → `actions = []`, `parseError = false` (Grup D-28 ile tutarlı: "aksiyon yok" ≠ "hata").                                                                     |
| 47  | Aksiyon-dışı komuta düz açıklama metniyle cevap    | "I cannot determine an action from this request." (iki denemede de)           | JSON değil → retry → ikinci deneme de aynısını dönerse fallback.                                                                                                                                    |
| 48  | Uzun/çok-cümleli karmaşık komut + `sourceObjectId` | Uzun doğal dil komutu, `sourceObjectId` verilmiş                              | Yine tek geçerli JSON dizisiyle doğru ayrıştırılır.                                                                                                                                                 |
| 49  | Türkçe komut metni                                 | "Bu görevi tamamlandı olarak işaretle ve ekibe bildir"                        | Ayrıştırma mekanizması dil-bağımsız çalışır; prompt'ta komut AYNEN (Türkçe) yer alır.                                                                                                               |
| 50  | Kapsayıcı (capstone) senaryo                       | `sourceObjectId` + `model` belirtilmiş, 3 aksiyon (üç farklı tip) tek yanıtta | Her biri farklı `actionId`; `recordUsage` bir kez doğru rakamla; prompt'ta hem komut hem `sourceObjectId` AYNEN yer alır — AI Fields'in 10./QA'nın 40. senaryosuna paralel "hepsi bir arada" kanıt. |

## Kapsam DIŞI (bu dosyada)

- Gerçek Anthropic API çağrıları (yok, yalnızca `MockProvider`).
- RBAC/kota/HTTP/DB katmanı ve `ActionsDecided`/`decide()` yürütme akışı
  (F1-T16 PR5/PR6) — `apps/server/src/commands/*.integration.test.ts`'te
  kanıtlı, bu saf eval senaryolarına dahil değil.
- QA/RAG golden-set'i — ayrı dosya (`docs/evals/qa.md`, F1-T17 PR1, zaten
  birleştirildi).
- İnsan-değerlendirmeli skorlama / model karşılaştırma — F1-T17'nin açık
  sorusu, v1 kapsamı dışı.
- CI regresyon kapısı (F1-T17 PR3'ün kendi kapsamı, henüz eklenmedi).
