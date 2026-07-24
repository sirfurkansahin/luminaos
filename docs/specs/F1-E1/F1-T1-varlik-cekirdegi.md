# F1-T1 — Lumina Object: Varlık Çekirdeği

**Epik:** F1-E1 (Lumina Object Modeli) · **Durum:** Tamamlandı
**Bağımlılık:** F0-T6 (event store)

> ⚠️ MİMARİ-KRİTİK GÖREV: Bu, tüm ürünün üzerine kurulacağı çekirdek domain modelidir. Plan aşamasında en güçlü model kullanılmalı; ADR yazılıp insan onayı alınmadan koda geçilmemeli.

## Amaç

"Her şey bir Lumina Object'tir" ilkesinin çekirdeğini kurmak: görev, doküman, not, toplantı — hepsinin paylaştığı tek varlık modeli, yaşam döngüsü ve olay üretimi.

## Kapsam (packages/core-objects — saf TypeScript, framework import yasak)

1. **Temel model:** `LuminaObject { id (ULID), type, workspaceId, title, createdBy, createdAt, updatedAt, lifecycle }`. İlk tipler: `task`, `doc`, `note` (tip kayıt defteri genişletilebilir tasarlanır).
2. **Yaşam döngüsü:** `active → archived → deleted(soft)`; geçiş kuralları (deleted'dan geri yükleme dahil); kalıcı silme yalnız ayrı bir "purge" komutuyla (bu görevde yalnız arayüzü tanımlanır, uygulanmaz).
3. **Komut → olay üretimi:** `createObject`, `renameObject`, `archiveObject`, `restoreObject`, `softDeleteObject` komutları; ürettiği olaylar: `ObjectCreated`, `ObjectRenamed`, `ObjectArchived`, `ObjectRestored`, `ObjectSoftDeleted`. Olaylar F0-T6 sözleşmesine uyar. Durum yalnız olaylardan türetilir: `replayObject(events[]) → LuminaObject`.
4. **Değişmezler (invariants):** boş title reddi (doc/note için opsiyonel kural parametrik), workspace değiştirilemez, deleted nesneye komut reddedilir; ihlaller `packages/shared/errors` tipleriyle fırlatılır.
5. **Server entegrasyonu:** apps/server'da `objects` API'si (create/rename/archive/restore/delete/get/list) — komutları çağırır, olayları event store'a append eder, `objects_view` projeksiyonundan okur (F0-T6 projeksiyon çatısı kullanılır).
6. **ADR-0003:** Varlık modeli, tip genişletme stratejisi ve replay yaklaşımı `architect` ile yazılır, insan onayından sonra uygulanır.

## Kapsam DIŞI

- Custom Fields (F1-T2), ilişkiler (F1-T3), içerik gövdesi/blok editörü (F1-T11).
- UI (F1-E2/E3'te görünümlerle gelecek).

## Kabul Kriterleri

- [x] ADR-0003 yazıldı ve insan onayı alındı (koddan ÖNCE).
- [x] `replayObject`: rastgele geçerli komut dizileri için property-based test (fast-check) — hiçbir dizi geçersiz duruma ulaşamaz.
- [x] Deleted nesneye komut → tanımlı hata; restore sonrası komutlar tekrar çalışır (testli).
- [x] API akışı entegrasyon testli: create → rename → archive → restore → list (yalnız kendi workspace'i).
- [x] packages/core-objects kapsam ≥ %95; framework import lint'i yeşil.

## Tamamlanma Notu

İki PR halinde uygulandı:

- **PR-A** (`packages/core-objects`, saf domain): `LuminaObject` tipleri, tip kayıt
  defteri, yaşam döngüsü durum makinesi, saf komut fonksiyonları
  (`create/rename/archive/restore/softDelete` + arayüz-only `purge`),
  `replayObject` fold'u, `newObjectId()` (ULID). `packages/shared`'a
  `InvalidObjectStateError` (409) eklendi. fast-check model-based property testi
  (AC #2) dahil 89 test, kapsam %100 (eşik %95). security-reviewer'ın 3 bulgusu
  (title için runtime tip koruması, replay'de bozuk payload'a açık red, hata
  mesajında ham objectType sızıntısı) TDD ile kapatıldı.
- **PR-B** (apps/server entegrasyonu): `EventStoreModule` (F0-T6 event store'un
  ilk Nest DI bağlantısı), `objects_view` şeması + migration (down script dahil),
  `ObjectsViewProjection`, `ObjectsService`/`ObjectsController`/`ObjectsModule`
  (`/workspaces/:workspaceId/objects` altında create/list/get/rename/archive/
  restore/soft-delete). 37 entegrasyon testi (Testcontainers, gerçek Postgres +
  Redis + HTTP) yeşil; cross-tenant izolasyon ve deleted-nesne 409/restore akışı
  dahil. security-reviewer: bulgu yok.

Kimlik stratejisi kararı (ULID iş kimliği + ayrı UUID streamId, `objects_view`
projeksiyonunda eşlenir) ADR-0003'te belgelendi ve insan onayından sonra
uygulandı.
