# ADR-0005: Custom Fields Motoru — Alan Değerlerinin Nesne Stream'inde Yaşaması, Doğrulama Motoru ve Rol-Bazlı Görünürlük

**Durum:** Kabul edildi
**Tarih:** 2026-07-24
**İlgili görev:** [F1-T2 — Custom Fields Motoru](../specs/F1-E1/F1-T2-custom-fields.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E1: Lumina Object Modeli" (F1-T2 satırı) ve CLAUDE.md "Mimari Değişmezler": _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_ — ayrıca "Kodlama Sözleşmeleri": _"Domain paketleri (`core-objects`, `context-fabric`, `memory`, `automation`) framework import edemez — saf TypeScript kalır"_ (zod bağımlılığı kararı için, bkz. aşağıda).

> Bu ADR dokümantasyon amaçlıdır (F0-T6/ADR-0002 emsali): F1-T2 spec'i bu görevi mimari-kritik olarak işaretlememişti (F1-T1/ADR-0003'teki gibi koda-geçmeden-önce zorunlu insan onayı yok), ama gerçek bir mimari karar içeriyordu. Karar, uygulama planında (`giggly-brewing-moore.md`) önceden gerekçelendirildi, üç PR (PR-A domain, PR-B alan tanımı CRUD, PR-C alan değeri yazımı + rol filtreleme) bu plana göre uygulandı ve her biri `security-reviewer` denetiminden geçti. Bu ADR, koddan SONRA, gerçekleşen mimariyi belgeler.

## Bağlam

F1-T1, tüm nesne tiplerinin (task/doc/note) paylaştığı olay-kaynaklı `LuminaObject` çekirdeğini kurmuştu. F1-T2, her workspace'in kendi nesne tiplerine özel alan tanımlayabilmesini istiyor: 12 alan tipi, tip başına doğrulama, varsayılan değerler ve rol-bazlı (`owner/admin/member/guest`) görünürlük/yazma izinleri — F1-T1'in üzerine inşa edilen ikinci event-sourced alt sistem.

Çözülmesi gereken merkezi gerilim: **alan değerleri (`FieldValueChanged`) hangi stream'de yaşayacak?** İki seçenek vardı: (a) ayrı bir `field-value` stream'i, ya da (b) nesnenin kendi `lumina-object` stream'i. Spec açıkça iki şey istiyordu ki bunlar birlikte bu kararı zorluyordu: "varsayılan değerler `ObjectCreated` akışında uygulanır ve replay'de korunur" (atomiklik) ve F1-T1'in donmuş `replayObject`/`LuminaObject` sözleşmesine dokunulmaması (ADR-0003'ün PR-A'sı zaten kabul edilmiş, koda geçilmişti).

İkincil gerilimler: (1) 12 tipli bir doğrulama motoru, `packages/core-objects`'in bugüne kadar bağımlılık-sız (yalnız `ulid` + `@luminaos/shared`) kalmış olmasıyla nasıl uzlaştırılacak; (2) alan bazlı izinler `hasAtLeastRole`'ün sıralı hiyerarşisine mi oturacak yoksa farklı bir modele mi ihtiyaç duyacak; (3) rol-bazlı görünürlük filtrelemesi nerede uygulanacak — saklanan bir view'da mı, yoksa istek anında mı.

## Karar

### Varlık modelleri: FieldDefinition, LuminaObject'ten ayrı bir event-sourced varlık

`FieldDefinition` (`packages/core-objects/src/fields/field-definition.ts`), workspace + nesne tipi kapsamında tanımlanan, **kendi event stream'ine sahip ayrı bir varlık**: `{ id, workspaceId, objectType, key, label, fieldType, config, defaultValue?, permissions, lifecycle('active'|'archived'), createdAt, updatedAt }`. Olayları `FieldDefined`/`FieldUpdated`/`FieldArchived`; `field-commands.ts`'teki saf komutlar (`defineField`/`updateField`/`archiveField`) `FieldEventDraft[]` üretir, `field-replay.ts`'teki `replayFieldDefinition` — `replay.ts`'in katı fold deseniyle birebir aynı disiplinde (ilk olay `FieldDefined` olmalı, her payload alanı `typeof`/tip-guard'larıyla doğrulanır, bilinmeyen event tipi no-op) — durumu türetir. Bu, `LuminaObject`'ten tamamen bağımsız bir yaşam döngüsüdür.

### Merkezi mimari karar — alan değerleri nesnenin KENDİ stream'inde yaşar

`FieldValueChanged` olayları **ayrı bir stream'e değil, nesnenin kendi `lumina-object` stream'ine** eklenir. İki gerekçe:

1. **Atomiklik.** Spec'in "varsayılan değerler `ObjectCreated` akışında uygulanır" şartı, default'ların `ObjectCreated` ile **aynı `append()` çağrısında, aynı stream'e** yazılmasını gerektiriyordu. Tek stream = tek `append()` = ya hep ya hiç. İki ayrı stream olsaydı ya dağıtık işlem gerekirdi ya da "nesne oluştu ama default'lar yazılamadı" yarı-durumu riski doğardı. Nitekim `ObjectsService.create` (`apps/server/src/objects/objects.service.ts`), `createObject`'in draft'larıyla `applyDefaultFieldValues`'in draft'larını birleştirip **tek** `append(streamId, 0, newEvents)` çağrısında yazıyor.

2. **F1-T1'in donmuş sözleşmesine sıfır dokunuş.** `replayObject`'in (`packages/core-objects/src/replay.ts`) `applyEvent`'i tanımadığı her olay tipinde sessizce no-op yapar (`default: return state`). Bu, `FieldValueChanged` olaylarının aynı stream'e eklenmesinin `replayObject`'i veya `LuminaObject` tipini hiç etkilemeyeceği anlamına geliyordu. Bunun yerine, aynı karma stream üzerinde çalışan **yeni, ayrı, saf bir fold** yazıldı: `field-value-replay.ts`'teki `replayFieldValues(events): Record<string, unknown>` — SADECE `FieldValueChanged` olaylarını `payload.fieldKey → payload.value` şeklinde katlar, `ObjectCreated` dahil her başka olay tipini sessizce atlar. Bu fold, `field-replay.ts`'in katı disiplininin (bilinmeyen event tipi → hata) **kasıtlı tersidir** — burada "bilinmeyen tip" beklenen normal durumdur, çünkü aynı stream'de hem `ObjectCreated`/`ObjectRenamed`/… hem `FieldValueChanged` olayları karışık akar. Sonuç: F1-T1'in hiçbir dosyasına (`replay.ts`, `LuminaObject` tipi) dokunulmadı; yalnızca `packages/core-objects/src/index.ts`'in barrel export'una saf bir ekleme yapıldı.

`objects_view` projeksiyonu (`apps/server/src/objects/objects-view.projection.ts`) `handles` listesine `'FieldValueChanged'`'i ekleyerek genişletildi — bu, spec'in kendisinin istediği bir F1-T1 dosyası değişikliğidir, kapsam dışına çıkma değildir (bkz. ADR-0003'ün "Neyi erteliyoruz" bölümünde Custom Fields'ın zaten planlanmış bir sonraki adım olarak listelenmesi).

### 12 alan-tipi doğrulama motoru — zod, `packages/core-objects`'e kontrollü bir istisna olarak eklendi

`field-type-registry.ts`, 12 alan tipini (`text`, `longText`, `number`, `checkbox`, `date`, `datetime`, `select`, `multiSelect`, `url`, `email`, `people`, `currency`) tanımlar; her tip için hem `config` şeması hem `value` şeması `zod` (repoda zaten `^4.4.3`, built-in `z.iso.date()`/`z.iso.datetime()`/`z.url()`/`z.email()` kullanılarak) ile kurulur. `validateFieldConfig`/`validateFieldValue` bilinmeyen tip veya geçersiz config/değerde `ValidationError` fırlatır — zod issue'ları `details`'e taşınır, ham değer asla mesaj string'ine gömülmez (F1-T1 PR-A'nın güvenlik-denetimi dersinin burada tekrarı).

Bu, `packages/core-objects`'in F1-T1'e kadar bağımlılık-sız (yalnız `ulid` + `@luminaos/shared`) kalmış `package.json`'ına **`zod`'un ilk kez eklenmesi** anlamına geliyordu. Bu bilinçli, gözden geçirilmiş bir istisnadır, framework sızması değil: CLAUDE.md'nin "Domain paketleri framework import edemez (React/Nest yasak)" kuralı **framework**'leri (UI/uygulama-sunucusu çatıları) hedefler; `zod` saf bir doğrulama kütüphanesidir, React/NestJS gibi bir çalışma-zamanı çatısı değildir ve bu kuralı ihlal etmez.

Güvenlik denetimi sırasında eklenen bir sertleştirme: `select`/`multiSelect` config'inin `options` alanına açık boyut sınırları kondu — en fazla 500 seçenek, seçenek başına en fazla 200 karakter (`MAX_OPTIONS_COUNT`/`MAX_OPTION_LENGTH`, `field-type-registry.ts`). Bu, "sınırsız dış girdi" dersinin gelecekteki alan tiplerine de uygulanması gereken genel bir kural olarak not edilmiştir (bkz. "Neyi erteliyoruz").

### Rol-izin modeli: sıralı hiyerarşi değil, açık per-role map

`hasAtLeastRole`'ün sıralı hiyerarşisi (`guest:0 < member:1 < admin:2 < owner:3`) burada uygulanamaz, çünkü alan-bazlı görünürlük tek bir sıralı skalar değildir — bir rol bir alanda `view`-only, başka bir alanda `edit` olabilir. Bunun yerine `field-permissions.ts`, `FieldPermissions = Record<Role, 'view'|'edit'|'hidden'>` şeklinde **açık bir per-role map** tanımlar; `canViewField`/`canEditField` bu map'i sorgular, `isValidFieldPermissions` (untrusted girdi guard'ı) tam 4 rol anahtarını, fazlasız-eksiksiz, geçerli seviye değerleriyle zorunlu kılar.

`packages/core-objects`, `apps/server`'a bağımlı olamayacağından (framework-free sınırı), kendi `Role = 'owner'|'admin'|'member'|'guest'` tipini tanımlar — `apps/server`'ın `membershipRoleEnum`/`MembershipRole`'ünün küçük, kontrollü bir tekrarı. Sunucu tarafında (`FieldsController.requireRole`, `ObjectsController.requireRole`) bu iki tip yapısal olarak özdeş olduğundan cast bir no-op'tur, gerçek bir dönüşüm değildir.

### Okuma modeli genişlemesi ve izin filtrelemesinin isteği-anında yapılması

`objects_view` (`apps/server/src/db/schema/objects-view.ts`) yeni bir `field_values jsonb not null default '{}'` kolonuyla genişledi — ayrı bir "field values" tablosu **değil**. `ObjectsViewProjection`'ın `FieldValueChanged` case'i, `objectId`/`fieldKey`/`value`'yu parametreli bir `jsonb_set` çağrısıyla (Drizzle `sql` template — her değer bağlı bir parametre, asla string interpolasyonu değil) per-key merge eder.

**Rol-bazlı görünürlük filtrelemesi (`hidden` alanların yanıttan süzülmesi) saklanan bir view'da ÖNCEDEN yapılmaz, HER İSTEKTE yapılır** — kime göre "hidden" olduğu isteği yapan kullanıcının rolüne bağlı olduğundan, önceden hesaplanmış/önbelleklenmiş bir view bu bilgiyi taşıyamaz. `FieldDefinitionsService.list` ve `ObjectsService.get`/`list`/`create`/`setFieldValues`, artık `callerRole` parametresini alır ve yanıtı oluştururken `canViewField`/`filterFieldValuesForRole` ile filtreler.

### Şema-yönetimi izni: admin+ zorunlu

Alan tanımlarını (`FieldDefinition`) tanımlamak/güncellemek/arşivlemek **admin ve üzeri** rol gerektirir — bu, spec'te açıkça yazmayan, planlama sırasında kullanıcı onayıyla netleştirilen bir tasarım kararıdır. `FieldsController`, yazma rotalarında (`POST /`, `PATCH /:fieldDefinitionId`, `POST /:fieldDefinitionId/archive`) `hasAtLeastRole(role, 'admin')` kontrolü yapar (`requireAdmin`), aksi halde mevcut `ForbiddenError` (403) fırlatılır. `GET /` her workspace üyesine açıktır; `hidden` alanlar `list`'in kendi `canViewField` filtresiyle süzülür. Değer yazımı (alan tanımlama değil) ise şema-yönetimi izninden bağımsız, her rolün kendi `FieldPermissions` map'indeki `edit` durumuna göre çalışır.

### Uygulama sırasında ortaya çıkan iki güvenlik-sertleştirmesi kararı

Bu iki karar, artık kalıcı mimari özellikler olarak, sadece bug-fix değil:

1. **Eşzamanlı `define()` yarışının projeksiyonu kalıcı olarak kilitlememesi.** `field_definitions` tablosunun `(workspaceId, objectType, key)` iş-benzersizliği kısıtı, event store'un bilmediği bir kuraldır — event store seviyesinde iki eşzamanlı `define()` çağrısı için her iki `FieldDefined` olayı da meşru şekilde append edilebilir. Bu ikisi aynı `catchUp` transaction'ında karşılaşırsa, kaybeden `INSERT` normalde ham bir Postgres unique-violation fırlatır ve **tüm batch'i** (checkpoint hiç ilerlemeden) iptal eder — bu, projeksiyonu o noktadan sonra HER workspace için kalıcı olarak tıkar ("poison pill"). Çözüm: `FieldDefinitionsViewProjection`'ın `FieldDefined` case'i, iş-benzersizliği indeksinde `onConflictDoNothing` kullanır (kaybeden insert'i sessizce atlar, projeksiyon sağlıklı kalır); `FieldDefinitionsService.define`, `catchUp` SONRASI kendi satırının gerçekten yazılıp yazılmadığını bir varlık kontrolüyle doğrular — yazılmadıysa çağıran gerçekten yarışı kaybetmiştir ve `ConflictError` görür (yanlış bir 201 değil). Bu, gelecekte event-sourced iş-benzersizliği kısıtları eklenecek her yerde izlenmesi gereken **genel bir desen** olarak not edilmiştir: kısıt-ihlalini projeksiyon seviyesinde sessizce yut, sonucu servis seviyesinde post-catchUp bir varlık kontrolüyle doğrula.

2. **`hidden` alana yazma denemesi 404 döner, 403 değil.** `ObjectsService.setFieldValues`, çağıranın `view` izni bile olmayan (`hidden`) bir `fieldKey`'e `PATCH .../objects/:id/fields` ile yazmaya çalıştığında, bu alanı **hiç tanımlanmamış bir alandan kasıtlı olarak ayırt edilemez** kılar — ikisi de `NotFoundError` (404) döner. Yalnızca "view'ı var ama edit'i yok" durumundaki bir alan (çağıranın zaten `GET` ile meşru şekilde varlığını gördüğü bir alan) `ForbiddenError` (403) alır. Gerekçe: ayırt edilebilir bir 403, düşük yetkili bir çağıranın yazma uç noktasını kaba-kuvvetle deneyerek `hidden` alan anahtarlarını numaralandırmasına (existence oracle) izin verirdi — oysa bunu `GET`/`list` üzerinden yapamaz (zaten filtrelenmiş).

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- F1-T1'in event-sourcing/replay altyapısı **sıfır değişiklikle** yeniden kullanıldı (`replay.ts`/`LuminaObject` dokunulmadı) — aynı stream üzerinde çalışan, kasıtlı olarak farklı disiplinli (permissive) bir ikinci saf fold (`replayFieldValues`) eklendi.
- Nesne oluşturma + varsayılan değer uygulaması **atomik**: tek stream, tek `append()` çağrısı — yarı-tamamlanmış "nesne var ama default'ları yok" durumu imkansız.
- Tip-güvenli, genişletilebilir bir 12-tipli doğrulama motoru — `zod`'un `packages/core-objects`'e bilinçli, gözden geçirilmiş istisna olarak eklenmesiyle; framework-import kuralını ihlal etmez.
- `LuminaObject`'in çekirdek tipini kirletmeden alan-bazlı, rol-bazlı görünürlük/yazma izni — filtreleme her zaman istek anında, çağıranın gerçek rolüne göre yapılır, hiçbir önbelleklenmiş/saklanmış view'a "kime göre hidden" bilgisi sızmaz.

**Neyi erteliyoruz:**

- `formula`/`ai` alan tipleri (F1-T4/F1-T5).
- `people` tipi için gerçek kullanıcı-varlığı doğrulaması — bugün yalnızca şekil/format doğrulanır (bir string dizisi); gerçek ilişki doğrulaması F1-T3 kapsamındadır.
- Arşivlenmiş bir alan tanımının `key`'inin yeniden kullanılabilirliği — `(workspaceId, objectType, key)` unique kısıtı kalıcıdır, arşivleme anahtarı serbest bırakmaz; ihtiyaç doğarsa ayrı bir görev.
- UI form bileşenleri (spec'in kendi kapsam-dışı maddesi).
- Genel ders, bir sonraki alan tipi eklendiğinde de uygulanmalı: `select`/`multiSelect`'in `options` config'ine konan açık boyut sınırları (500 seçenek, seçenek başına 200 karakter) gibi, kullanıcı-tanımlı config/değer girdisi her zaman açık üst sınırlarla kabul edilmeli — "sınırsız dış girdi" varsayılan olarak güvenli değildir.
