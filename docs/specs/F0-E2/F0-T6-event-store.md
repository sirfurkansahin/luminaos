# F0-T6 — Event Store (Olay Günlüğü) Altyapısı

**Epik:** F0-E2 · **Durum:** Yapılacak
**Bağımlılık:** F0-T5 (Postgres mevcut)

> ⚠️ MİMARİ-KRİTİK GÖREV: Bu görev tüm sistemin temelini kurar (PLAN.md "Mimari Değişmezler": tek doğruluk kaynağı olay günlüğüdür). Plan aşamasında en güçlü model kullanılmalı; plan insan tarafından dikkatle okunmadan onaylanmamalı.

## Amaç

Tüm veri değişikliklerinin değişmez (immutable) olaylar olarak kaydedildiği append-only event store'u ve olaylardan okuma modelleri (projeksiyon) üretme çatısını kurmak.

## Kapsam

1. **Olay sözleşmesi:** `packages/shared/events/` altında temel tipler: `DomainEvent { id, streamId, streamType, workspaceId, type, version, payload, actor, occurredAt }`. Zod şemasıyla doğrulama.
2. **Append-only tablo:** `events` tablosu; stream başına `version` ile iyimser kilitleme (aynı version'a ikinci yazım reddedilir).
3. **Event store API'si** (`apps/server/src/event-store/`): `append(streamId, expectedVersion, events[])`, `readStream(streamId)`, `readByWorkspace(workspaceId, fromPosition)`. Idempotency: aynı `event.id` ikinci kez yazılamaz.
4. **Yayın mekanizması:** İşlem-içi (in-process) event bus + outbox deseni iskeleti (ileride kuyruk takılabilir soyutlama).
5. **Projeksiyon çatısı:** `Projection` arayüzü (`handles[]`, `apply(event)`), checkpoint takibi, sıfırdan yeniden inşa (`rebuild`) komutu. Örnek projeksiyon: workspace başına olay sayacı.
6. **ADR-0002:** Olay şeması, sürümleme stratejisi ve projeksiyon yaklaşımı `architect` subagent ile `docs/adr/ADR-0002-event-store.md` olarak yazılır.

## Kapsam DIŞI

- Dış kuyruk sistemleri (Kafka vb.) — soyutlama yeter.
- Gerçek domain olayları (F1'de gelecek), snapshot'lar.

## Kabul Kriterleri

- [ ] Aynı stream'e eşzamanlı iki yazımda biri version çakışmasıyla reddedilir (testle kanıtlı).
- [ ] Aynı event.id ile ikinci append no-op olur (idempotency testi).
- [ ] Olaylar occurredAt/version sırasıyla okunur; workspace yalıtımı korunur.
- [ ] Örnek projeksiyon `rebuild` ile sıfırdan aynı sonucu üretir (determinizm testi).
- [ ] ADR-0002 yazıldı ve onaylandı; kapsam ≥ %90.
