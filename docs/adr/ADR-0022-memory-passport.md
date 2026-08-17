# ADR-0022: Memory Passport — Paket Konumu, Bellek Kaydı Şeması, Tombstone Mekanizması, İzolasyon Kapsamı

**Durum:** Kabul edildi
**Tarih:** 2026-08-17
**İlgili görev:** [F2-T5 — Memory Passport: Bellek Deposu (Satır-Düzeyi Görünür/Düzenlenebilir/Silinebilir Kayıtlar)](../specs/F2-E2/F2-T5-memory-passport.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E2: Memory Passport" (F2-T5 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin **HER İKİ** fıkrası da bu kararı tetikliyor: **(a)** CLAUDE.md'nin "Mimari Değişmezler" listesi Memory Passport'un tombstone-ile-silme davranışını ("Silme = olayla yayılan tombstone, ajan önbellekleri dahil temizlenir") AÇIKÇA adıyla anıyor ve bu mekanizma repoda hiç yoktu — ilk kez burada tasarlanıyor; **(b)** bu görevin ürettiği bellek kaydı şekli (`kaynakOlayId`, tombstone event tipi, paket konumu) F2-E2'nin geri kalan üç görevine (F2-T6 "Hakkımda ne biliyorsun?" ekranı, F2-T7 içe/dışa aktarım JSON-LD şeması, F2-T8 erişim politikası manifestoları) dayatılan bir sözleşim tanımlıyor.

> Bu karar seti tamamen insan onaylı geldi: spec'in (`docs/specs/F2-E2/F2-T5-memory-passport.md`) "Açık Sorular" bölümündeki 5 sorunun tamamı — paket konumu (Açık Soru 1, KRİTİK), `kaynakOlayId` semantiği (Açık Soru 2, KRİTİK), izolasyon kapsamı (Açık Soru 3), tombstone temsili (Açık Soru 4, KRİTİK) ve edit semantiği (Açık Soru 5) — plan incelemesinde kapatıldı, hepsinde önerilen (A) seçenek kabul edildi. Bu ADR onları icat etmiyor, kod-seviyesi bir tasarıma döküyor ve mevcut kod tabanındaki tam emsallerle ilişkilendiriyor.
>
> En kritik, koddan önce kapatılması gereken karar Karar (a): F2-T1'in (bağlam grafiği) PLAN.md'nin paket haritasından (`packages/context-fabric`) tartışılmadan sapıp doğrudan `apps/server/src/context/` altında kurulmuş olması, F2-T5'in de aynı sapmayı mı izleyeceği yoksa haritaya mı döneceği konusunda açık bir öncül karar gerektiriyordu. İnsan kararı: haritaya dönülüyor — `packages/memory/` (saf TypeScript) + `apps/server/src/memory/` (NestJS bağlayıcısı), `core-objects`'in bugünkü ayrımıyla birebir aynı desen. Bu, gelecekteki F3-T1'in (Agent Runtime, framework-bağımsız erişim ihtiyacı yüksek) üzerine kuracağı temeli belirliyor.
>
> Tombstone mekanizması (Karar d) repodaki İLK gerçek "fiziksel satır kalır, projeksiyon onu okuma sorgularından tamamen filtreler" desenidir — `core-objects`'in `softDeleteObject`'i (ADR-0003) durum-makinesi tabanlı bir soft-delete olsa da (`active|archived → deleted` enum geçişi), bu ADR'nin kurduğu `deletedAt` (nullable timestamp) + sorgu-seviyesi filtre deseni ondan ayrı, yeni bir birincil desen olarak sabitleniyor.

## Bağlam

`packages/memory` ve `packages/context-fabric` PLAN.md §2.2 monorepo haritasında adlandırılmış ama repoda ikisi de yoktu — F2-T1, `packages/context-fabric` yerine doğrudan `apps/server/src/context/` altında kuruldu (tartışılmamış bir sapma). Bu ADR'nin Karar (a)'sı bu sapmayı tekrar etmemeyi, PLAN.md'nin haritasına dönmeyi seçiyor.

Keşif üç tam emsali doğruladı:

1. **`DesktopSignalConsentsService`** (`apps/server/src/context/desktop-signal-consents.service.ts`, F2-T3/ADR-0020) — en yakın "kullanıcı-sahipli, self-service, event-sourced satır" emsali: `grant`/`revoke` ortak bir `record()` içinde yeni olayı `append` eder, `projectionRunner.catchUp()` çağırır, satırı geri okur (okunamazsa `UnexpectedQueryResultError`). Controller `SessionAuthGuard`+`WorkspaceMembershipGuard` kullanır, kimlik HER ZAMAN `req.user.id`'den türetilir — gövdeden asla. Bu ADR'nin `MemoryRecordsService`'i bu deseni CRUD'a (list/create/edit/delete) genişletiyor.
2. **`core-objects`'in `softDeleteObject`** (`packages/core-objects/src/commands.ts`, ADR-0003) — en yakın "silme = event" emsali, ama bir durum-makinesi enum geçişi (`'deleted'`), ayrı bir tombstone kolonu DEĞİL. Bu ADR'nin Karar (d)'si bilinçli olarak ondan ayrılıyor: `deletedAt` nullable timestamp, sorgu-seviyesi filtre.
3. **`packages/core-objects` iskeleti** (`package.json`, `tsconfig.json`, `tsconfig.build.json`, framework import yok, saf TypeScript) — `packages/memory`'nin doğrudan kopyalayacağı paket-kurulum deseni.

Ayrıca `packages/shared/src/events/domain-event.ts`'in `DomainEvent = {id, streamId, streamType, workspaceId, type, version, payload, actor: {type, id}, occurredAt}` zarfı (zod `.strict()`) — yeni olay tipleri merkezi bir enum'a değil, geçmiş-zaman string literal'lere kaydediliyor (`DesktopSignalConsentGranted` deseni); bu ADR'nin üç yeni olayı da bu zarfa uyuyor.

Çözülmesi gereken merkezi sorular (spec'in Açık Soru 1-5'i insan onayıyla ÇOKTAN kapatıldı; bu ADR'nin görevi bunları kod-seviyesi bir tasarıma dökmek): (1) paket konumu; (2) `kaynakOlayId` semantiği; (3) izolasyon kapsamı; (4) tombstone fiziksel temsili; (5) edit semantiği; (6) F1-T18 export entegrasyonu; (7) test stratejisi.

## Karar

### (a) Paket konumu — `packages/memory/` (saf TS) + `apps/server/src/memory/` (NestJS bağlayıcısı), KESİN

PLAN.md'nin paket haritasına dönülüyor — `core-objects`'in bugünkü ayrımıyla birebir aynı desen:

- `packages/memory/` — saf TypeScript, framework import YOK (React/Nest yasak, CLAUDE.md domain-paket kuralı): `MemoryRecord` tipi, üç olayın zod payload şemaları (`.strict()`), doğrulama mantığı. `package.json`/`tsconfig.json`/`tsconfig.build.json`, `packages/core-objects`'in iskeletiyle aynı.
- `apps/server/src/memory/` — NestJS servis/controller/projection/Drizzle şeması; `packages/memory`'yi tüketen HTTP/DB bağlayıcısı.

Bu, F2-T1'in sapmasının BİLİNÇLİ olarak tekrar edilmediğinin kod-seviyesi kanıtı — gelecekteki F3-T1 (Agent Runtime) `packages/memory`'ye framework-bağımsız erişebilir, `apps/server`'a gömülü bir modülü import etmek zorunda kalmaz.

### (b) Bellek kaydı şeması ve `kaynakOlayId` semantiği

`MemoryRecord`: `id`, `workspaceId`, `userId` (sahip), `content` (metin), `kaynakOlayId`, `createdAt`, `updatedAt`, `deletedAt` (nullable — Karar d).

**`kaynakOlayId`:** v1'de HER ZAMAN kaydı yaratan `MemoryRecordAdded` olayının kendi `id`'sine eşittir — kendine-referans, alan hep dolu (asla `null` değil). Bu görev yalnızca kullanıcının ELLE oluşturduğu kayıtları kapsadığından (otomatik AI çıkarımı Kapsam Dışı), "hangi konuşma/olaydan öğrenildi" sorusu bu v1'de anlamsız — alan yine de şimdiden şemada var, PLAN.md'nin "her satırda `kaynak_olay_id`" notunu ilk günden karşılıyor. Gelecekte otomatik çıkarım geldiğinde bu alan asıl kaynak konuşma/olayı gösterecek şekilde YENİDEN YORUMLANIR — şema/kolon DEĞİŞMEZ, yalnızca semantik genişler.

### (c) Event tipleri — `MemoryRecordAdded`/`MemoryRecordEdited`/`MemoryRecordDeleted`

Geçmiş zaman, CLAUDE.md sözleşmesi. Hepsi `DomainEvent` zarfına (`{id, streamId, streamType, workspaceId, type, version, payload, actor:{type,id}, occurredAt}`, zod `.strict()`) uyar, `actor: {type:'user', id: userId}`.

**`streamId` — per-record `randomUUID()`, DETERMİNİSTİK DEĞİL (bilinçli sapma):** `DesktopSignalConsentsService`'in üçlü-anahtarlı deterministik `streamId` türetimi (`deriveDeterministicUuid(NAMESPACE, workspaceId:userId:signalType)`) burada UYGULANMAZ. Gerekçe: deterministik türetim "aynı doğal anahtar üçlüsü = aynı stream" tekilliğini garanti etmek için var (bir kullanıcının bir workspace'te bir sinyal tipi için TEK bir consent satırı olmalı) — bellek kaydında böyle bir tekillik kısıtı yok, kayıt kimliği zaten kullanıcı tarafından (her `create` çağrısında) üretiliyor, aynı kullanıcı aynı workspace'te sınırsız sayıda bağımsız bellek kaydı oluşturabilir. Her bellek kaydı kendi stream'ine sahiptir; `MemoryRecordAdded` bir stream'i `expectedVersion=0` ile açar, `MemoryRecordEdited`/`MemoryRecordDeleted` aynı stream'e sonraki versiyonlarla eklenir.

Payload şekilleri:

- `MemoryRecordAdded`: `{content: string}` — `id`/`kaynakOlayId` olayın kendi `id`'sinden (Karar b), `workspaceId`/`userId`/`occurredAt` zarftan türetilir, payload'da tekrarlanmaz.
- `MemoryRecordEdited`: `{content: string}` (Karar e).
- `MemoryRecordDeleted`: `{}` (boş payload — tombstone'un kendisi `event.type`'ın varlığıyla ifade edilir, ek bir alan gerekmez).

### (d) Tombstone temsili — fiziksel `DELETE` YOK, `deletedAt` (nullable timestamp) + sorgu-seviyesi filtre, KESİN

Silme fiziksel `DELETE` DEĞİLDİR. `MemoryRecordDeleted` olayı işlendiğinde, `memory-record.projection.ts` ilgili satırın `deletedAt` alanını `event.occurredAt` ile doldurur — satır DB'de KALIR. TÜM okuma sorguları (`list`/`get`, `apps/server/src/memory/memory-records.service.ts`) `deletedAt IS NULL` filtresiyle çalışır; tombstone'lu satırlar hiçbir okuma yolunda bir daha görünmez.

**Gerekçe:** "ajan önbellekleri dahil temizlenir" gereksinimi (CLAUDE.md Mimari Değişmezler) ileride `MemoryRecordDeleted`'ı TÜKETECEK bir mekanizma varsayıyor — satır fiziksel olarak silinirse, event log dışında hiçbir sorgulanabilir iz kalmaz, gelecekteki bir "ajan önbelleği temizleme" tüketicisi (Agent Runtime Faz 3, F3-T1'e bağımlı, henüz kurulmadı) hangi kayıtların ne zaman tombstone'landığını DB-seviyesinde sorgulayamaz. `deletedAt` sütunu bu izi ucuza (ek tablo/log gerektirmeden) bırakıyor.

Bu, `core-objects`'in `softDeleteObject`'inden (durum-makinesi enum geçişi) BİLİNÇLİ olarak ayrılan bir desen — `MemoryRecord`'un tek bir lifecycle durumu yok (`active`/`archived` gibi ara durumlar yok, yalnızca var/silinmiş ikili), bu yüzden tam bir durum-makinesi yerine daha basit bir nullable-timestamp yeterli.

### (e) Edit semantiği — `content` alanının TAMAMI değişir, alan-bazlı patch YOK

`MemoryRecordEdited`, `content` alanının TAMAMINI değiştirir. Tek bir `content` alanı olduğundan alan-bazlı bir patch şeması (`{field, oldValue, newValue}` gibi) gereksiz karmaşıklık olurdu — basitlik tercih edildi. `memory-record.projection.ts`, `MemoryRecordEdited` işlenirken satırın `content`'ini olayın payload'ındaki değerle DOĞRUDAN değiştirir (`updatedAt = event.occurredAt`), önceki değerle birleştirme/patch mantığı YOK.

### (f) İzolasyon kapsamı — `workspaceId` + `userId` ikilisi, KESİN

Her bellek kaydı `workspaceId` + `userId` ikilisiyle scoped — mevcut `desktop-signal-consents`/`core-objects` izolasyon deseniyle tutarlı. Kullanıcının farklı workspace'lerindeki bellek kayıtları BİRBİRİNDEN BAĞIMSIZDIR; global/tüm-workspace'ler-ortak bir bellek DEĞİLDİR. `memory_records` Drizzle şeması: `workspaceId uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`, `userId uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE` (`desktop-signal-consents.ts`'in AYNI FK deseni). Her sorgu (`list`/`get`/`edit`/`delete`) hem `workspaceId` hem `userId` ile süzülür — kimlik HER ZAMAN `req.user.id`'den (`MemoryRecordsController`, `SessionAuthGuard`+`WorkspaceMembershipGuard`), gövdeden/parametreden ASLA. Self-service by construction: bir kullanıcının başka bir kullanıcının bellek kaydını yönetmesi rol kontrolüyle değil, API'nin şeklinin kendisiyle imkânsız kılınır — `desktop-signal-consents.controller.ts`'in AYNI kalıbı (ADR-0020 Karar a).

**Gerekçe (PLAN.md'nin "kullanıcı başına" ifadesiyle ilişki):** PLAN.md'nin "kullanıcı başına" notu global bir bellek olarak da okunabilirdi, ama mevcut izolasyon deseninden (workspace + user ikilisi) sapmak cross-workspace sızıntı riski taşırdı ve `desktop-signal-consents`/`core-objects`'in bugün kurduğu emsalle tutarsız kalırdı — insan onayıyla dar yorum (workspace + user) seçildi.

### (g) F1-T18 export entegrasyonu — mekanik, ADR-gerektirmeyen ama burada referans veriliyor

Bellek kayıtları mevcut `ExportService`'in (`apps/server/src/export/export.service.ts`, F1-T18, ADR-0016) JSON export akışına dahil edilir — yalnızca `deletedAt IS NULL` satırlar. Yeni bir export formatı/sihirbazı KURULMAZ (o F2-T7'nin kapsamı); yalnızca mevcut export'un veri toplama adımına `memory-records.service.ts`'in `list()` çağrısı eklenir, JSON export şemasına küçük bir `memoryRecords` alanı eklenir. Bu, CLAUDE.md'nin "veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" mimari değişmezini ilk günden karşılıyor — bellek verisi export'tan BİLEREK dışlanmıyor.

## Alt-PR ayrıştırması

Mimari-kritik görev — CLAUDE.md'nin ±400 satır rehberliğine tabi. Parçalar bağımsız merge edilebilir sırayla:

- **PR1 — `packages/memory` + event şemaları:** paket iskeleti (`core-objects`'in kopyası), `MemoryRecord` tipi, üç olayın zod payload şemaları (Karar b/c/e), birim testleri.
- **PR2 — `apps/server/src/memory` (projection + service + controller + DB şeması):** `db/schema/memory-records.ts` (migration + down script), `memory-record.projection.ts` (Karar d/e), `memory-records.service.ts` (Karar c/f, `DesktopSignalConsentsService` deseni), `memory-records.controller.ts` (Karar f), `memory.module.ts`, entegrasyon testleri (CRUD, cross-user/cross-workspace red, tombstone-sonrası-görünmezlik, rebuild-determinizm). PR1'e bağımlı.
- **PR3 — F1-T18 export entegrasyonu (Karar g):** `export.service.ts` genişletmesi, entegrasyon testi (export'tan hariç tutulmadığının doğrulaması). PR2'ye bağımlı, mekanik/küçük.

F2-T6 ("Hakkımda ne biliyorsun?" ekranı), F2-T7 (içe/dışa aktarım sihirbazı, JSON-LD şema), F2-T8 (ajan erişim politikası manifestoları), otomatik AI-tabanlı bellek çıkarımı, gerçek ajan-önbelleği temizleme mekanizması, bellek kayıtlarının context-fabric grafiğine düğüm/kenar olarak eklenmesi — KAPSAM DIŞI (spec'in kendi "Kapsam DIŞI"sı korunuyor).

## Alternatifler ve Reddedilme Gerekçeleri

- **Seçenek B (paket konumu) — F2-T1'in fiilen kurduğu emsali izlemek, her şeyi `apps/server/src/memory/` altında tutup ayrı bir paket açmamak.** Reddedildi — Karar (a)'ya göre; F2-T1'in sapması tartışılmadan olmuştu, F2-T5 bunu tekrar etseydi PLAN.md'nin paket haritası hiçbir zaman gerçek bir emsal kazanmaz, gelecekteki F3-T1'in (framework-bağımsız erişim ihtiyacı yüksek) `apps/server`'a gömülü bir modülü import etmesi gerekirdi.
- **Tombstone için Seçenek B — silme anında projeksiyon satırını fiziksel olarak `DELETE` etmek (yalnızca event log'da iz kalır).** Reddedildi — Karar (d)'ye göre; "ajan önbellekleri dahil temizlenir" gereksinimi ileride tombstone event'ini TÜKETECEK bir mekanizma varsayıyor, projeksiyon satırı yok olduğunda gelecekteki bir tüketici için event log dışında hiçbir sorgulanabilir iz kalmaz.
- **`core-objects`'in durum-makinesi tabanlı soft-delete deseninin (`active|archived → deleted` enum) doğrudan kopyalanması.** Reddedildi — `MemoryRecord`'un ara lifecycle durumları yok (yalnızca var/silinmiş ikili); tam bir durum-makinesi gereksiz karmaşıklık olurdu, nullable `deletedAt` yeterli ve daha basit.
- **`MemoryRecordEdited` için alan-bazlı patch şeması (`{field, oldValue, newValue}`).** Reddedildi — Karar (e)'ye göre; tek bir `content` alanı varken patch şeması gereksiz karmaşıklık, basitlik tercih edildi.
- **`streamId` için `DesktopSignalConsentsService`'in deterministik-UUID türetimini (üçlü anahtardan) kopyalamak.** Reddedildi — Karar (c)'ye göre; deterministik türetim "aynı doğal anahtar = aynı stream" tekilliğini garanti etmek içindir, bellek kaydında böyle bir tekillik kısıtı yok (bir kullanıcı aynı workspace'te sınırsız bağımsız kayıt oluşturabilir); per-record `randomUUID()` daha doğru bir eşleşme.
- **İzolasyon kapsamını kullanıcının TÜM workspace'lerinde ortak/global bir bellek olarak yorumlamak (PLAN.md'nin "kullanıcı başına" ifadesinin geniş okuması).** Reddedildi — Karar (f)'ye göre; mevcut izolasyon deseninden (workspace + user) sapmak cross-workspace sızıntı riski taşırdı, `desktop-signal-consents`/`core-objects`'in bugün kurduğu emsalle tutarsız kalırdı.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- PLAN.md'nin paket haritası (`packages/memory`) ilk kez gerçek bir emsal kazanıyor — F2-T1'in tartışılmamış sapması burada bilinçli olarak tekrar edilmedi; gelecekteki F3-T1 (Agent Runtime) `packages/memory`'ye framework-bağımsız erişebilir.
- Repoda İLK gerçek tombstone-yayılım deseni (`deletedAt` + sorgu-seviyesi filtre) kuruluyor — CLAUDE.md'nin Memory Passport'u adıyla anan mimari değişmezi ilk kez somut, kod-seviyesi bir tasarıma dökülüyor.
- `kaynakOlayId`'nin v1 semantiği (kendine-referans) koddan önce kapatıldı — implementer'ın bu alanı `null` bırakması ya da yanlış bir "asıl kaynak" arayışına girmesi riski ortadan kalktı; şema gelecekteki otomatik-çıkarım görevi için hazır, değişiklik gerektirmeyecek.
- `MemoryRecordDeleted`'ın tüketicisiz kalması (ajan önbelleği temizleme henüz yok) spec'in kendi notuyla birlikte bilinçli kabul edilmiş bir YAGNI riski olarak burada da devralınıyor — F2-T4'ün Açık Soru 5'inde karşılaşılan aynı durumla tutarlı.
- F1-T18 export akışına bellek entegrasyonu (Karar g) koddan önce sabitlendi — "veri dışa aktarma kısıtlanamaz" değişmezinin ilk günden ihlal edilmemesi implementer'a bırakılmadı.

**Neyi erteliyoruz / kabul ediyoruz:**

- Gerçek "ajan önbelleği temizleme" mekanizması yok (Agent Runtime, F3-E1, henüz kurulmadı) — bu görev yalnızca `MemoryRecordDeleted`'ı yayınlıyor, bir tüketici kurmuyor; `deletedAt` sütunu bu tüketicinin geleceği günü bekliyor.
- Otomatik AI/ajan tabanlı bellek çıkarımı kapsam dışı — `kaynakOlayId`'nin semantik genişlemesi (asıl kaynak konuşma/olay) bu görevde gerçekleşmiyor, yalnızca şema buna hazır bırakılıyor.
- Bellek kayıtları context-fabric grafiğine (F2-T1) düğüm/kenar olarak eklenmiyor — iki sistem bilinçli olarak ayrı tutuluyor, birleştirme (varsa) ayrı bir karar.
- Tam JSON-LD şema tasarımı ve içe/dışa aktarım sihirbazı (F2-T7) bu ADR'nin kapsamında değil — Karar (g) yalnızca mevcut genel export'a mekanik bir ekleme.
