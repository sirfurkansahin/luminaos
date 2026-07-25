# F1-T5 — AI Fields + ai-gateway v0

**Epik:** F1-E1 · **Durum:** Tamamlandı
**Bağımlılık:** F1-T2 · **Önkoşul:** Anthropic API anahtarı (env: ANTHROPIC_API_KEY)

## Amaç

İçeriği AI tarafından üretilen alanlar (özet, kategori, öncelik önerisi) ve tüm AI çağrılarının geçtiği tek kapı: ai-gateway.

## Kapsam

1. **ai-gateway v0 (packages/ai-gateway):**
   - `AIProvider` arayüzü: `complete(request) → { text, usage }`; sağlayıcıdan bağımsız istek/yanıt tipleri.
   - `AnthropicProvider` (resmî SDK ile) + `MockProvider` (testler deterministik).
   - Kullanım sayacı: her çağrının token/maliyet kaydı `AIUsageRecorded` olayıyla; workspace bazlı basit kota kontrolü (env ile limit).
   - Hata/timeout/retry politikası (üstel geri çekilme, max 2 deneme); istek/yanıt logta MASKELENİR (prompt içeriği loglanmaz, yalnız meta).
2. **ai alan tipi:** FieldDefinition config: `{ promptTemplate, sourceFields[], outputType: text|select, refreshMode: manual|onSourceChange }`. promptTemplate içinde `{fieldKey}` yer tutucuları kaynak alan değerleriyle doldurulur.
3. **Doldurma akışı:** `refreshAIField(objectId, fieldKey)` → gateway → doğrulanmış sonuç → `FieldValueChanged(source: ai)` olayı. outputType=select ise sonuç tanımlı seçeneklerden biri olmak zorunda (değilse yeniden dene→#ERROR).
4. **onSourceChange tetikleyicisi:** kaynak alan değişince yenileme işi kuyruklanır (in-process job, debounce 5 sn); sonsuz döngü koruması: AI kaynaklı değişiklik yeni AI yenilemesi tetiklemez.
5. **Eval başlangıcı:** `docs/evals/ai-fields.md` + 10 senaryoluk golden test (MockProvider ile CI'da koşar) — F1-T17'deki tam eval altyapısının tohumu.

## Kapsam DIŞI

- Çoklu model yönlendirme kuralları, streaming, sohbet (F1-T14/T15/T16).

## Kabul Kriterleri

- [x] Tüm AI çağrıları ai-gateway'den geçer; Anthropic SDK'sını başka paketten import etmek lint hatası (kural eklendi, testli).
- [x] MockProvider ile akış deterministik testli: template doldurma, select doğrulama, hata yolu.
- [x] onSourceChange: kaynak değişimi → debounce → yenileme; AI→AI döngüsü oluşmadığı testle kanıtlı.
- [x] Kota aşımında çağrı tanımlı hatayla reddedilir; kullanım kayıtları olay günlüğünde.
- [x] Prompt içeriğinin loglanmadığı security-reviewer tarafından doğrulandı.

## Tamamlanma Notu

Dört PR halinde uygulandı (branch: `feature/f1-t5-ai-fields`), `docs/adr/ADR-0008-ai-alanlari.md`'de belgelendi:

- **PR-A** (`packages/ai-gateway`): `AIProvider` arayüzü, `AnthropicProvider`
  (gerçek SDK) + `MockProvider` (deterministik testler), `withRetry`
  (üstel geri çekilme, max 2 deneme). Repo-geneli `@anthropic-ai/sdk` import
  yasağı — `no-restricted-syntax` ile (ESLint flat-config'in aynı-isimli
  kural override tuzağından kaçınarak), `tooling/eslint/anthropic-sdk-ban.test.ts`
  ile testli.
- **PR-B** (`ai` alan tipi): `field-type-registry.ts`'in 14. tipi;
  `assertAIFieldRules` (F1-T4'ün `assertFormulaFieldRules`'ıyla ortak
  `defaultValue`/`edit`-izni reddi, ama bilinçli olarak döngü tespiti YOK);
  standalone `AIFieldErrorValue`; yeni `QuotaExceededError`.
- **PR-C** (sunucu entegrasyonu): `ObjectsService.refreshAIField` (`{type:
'agent', id: 'ai-gateway'}` — `Actor`'ün `'agent'` tipinin ilk gerçek
  kullanımı), `POST .../fields/:fieldKey/refresh` route, `ai` alanlarına
  doğrudan yazım reddi, debounce'lu `AIRefreshScheduler` +
  `onSourceChange` — AI→AI kademelenmesi yapısal olarak imkansız (kademelenme
  tetikleyicisi yalnızca kullanıcı-tetiklemeli yazım yolunda yaşıyor).
  Kümülatif, hiç sıfırlanmayan workspace kotası. **security-reviewer
  bulgusu:** kota kontrolünün eşzamanlı isteklerde TOCTOU yarışı taşıdığı
  tespit edildi (entegrasyon testiyle kanıtlandı) ve workspace-bazlı bir
  Postgres advisory lock (`pg_advisory_lock`) ile kapatıldı.
- **PR-D** (eval iskeleti): `docs/evals/ai-fields.md` + 10 senaryoluk golden
  test (`ai-fields.eval.test.ts`) — F1-T17'nin tam eval altyapısının tohumu.
  `refreshAIField`'ın karar mantığı (`resolveAIFieldValue`/`renderAIPrompt`),
  Testcontainers'sız `pnpm test` altında koşabilmesi için saf, DB'den
  bağımsız fonksiyonlara ayrıştırıldı (davranış değişmedi, mevcut testler
  yeşil kaldı).

`apps/server` tam entegrasyon takımı (19 dosya, 142 test, Testcontainers ile
gerçek Postgres+Redis+HTTP) + birim testleri (13 dosya, 98 test) yeşil,
regresyon yok.
