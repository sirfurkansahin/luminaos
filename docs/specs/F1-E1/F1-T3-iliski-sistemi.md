# F1-T3 — İlişki Sistemi

**Epik:** F1-E1 · **Durum:** Yapılacak
**Bağımlılık:** F1-T1

## Amaç

Nesneler arası üç ilişki türünü kurmak: ebeveyn-çocuk (alt görevler), referans (bağlantılı nesneler) ve bağımlılık (blocks/blocked-by) — çift yönlü tutarlılık garantisiyle.

## Kapsam

1. **Model:** `Relation { id, workspaceId, fromId, toId, kind: parentChild | reference | dependency }`. Olaylar: `RelationCreated`, `RelationRemoved`. Tek olay, iki yönü de temsil eder (ters yön projeksiyonda türetilir — çift kayıt YOK).
2. **Kurallar:**
   - parentChild: bir nesnenin en fazla 1 ebeveyni; kendi kendine/soyuna ebeveynlik reddi (döngü tespiti).
   - dependency: döngü reddi (A→B→C→A engellenir, hata döngüdeki zinciri raporlar).
   - reference: serbest; aynı çiftte aynı türden tekrar reddi (idempotent).
3. **Soft-delete etkileşimi:** nesne soft-delete olunca ilişkileri "askıya alınır" (projeksiyonda süzülür), restore'da geri gelir; purge tasarımında kalıcı temizlik notu düşülür.
4. **API + projeksiyon:** ilişki ekle/kaldır uçları; `getRelated(objectId)` tek çağrıda üç türü gruplu döner; alt görev sayısı/tamamlanma özeti projeksiyonu.

## Kapsam DIŞI

- İlişkiye göre görünüm gruplaması (F1-T6 sorgu katmanında).
- Otomatik zamanlama kaydırması (bağımlılık zinciri — Faz 2 takvim işlerinde).

## Kabul Kriterleri

- [ ] Döngü senaryoları: kendine ebeveyn, torununa ebeveyn, 3'lü bağımlılık döngüsü → hepsi tanımlı hatayla reddedilir (testli).
- [ ] 1000 nesnelik zincirde döngü tespiti < 50ms (performans testi).
- [ ] Soft-delete → getRelated'dan düşer; restore → geri gelir (testli).
- [ ] Replay determinizmi: ilişki olayları hangi sırayla gelirse gelsin projeksiyon aynı sonucu verir.
