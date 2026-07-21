# F1-T5 — AI Fields + ai-gateway v0

**Epik:** F1-E1 · **Durum:** Yapılacak
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

- [ ] Tüm AI çağrıları ai-gateway'den geçer; Anthropic SDK'sını başka paketten import etmek lint hatası (kural eklendi, testli).
- [ ] MockProvider ile akış deterministik testli: template doldurma, select doğrulama, hata yolu.
- [ ] onSourceChange: kaynak değişimi → debounce → yenileme; AI→AI döngüsü oluşmadığı testle kanıtlı.
- [ ] Kota aşımında çağrı tanımlı hatayla reddedilir; kullanım kayıtları olay günlüğünde.
- [ ] Prompt içeriğinin loglanmadığı security-reviewer tarafından doğrulandı.
