# ADR-0003: Lumina Object Çekirdeği — Varlık Modeli, Kimlik Stratejisi ve Replay

**Durum:** Kabul edildi
**Tarih:** 2026-07-24
**İlgili görev:** [F1-T1 — Lumina Object: Varlık Çekirdeği](../specs/F1-E1/F1-T1-varlik-cekirdegi.md)
**İlgili plan referansı:** `docs/PLAN.md` §7 (F1-E1 Lumina Object Modeli) ve CLAUDE.md "Mimari Değişmezler": _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_

> Bu ADR mimari-kritiktir. F1-T1 spec'inin kuralı ve Kabul Kriteri #1 gereği koda geçilmeden ÖNCE insan onayı alınması şart koşulmuştu; onay alındı, PR-A bu ADR'nin kararlarına göre uygulandı.

## Bağlam

F1-T1, "Her şey bir Lumina Object'tir" ilkesinin çekirdeğini kurar: görev, doküman, not — hepsinin paylaştığı tek varlık modeli, yaşam döngüsü ve olay üretimi. Bu, tüm ürünün üzerine oturacağı domain modeli olduğundan zor değişmezleri şimdi doğru kurmak gerekir.

Çözülmesi gereken üç gerilim var:

1. **Kimlik gerilimi (merkezi karar).** Spec, Lumina Object id'sinin **ULID** olmasını ister (zaman-sıralı; liste görünümleri için). Ancak F0-T6 event store **donmuş bir sözleşmedir**: `domainEventSchema`'daki `id`/`streamId`/`workspaceId` hepsi `z.uuid()`'dir ve `events` tablosu bunları Postgres `uuid` sütunlarında saklar. Bir ULID geçerli bir uuid değildir ve uuid sütununa giremez. Bu iki gereksinim doğrudan çakışır.
2. **Durum türetme.** CLAUDE.md ve ADR-0002 gereği durum yalnızca olaylardan türetilmelidir; `LuminaObject` bir tablo satırı değil, olayların bir fold'udur.
3. **Saflık ve genişletilebilirlik.** `packages/core-objects` framework import edemez (saf TypeScript). Domain deterministik olmalı ki spec'in istediği fast-check property testi (hiçbir geçerli komut dizisi geçersiz duruma ulaşamaz) yazılabilsin. Tip kayıt defteri (`task`/`doc`/`note` ile başlayıp) genişletilebilir olmalıdır.

## Karar

### Varlık modeli

`packages/core-objects` (saf TypeScript) içinde:

`LuminaObject { id (ULID), type, workspaceId (uuid), title, createdBy, createdAt, updatedAt, lifecycle }`. İlk tipler: `task`, `doc`, `note`. Durum yalnızca olaylardan türetilir: `replayObject(events[]) → LuminaObject`, duvar saati/rastgelelik/dış I/O içermeyen **saf bir fold**'dur — ADR-0002'deki projeksiyon `apply`'ının determinizm garantisiyle aynı disiplin.

### Kimlik stratejisi — Seçenek A (seçildi): ULID iş kimliği + ayrı UUID stream kimliği

Nesnenin **iş kimliği (id) bir ULID**'dir — API, URL ve projeksiyonda görünen kimlik budur; spec'in zaman-sıralanabilirlik gereksinimini karşılar. Her nesneye ayrıca **rastgele bir UUID `streamId`** atanır — bu, olay-akışı kimliğidir ve donmuş event store'a hiç dokunmadan `uuid` sütunlarına uyar. `objectId (ULID) → streamId (uuid)` eşlemesi `objects_view` projeksiyonunda tutulur.

Yazma yolunda `objectId → streamId` araması **çifte iş görür**: aynı sorgu nesnenin varlığını ve workspace kapsamını da doğrular (yanlış workspace'ten gelen ya da var olmayan bir id reddedilir). Böylece ekstra bir kontrol katmanı gerekmez.

**Reddedilen alternatifler:**

- **(B) ULID'in 128 bitini bir codec ile streamId UUID'sine yeniden yorumlamak** (`streamId ≡ objectId`, arama yok). Reddedildi: aynı kimliği iki farklı kodlamada gösterir (events tablosu = UUID, API = ULID). Bu, hata ayıklama ve bilişsel yük açısından gerçek bir maliyettir (bir kimliği iki temsili arasında sürekli zihinsel çeviri) ve ayrıca test edilmesi gereken ekstra bir codec ister. Kazanılan tek şey (bir arama) zaten workspace-kapsam doğrulaması için gereken sorguyla örtüşüyor.
- **(C) Nesne id'leri için doğrudan UUID kullanmak.** Reddedildi: spec'in açık ULID gereksiniminden sapar ve id'nin zaman-sıralanabilirliğini (liste görünümleri için değerli) kaybeder.

### Tip genişletme

Genişletilebilir bir tip kayıt defteri: `Record<ObjectType, { titleRequired: boolean }>`. `task` boş olmayan bir title zorunlu kılar; `doc`/`note` boş title'a izin verir (spec'in "boş title reddi doc/note için opsiyonel — parametrik" kuralı). Yeni bir nesne tipi eklemek = kayıt defterine bir giriş eklemek (+ sonra kendi şeması/migration'ı). Bilinmeyen tipler reddedilir.

### Yaşam döngüsü durum makinesi

Durumlar: `active → archived → deleted(soft)`. Geçişler:

- **archive**: `active → archived`
- **restore**: `(archived | deleted) → active` — deleted'dan geri yükleme spec gereği açıkça dahildir.
- **softDelete**: `(active | archived) → deleted`

`deleted` bir nesneye gelen her komut **restore hariç** reddedilir. Kalıcı silme ayrı bir `purge` komutudur; bu görevde **yalnızca arayüzü** tanımlanır, uygulanmaz.

Değişmezler: boş-title reddi (tipe göre parametrik), `workspaceId` değiştirilemez, deleted nesneye komut reddedilir. İhlaller `packages/shared/errors` `AppError` alt sınıflarıyla fırlatılır:

- Yasadışı yaşam döngüsü geçişi / deleted nesneye komut → **yeni `InvalidObjectStateError` (409)**.
- Boş title / bilinmeyen tip → mevcut **`ValidationError` (400)**.

### Komut → olay → replay

Komutlar (`createObject`, `renameObject`, `archiveObject`, `restoreObject`, `softDeleteObject`) `packages/core-objects` içinde **saf fonksiyonlardır**; domain olay taslakları `{ type, payload }[]` döndürür (payload her zaman `objectId` taşır) ve değişmez ihlalinde fırlatır. Geçmiş-zaman olayları (`ObjectCreated`, `ObjectRenamed`, `ObjectArchived`, `ObjectRestored`, `ObjectSoftDeleted`) F0-T6 `DomainEvent` sözleşmesine uyar.

Nesne id'si (ULID) domain tarafından üretilir (`newObjectId()`) ancak `createObject`'e **argüman olarak geçilir** — böylece komutlar deterministik/saf kalır (fast-check property testi için kritik; test id'yi kendisi sağlar, komut içinde rastgelelik olmaz).

Sunucu katmanı taslakları `NewDomainEvent`'e sarar: olay `id` = `randomUUID()`, `streamType` = `'lumina-object'`, `workspaceId`, `actor`, `occurredAt` atanır ve `EventStoreService.append()` ile eklenir.

### Okuma modeli ve projeksiyon tazeliği

Okumalar (`get`/`list`) bir `objects_view` projeksiyonundan (F0-T6 projeksiyon çatısı) gelir, workspace ile filtrelenir; `list` soft-deleted nesneleri hariç tutar. **Komut kararları ise her zaman olay akışından verilir** (`readStream → replayObject → yetkili durum + iyimser-eşzamanlılık versiyonu`), asla projeksiyondan değil. Bir komut olay ekledikten sonra sunucu senkron olarak `ProjectionRunner.catchUp(objectsViewProjection)` çağırır; böylece okumalar anında tutarlıdır (read-your-writes).

### Devralınan altyapı ve sınır

- F0-T6'nın ADR-0002'si projeksiyon eşzamanlılık kilidini zaten erteler; F1-T1 bunu **devralır** — aynı projeksiyon için iki eşzamanlı `catchUp` çağrısı kilitli değildir. Bu görev/v0 için kabul edilebilir; taşınan ertelenmiş kapsam olarak not edilir.
- F0-T6 event store hiçbir Nest modülüne bağlanmamıştı; F1-T1 bu bağlamayı ekler (bir `EventStoreModule`). Bu, yeni mimari değil, **etkinleştirici altyapıdır**.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- Gelecekteki tüm nesne tiplerinin (task/doc/note/…) üzerine inşa edeceği olay-kaynaklı (event-sourced) varlık çekirdeği; tek bir yaşam döngüsü, tek bir olay üretim yolu.
- Spec'in ULID iş kimliği gereksinimi karşılanır ve **donmuş event store'a hiç dokunulmaz** (codec hilesi yok, şema değişmez); `objectId → streamId` araması aynı zamanda varlık + workspace-kapsam doğrulamasını da üstlenir.
- Deterministik, saf domain (framework-free) → spec'in istediği fast-check property testi doğrudan yazılabilir; hiçbir geçerli komut dizisi geçersiz duruma ulaşamaz.
- Senkron `catchUp` sayesinde read-your-writes: create → rename → archive → restore → list akışı anında tutarlı okur (spec'in entegrasyon testi bunu kanıtlar).

**Neyi erteliyoruz:**

- `purge` (kalıcı silme) uygulaması — bu görevde yalnızca arayüzü tanımlanır.
- Custom Fields (F1-T2), ilişkiler (F1-T3) ve içerik gövdesi/blok editörü (F1-T11) — sonraki F1 görevleri.
- Projeksiyon eşzamanlılık kilidi — ADR-0002'den devralınan ertelenmiş kapsam; bir zamanlayıcı veya çoklu-kopya dağıtım eklendiğinde (advisory lock / checkpoint satırında `SELECT ... FOR UPDATE`) kapatılacaktır.
- Zengin actor sözleşmesi (`{niyet, gerekçe, kaynaklar[], geri_alma_planı}`) — ADR-0002 gibi bu da minimal `{ type, id }` actor'ü kullanır; genişleme Faz 3 (Cam Kutu Ajanlar) kapsamıdır.
