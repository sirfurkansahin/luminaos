# F2-T5 — Memory Passport: Bellek Deposu (Satır-Düzeyi Görünür/Düzenlenebilir/Silinebilir Kayıtlar)

**Epik:** F2-E2 (Memory Passport) · **Durum:** Tamamlandı — PR #131 (docs: ADR-0022 + spec), PR #132 (PR1: packages/memory), PR #133 (PR2: apps/server/src/memory), PR #134 (PR3: F1-T18 export entegrasyonu).
**Bağımlılık:** F0-T6 (event store — `EventStoreService.append`/`readStream`, `ProjectionRunner.catchUp`, ADR-0002), F2-T1 (bağlam grafiği — en yakın mimari emsal: PLAN.md'nin `packages/context-fabric` haritasını izlemeyip doğrudan `apps/server/src/context/` altında kurulmuştu, ADR-0017), `DesktopSignalConsentsService` (`apps/server/src/context/desktop-signal-consents.service.ts`, F2-T3/ADR-0020 — en yakın "kullanıcı-sahipli, self-service, event-sourced satır" emsali), `core-objects`'in `softDeleteObject`/lifecycle deseni (`packages/core-objects/src/commands.ts`, ADR-0003 — en yakın "silme = event" emsali).

> ⚠️ MİMARİ-KRİTİK GÖREV: Bu görev CLAUDE.md'nin her iki ADR kriterine de giriyor. (a) "Mimari Değişmezler" listesi Memory Passport'u AÇIKÇA adıyla anıyor: "Silme = olayla yayılan tombstone (ajan önbellekleri dahil temizlenir)" — bu mekanizma repoda hiç yok, ilk kez burada tasarlanacak. (b) Bu görevin ürettiği bellek kaydı şekli (`kaynak_olay_id`, tombstone event tipi, paket konumu) F2-E2'nin geri kalan üç görevine (F2-T6 "Hakkımda ne biliyorsun?" ekranı, F2-T7 içe/dışa aktarım JSON-LD şeması, F2-T8 erişim politikası manifestoları) dayatılan bir sözleşim. Ayrıca F2-T1'in PLAN.md'nin paket haritasından (`packages/context-fabric`) sessizce sapıp `apps/server/src/context/` altında kurulmuş olması, F2-T5'in de aynı sapmayı mı izleyeceği yoksa PLAN.md'nin `packages/memory` haritasına mı sadık kalacağı konusunda AÇIK bir öncül karar gerektiriyor — bu, gelecekteki F3-T1 (Agent Runtime) gibi görevlerin bellek paketine framework-bağımsız mı yoksa `apps/server`'a gömülü mü erişeceğini belirleyecek. `architect` taslağı + insan onayı koddan önce zorunlu.

## Amaç

Kullanıcı başına, satır-düzeyinde görünür/düzenlenebilir/silinebilir bir **bellek deposu** kurmak: LuminaOS'in bir kullanıcı hakkında "bildiği" her şeyin, o kullanıcının kendisi tarafından denetlenebilir, düzenlenebilir ve kalıcı olarak silinebilir (tombstone ile, ajan önbellekleri dahil temizlenerek) birinci sınıf kayıtlar haline gelmesi. Bu görev yalnızca **depolama + CRUD altyapısını** kurar; "Hakkımda ne biliyorsun?" ekranı (F2-T6), içe/dışa aktarım sihirbazı (F2-T7) ve ajan erişim politikaları (F2-T8) bu temel üzerine inşa edilecek ayrı görevlerdir.

## Mevcut Durum

- **Event zarfı** (`packages/shared/src/events/domain-event.ts`): `DomainEvent = {id, streamId, streamType, workspaceId, type, version, payload, actor: {type, id}, occurredAt}` (zod `.strict()`). Yeni olay tipleri merkezi bir enum'a değil, geçmiş-zaman string literal'lere kaydedilir (`DesktopSignalConsentGranted` deseni). `EventStoreService.append(streamId, expectedVersion, events[])` / `readStream(streamId)`; projeksiyonlar `{handles[], apply(event)}` arayüzünü uygular, `ProjectionRunner.catchUp(projection)` ile senkronize edilir.
- **`packages/memory` HENÜZ YOK.** PLAN.md §2.2 monorepo haritası onu adlandırıyor ("F: Memory Passport") ama repoda karşılığı yok. `packages/context-fabric` da aynı şekilde yok — F2-T1 bunun yerine doğrudan `apps/server/src/context/` altında kuruldu, PLAN.md'nin paket haritasından tartışılmamış bir sapma. F2-T5 bu sapmayı tekrar mı edecek, yoksa haritaya mı dönecek, Açık Soru 1'de insana sorulmalı.
- **En yakın CRUD/self-service emsali — `DesktopSignalConsentsService`** (F2-T3/ADR-0020): `streamId` deterministik olarak `(workspaceId, userId, signalType)` üçlüsünden türetilir; `grant`/`revoke` metotları ortak `record()` içinde yeni olayı `append` eder, `projectionRunner.catchUp()` çağırır, sonra satırı geri okur (okunamazsa `UnexpectedQueryResultError`). Controller `SessionAuthGuard` + `WorkspaceMembershipGuard` kullanır, kimlik her zaman `req.user.id`'den türetilir (gövdeden asla güvenilmez).
- **En yakın "silme = event" emsali — `core-objects`'in `softDeleteObject`** (`packages/core-objects/src/commands.ts`, ADR-0003): yalnızca `active|archived → deleted` durum geçişine izin verir, `ObjectSoftDeleted` olayı yayınlar — bu, satır düzeyinde ayrı bir tombstone kolonu/tablosu DEĞİL, durum makinesindeki bir `'deleted'` enum değeri. `purgeObject()` kasıtlı olarak uygulanmamış bir arayüz taslağı (ADR-0003).
- **Repoda gerçek bir "tombstone" (fiziksel satır kalır ama projeksiyon onu asla döndürmez) deseni YOK.** `tombstone`/`deletedAt`/`softDelete` için grep sıfır gerçek sonuç veriyor (yalnızca PLAN.md/CLAUDE.md metninde geçiyor). F2-T5, repodaki İLK gerçek tombstone-yayılım mekanizmasını kuracak.
- **PLAN.md'nin Memory Passport teknik notu** (satır 310): "Bellek = birinci sınıf, kullanıcı-sahipli tablo; her satırda `kaynak_olay_id`. Silme = olayla yayılan tombstone (ajan önbellekleri dahil temizlenir)." — bu görev bu notun ilk somut uygulaması.
- **Ajan önbellekleri henüz yok.** Agent Runtime (F3-E1, F3-T1) Faz 3'e ait ve repoda hiç kurulmadı. "Ajan önbellekleri dahil temizlenir" gereksinimi bu görevde bir TÜKETİCİ olmadan, yalnızca event yayınlayarak karşılanabilir — gerçek önbellek temizleme mantığı F3-T1'den sonra ayrı bir görev/entegrasyon (F2-T4'ün Açık Soru 5'inde aynı "tüketicisiz altyapı" durumuyla karşılaşılmıştı).
- **`Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz`** (Mimari Değişmez). F1-T18 (`ExportService`/`ExportController`, ADR-0016) zaten çalışıyor durumda; bellek kayıtları eklendiğinde bu mevcut export akışından HARİÇ TUTULAMAZ — tam JSON-LD şema/sihirbaz tasarımı F2-T7'nin kapsamı olsa da, bu görev bellek verisini F1-T18'in genel JSON export'undan bilerek dışlamamalı (Kapsam'da açıkça not edilir).

## Kapsam

1. **Bellek kaydı şeması (ADR'de sabitlenir, bkz. Açık Soru 2 ve 4):** `id`, `workspaceId`, `userId` (sahibi), `content` (metin), `kaynak_olay_id` (kaydı yaratan olayın kendi id'si — bu görevde her zaman dolu, otomatik-çıkarım senaryosu kapsam dışı), `createdAt`, `updatedAt`.
2. **Event tipleri (geçmiş zaman, CLAUDE.md sözleşmesi):** `MemoryRecordAdded`, `MemoryRecordEdited`, `MemoryRecordDeleted` (tombstone). Her biri `DomainEvent` zarfına uyar, `actor: {type:'user', id: userId}`.
3. **Kullanıcı CRUD API'si (self-service):** listele/oluştur/düzenle/sil, `DesktopSignalConsentsService` deseniyle tutarlı — kimlik her zaman `req.user.id`'den, gövdeden asla; `SessionAuthGuard` + `WorkspaceMembershipGuard`.
4. **Tombstone semantiği (ADR'de sabitlenir, bkz. Açık Soru 4):** silme fiziksel `DELETE` değil, `MemoryRecordDeleted` olayı + projeksiyonun bu satırı bir daha asla döndürmemesi. Ajan önbellek temizleme, bu olayın gelecekteki bir tüketicisi olarak Kapsam Dışı'na not edilir.
5. **Paket konumu (ADR'de sabitlenir, bkz. Açık Soru 1):** `packages/memory` mi yoksa `apps/server/src/memory/` mi.
6. **Workspace/kullanıcı izolasyonu:** cross-user ve cross-workspace sızıntı yok; her sorgu hem `workspaceId` hem `userId` ile süzülür (bkz. Açık Soru 3).
7. **F1-T18 export akışına entegrasyon (mekanik, ADR gerektirmez):** bellek kayıtları mevcut `ExportService`'in JSON export'una dahil edilir — yeni bir export formatı/sihirbazı KURULMAZ (o F2-T7), yalnızca mevcut export'un veri kaynağına bellek eklenir, böylece "hiçbir planda kısıtlanamaz" değişmezi ilk günden ihlal edilmemiş olur.
8. **ADR:** `architect` subagent ile bu taslak sırasında ADR-0021 en son numaralı ADR; F2-T5'in ADR'si sıradaki boş numarayı (ADR-0022) alır — paket konumu, olay şeması, tombstone mekanizması, izolasyon kapsamı insan onayından önce yazılır.

## Kapsam DIŞI

- **F2-T6 ("Hakkımda ne biliyorsun?" ekranı + kaynak izi UI'ı)** — bu görev yalnızca API/depolama katmanını kurar, hiçbir kullanıcı arayüzü içermez.
- **F2-T7 (içe/dışa aktarım sihirbazı, açık JSON-LD şema, ChatGPT/Claude bellek içe aktarma)** — bu görev yalnızca mevcut F1-T18 export'una bellek verisini mekanik olarak ekler (Kapsam madde 7); JSON-LD şema tasarımı, içe aktarma sihirbazı ayrı görev.
- **F2-T8 (ajanın hangi bellek segmentine erişebileceğini tanımlayan erişim politikası manifestoları)** — bu görev tüm bellek kayıtlarını yalnızca SAHİBİNE (kullanıcının kendisine) açar; ajan erişim kontrolü tamamen ayrı, gelecekteki bir görev.
- **Otomatik AI/ajan tabanlı bellek çıkarımı** (bir konuşmadan veya olaydan otomatik `MemoryRecordAdded` üretimi) — bu görevde bellek kayıtları yalnızca kullanıcının ELLE oluşturduğu kayıtlardır; otomatik çıkarım ayrı bir görev/karar (muhtemelen Faz 3, Agent Runtime'a bağımlı).
- **Gerçek "ajan önbelleği" temizleme mekanizması** — Agent Runtime (F3-E1) henüz yok; bu görev yalnızca `MemoryRecordDeleted` olayını yayınlar, bir tüketici kurmaz.
- **Bellek kayıtlarının context-fabric grafiğine (F2-T1) düğüm/kenar olarak eklenmesi** — bu görev bellek deposunu context-fabric'ten bağımsız, ayrı bir projeksiyon olarak kurar; iki sistemin birleştirilmesi (varsa) ayrı bir karar.

## Açık Sorular

1. **[KRİTİK]** Bellek deposu **nerede** yaşayacak?
   - **Seçenek A (öneri):** PLAN.md'nin paket haritasına sadık kalınır — `packages/memory/` oluşturulur (saf TypeScript: şema/tip/zod validasyonu, framework import yok, CLAUDE.md'nin domain-paketi kuralına uyar), NestJS servis/controller `apps/server/src/memory/` içinde bu paketi tüketir (`core-objects`'in bugünkü ayrımıyla birebir aynı desen: paket = saf mantık, `apps/server` = HTTP/DB bağlayıcısı).
   - **Seçenek B:** F2-T1'in fiilen kurduğu emsali izle — her şey `apps/server/src/memory/` altında, ayrı bir paket açılmaz.
   - **Öneri:** A. F2-T1'in sapması tartışılmadan olmuştu; F2-T5 açıkça PLAN.md'nin haritasına dönerek gelecekteki F3-T1 (Agent Runtime, framework-bağımsız erişim ihtiyacı yüksek) için daha temiz bir temel bırakır. Ancak bu, mevcut bir emsalden BİLİNÇLİ olarak ayrılan bir karar olduğundan insan onayı gerekiyor.
2. **[KRİTİK]** `kaynak_olay_id` bu görevde ne anlama gelir? PLAN.md'nin "her satırda kaynak_olay_id" ifadesi, gelecekte otomatik çıkarımla gelecek kayıtlar için "hangi konuşma/olaydan öğrenildi"yi ima ediyor, ama bu görev yalnızca kullanıcının ELLE oluşturduğu kayıtları kapsıyor (Kapsam Dışı). **Öneri:** v1'de `kaynak_olay_id`, kaydı yaratan `MemoryRecordAdded` olayının kendi `id`'sine eşittir (kendine-referans) — alan şimdiden şemada var, gelecekte otomatik çıkarım geldiğinde asıl kaynak olayı gösterecek şekilde YENİDEN YORUMLANIR (şema değişmez, semantik genişler). İnsan onayı gerekiyor.
3. Görünürlük kapsamı **workspace + user** ikilisiyle mi sınırlı (mevcut `desktop-signal-consents`/`core-objects` deseniyle tutarlı), yoksa PLAN.md'nin "kullanıcı başına" ifadesi kullanıcının TÜM workspace'lerinde ortak/global bir bellek mi kastediyor? **Öneri:** workspace + user ikilisi (mevcut izolasyon deseniyle tutarlı, cross-workspace sızıntı riski taşımaz) — ama bu "kullanıcı başına" ifadesinin gerçek niyetine dair bir yorum farkı olduğundan insan onayı gerekiyor.
4. **[KRİTİK]** Tombstone **fiziksel olarak** nasıl temsil edilir? **Seçenek A (öneri):** satır DB'de kalır (projeksiyon tablosunda), ama bir `deleted` durumu/ayrı bir "tombstone projeksiyonu" onu okuma sorgularından tamamen filtreler — `core-objects`'in lifecycle-durumu deseniyle tutarlı. **Seçenek B:** silme anında projeksiyon satırı fiziksel olarak `DELETE` eder (yalnızca event log'da iz kalır). Öneri A, çünkü "ajan önbellekleri dahil temizlenir" gereksinimi ileride tombstone event'ini TÜKETECEK bir mekanizma varsayıyor — B'de projeksiyon satırı yok olduğundan gelecekteki bir tüketici için event log dışında hiçbir sorgulanabilir iz kalmaz. İnsan onayı gerekiyor.
5. Düzenleme (edit) semantiği: `MemoryRecordEdited` olayı `content` alanının TAMAMINI mi değiştirir (en basit, öneri) yoksa alan-bazlı bir patch şeması mı taşır? Bu görevde tek bir `content` alanı olduğundan pratik fark küçük, ama olay payload şekli ADR'de sabitlenmeli.

## Kabul Kriterleri

- [x] Açık Soru 1-5'in insan kararları ADR-0022'de kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu.
- [x] `MemoryRecordAdded`/`MemoryRecordEdited`/`MemoryRecordDeleted` olayları `DomainEvent` zarfına uyuyor, testli (`packages/memory`, 28/28 test).
- [x] Bellek kaydı CRUD API'si (`list`/`create`/`edit`/`delete`) yalnızca kaydın SAHİBİ tarafından erişilebilir — başka bir kullanıcının veya workspace'in bellek kaydına erişim/düzenleme/silme denendiğinde reddedildiği testli (`apps/server/src/memory`, 15/15 entegrasyon testi).
- [x] Silme (`MemoryRecordDeleted`) sonrası kayıt hiçbir okuma yolunda (`list`/`get`) bir daha görünmüyor — tombstone semantiği testli.
- [x] `kaynak_olay_id` her kayıtta dolu ve ADR-0022'nin kararına uygun şekilde dolduruluyor, testli.
- [x] Bellek kayıtları F1-T18'in mevcut JSON export akışına dahil edildi — export'tan hariç tutulmadığı testli (Mimari Değişmez: "veri dışa aktarma kısıtlanamaz"; 37/37 export entegrasyon testi).
- [x] Cross-workspace ve cross-user izolasyon security-reviewer tarafından denetlendi (bulgu yok).
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil (tüm 3 alt-PR için ayrı ayrı doğrulandı).

---

**Sıradaki adım:** F2-T5 kapandı, F2-E2'nin bir sonraki görevi F2-T6 ("Hakkımda ne biliyorsun?" ekranı + kaynak izi, `docs/PLAN.md` satır 249). F2-T6'nın henüz bir spec dosyası yok — F2-T5'te izlenen ritüelin aynısıyla önce spec yazılmalı:

```
docs/specs/F2-E2/F2-T6-hakkimda-ne-biliyorsun.md spec dosyasını yaz, sonra Plan Mode ile F2-T6'yı planla.
```
