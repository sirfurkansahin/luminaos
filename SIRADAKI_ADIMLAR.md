# SIRADAKİ ADIMLAR — Faz 0 Kalanı + Faz 1 Başlangıcı

## Bu zip'i nereye çıkaracaksın?

LuminaOS klasörüne çıkar — `docs/specs/` içine iki yeni klasör eklenecek:

- `docs/specs/F0-E2/` (4 görev — önce bunlar)
- `docs/specs/F1-E1/` (5 görev — sonra bunlar)

## Görev sırası (bu sırayla, teker teker)

1. F0-T5 — Veritabanı + Auth → `docs/specs/F0-E2/F0-T5-veritabani-ve-auth.md`
2. F0-T6 — Event Store ⚠️ → `docs/specs/F0-E2/F0-T6-event-store.md`
3. F0-T7 — Tasarım Sistemi → `docs/specs/F0-E2/F0-T7-tasarim-sistemi.md`
4. F0-T8 — İzlenebilirlik → `docs/specs/F0-E2/F0-T8-izlenebilirlik.md`
5. F1-T1 — Varlık Çekirdeği ⚠️ → `docs/specs/F1-E1/F1-T1-varlik-cekirdegi.md`
6. F1-T2 — Custom Fields → `docs/specs/F1-E1/F1-T2-custom-fields.md`
7. F1-T3 — İlişki Sistemi → `docs/specs/F1-E1/F1-T3-iliski-sistemi.md`
8. F1-T4 — Formül Alanları → `docs/specs/F1-E1/F1-T4-formul-alanlari.md`
9. F1-T5 — AI Fields → `docs/specs/F1-E1/F1-T5-ai-fields.md`

## Her görev için komut kalıbı (dosya yolunu değiştir)

```
docs/specs/F0-E2/F0-T5-veritabani-ve-auth.md dosyasını oku. Önce plan mode'da bir uygulama planı çıkar ve bana onaylat. Onayladıktan sonra görevi CLAUDE.md'deki ritüele uyarak uygula. Kapsam dışına çıkma.
```

## ⚠️ Model uyarısı (F0-T6 ve F1-T1 için)

Bu iki görev tüm sistemin mimari temelini kuruyor. Bu görevlere başlamadan ÖNCE Claude Code'da `/model` yaz ve listedeki EN GÜÇLÜ modeli seç (Fable 5 görünüyorsa onu). Plan onaylandıktan sonra istersen `/model` ile tekrar Sonnet'e dönebilirsin (güçlü model Pro kotanı daha hızlı tüketir).

## Ön hazırlık (F0-T5'ten önce, bir kere)

- Docker Desktop kurulu olmalı (docker.com → indir, kur, başlat). Veritabanı bununla çalışacak.
- F1-T5'e gelmeden Anthropic API anahtarı gerekecek (console.anthropic.com) — zamanı gelince hatırlatırım.

## Notlar

- Her görev bitince PR aç → CI yeşil → merge → sonraki görev. Artık alıştın :)
- Takıldığın her yerde ekran görüntüsünü sohbete at.
