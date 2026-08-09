# Eval Golden-Set Deseni (F1-T17)

Bu dizin, LuminaOS'in AI-çağıran özelliklerinin ("ai" alan tipi, QA/RAG, komut
ayrıştırma, ...) davranışını sabitleyen **golden senaryoları** insan-okunur
biçimde belgeler. Her özellik kendi dosyasına sahiptir ve her dosya, CI'da
`ai-eval` job'ının (`.github/workflows/ci.yml`) koştuğu, eşleşen bir
`*.eval.test.ts` dosyasıyla 1:1 senkron tutulur — bu README, o eşleşmeyi
gelecekteki AI özellikleri için tekrarlanabilir kılan **tek, dokümante edilmiş
deseni** açıklar (bkz. `docs/specs/F1-E4/F1-T17-eval-altyapisi.md` madde 5).

## Mevcut golden-set'ler

| Dosya                                          | Özellik                                       | Senaryo | Eşleşen test dosyası                        |
| ---------------------------------------------- | --------------------------------------------- | ------- | ------------------------------------------- |
| [`ai-fields.md`](./ai-fields.md)               | "ai" alan tipi (`resolveAIFieldValue`, F1-T5) | 10      | `apps/server/src/ai/ai-fields.eval.test.ts` |
| [`qa.md`](./qa.md)                             | QA/RAG (`answerQuestion`, F1-T15)             | 40      | `apps/server/src/ai/qa.eval.test.ts`        |
| [`komut-ayristirma.md`](./komut-ayristirma.md) | Komut ayrıştırma (`parseCommand`, F1-T16)     | 50      | `apps/server/src/ai/commands.eval.test.ts`  |

**Toplam: 100 senaryo.** CI'daki `ai-eval` job'ı bu üç dosyayı birlikte çalıştırır
ve toplam senaryo sayısının 100'ün altına düşmediğini de doğrular (bkz. aşağı).

## Yeni bir golden-set eklemenin deseni

Faz 2+'de yeni bir AI özelliği (örn. Context Fabric, Memory Passport) eklendiğinde,
aynı iki-dosyalı desen tekrarlanır:

1. **Saf, DB'siz orkestratör fonksiyonu zaten var olmalı.** `resolveAIFieldValue`,
   `answerQuestion`, `parseCommand` deseninde: `provider`/`model`/`recordUsage`
   dışarıdan enjekte edilir, Postgres/EventStore'a hiç dokunulmaz. Golden-set bu
   fonksiyona karşı yazılır — NestJS DI'a veya Testcontainers'a bağımlı olan
   `*.integration.test.ts` dosyalarına değil.
2. **`docs/evals/<ozellik-adi>.md`** — insan-okunur senaryo dosyası:
   - Kısa bir giriş paragrafı (hangi fonksiyonu belgelediği, hangi ADR'a bağlı olduğu).
   - "Nerede yaşıyor" bölümü: eşleşen eval test dosyasına, varsa önceki
     karakterizasyon testlerine (`*.test.ts`) ve entegrasyon testlerine link.
   - "Senaryolar" bölümü: `# | Senaryo | Girdi | Beklenen Sonuç` tablosu — büyük
     setlerde (`qa.md`, `komut-ayristirma.md` gibi) ilgili H3 alt-gruplara bölünebilir,
     numaralandırma dosya genelinde sürekli olur.
   - "Kapsam DIŞI" bölümü: bu dosyanın kasıtlı olarak kapsamadığı şeyler (gerçek
     sağlayıcı çağrıları, RBAC/kota/HTTP katmanı, insan-değerlendirmeli skorlama).
3. **`apps/server/src/ai/<ozellik-adi>.eval.test.ts`** — aynı senaryoları,
   AYNI numaralandırmayla, doğrudan `MockProvider`/`MockProvider.fixed`
   (`@luminaos/ai-gateway`) üzerinden test eden `vitest` dosyası. NestJS DI yok,
   Testcontainers yok, `pnpm test` altında normal şekilde koşar. Her `it()`
   üstünde, doc tablosundaki numarayla eşleşen bir `// --- Senaryo N ---` yorum
   bandı bulunur.
4. **`.github/workflows/ci.yml`'deki `ai-eval` job'ına dosya adını ekle** —
   `run:` adımındaki vitest dosya listesine yeni `*.eval.test.ts` yolunu ekle.
5. **Sentetik veri disiplini:** Tüm senaryolar sentetik/kurgusal içerik kullanır —
   gerçek kullanıcı verisi, gerçek şirket/kişi adı veya kimlik bilgisi biçimindeki
   string'ler YASAK (bkz. F1-T17'nin security-reviewer kabul kriteri). PR'ı
   bitirmeden önce security-reviewer'a bu diff'i gönder.

## Skorlama modeli (v1)

Basit pass/fail (deterministik `expect` doğrulamaları) — mevcut `ai-fields.md`
deseninin aynısı. Kısmi-doğruluk skorlama, insan-değerlendirmeli eval ve model
karşılaştırması F1-T17'nin kapsamı dışında bırakıldı (bkz. spec dosyasının
"Açık Sorular" bölümü); bu README, o kapsam genişlediğinde güncellenecek ilk
yerdir.
