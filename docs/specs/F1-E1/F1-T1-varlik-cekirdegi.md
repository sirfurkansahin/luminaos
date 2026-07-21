# F1-T1 — Lumina Object: Varlık Çekirdeği

**Epik:** F1-E1 (Lumina Object Modeli) · **Durum:** Yapılacak
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

- [ ] ADR-0003 yazıldı ve insan onayı alındı (koddan ÖNCE).
- [ ] `replayObject`: rastgele geçerli komut dizileri için property-based test (fast-check) — hiçbir dizi geçersiz duruma ulaşamaz.
- [ ] Deleted nesneye komut → tanımlı hata; restore sonrası komutlar tekrar çalışır (testli).
- [ ] API akışı entegrasyon testli: create → rename → archive → restore → list (yalnız kendi workspace'i).
- [ ] packages/core-objects kapsam ≥ %95; framework import lint'i yeşil.
