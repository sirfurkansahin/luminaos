# ADR-0011: Doküman Editörü — CRDT↔Olay-Günlüğü Köprüsü ve Blok Şeması

**Durum:** Kabul edildi
**Tarih:** 2026-08-05
**İlgili görev:** [F1-T11 — Doküman Editörü (Blok Tabanlı, Katlanabilir Başlıklar, CRDT İşbirliği)](../specs/F1-E3/F1-T11-dokuman-editoru.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E3: Görev + Doküman + Takvim Çekirdeği" (F1-T11 satırı) ve CLAUDE.md "Mimari Değişmezler": _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_

> Bu ADR mimari-kritiktir. F1-T11 spec'i açıkça işaretliyor: gerçek zamanlı Yjs CRDT işbirliği, her tuş vuruşunu ayrı bir olay yapmayı pratik dışı bırakıyor ve bunun yerine periyodik anlık görüntü (snapshot) önerisi CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür" değişmeziyle doğrudan gerilim yaratıyor. Bu ADR, o gerilimin nasıl çözüldüğünü koddan ÖNCE belgeler (ADR-0003/F1-T1, ADR-0010/F1-T10 emsali).

## Bağlam

F1-T11, `doc` nesne tipine (bugüne kadar `packages/core-objects/src/lumina-object.ts`'te kayıtlı bir `ObjectType` üyesi olmasının ötesinde hiçbir ayrı şekli olmayan bir tip) blok tabanlı, çoklu-kullanıcı gerçek zamanlı düzenleme kazandırıyor. İki farklı gereksinim sınıfı çakışıyor:

1. **CRDT yakınsama garantisi.** Yjs, eşzamanlı düzenlemelerin kayıpsız birleşmesi için tasarlanmış bir CRDT'dir; bunun doğal çalışma biçimi, bir `Y.Doc`'un bellekte sürekli güncellenmesi ve update'lerin bağlı istemciler arasında (WebSocket üzerinden) yayılmasıdır — saniyede onlarca/yüzlerce update üretebilir.
2. **Olay günlüğü değişmezi.** CLAUDE.md: "Tek doğruluk kaynağı olay günlüğüdür." Her Yjs update'ini ayrı bir domain olayı olarak `EventStoreService.append()`'e yazmak, hem pratik değil (olay günlüğünü CRDT'nin dahili senkron protokolüyle aynı hızda yazan bir I/O darboğazına çevirir) hem de anlamsal olarak yanlış (tek tek update'ler iş açısından anlamlı "olaylar" değil, protokol seviyesinde birleştirme parçalarıdır).

Repoda bu köprüyü kurmak için hazır hiçbir altyapı yok: `apps/server`'da WebSocket gateway'i (`@WebSocketGateway`/`socket.io`/`ws`) yok, `yjs`/`y-websocket`/`y-protocols` hiçbir paket.json'da bağımlılık değil — bu, greenfield bir gerçek-zamanlı senkron katmanı. Buna karşılık RBAC (`WorkspaceMembershipGuard`), event store (`EventStoreService.append`, optimistic-concurrency), ve projeksiyon deseni (`apps/server/src/objects/objects-view.projection.ts`'in jsonb read-modify-write deseni, F1-T10 PR6a emsali) zaten var ve yeniden kullanılacak — hiçbiri yeniden icat edilmiyor.

Çözülmesi gereken merkezi soru: CRDT'nin yüksek frekanslı, protokol-seviyesi update akışı ile olay günlüğünün "her olay iş açısından anlamlı ve dayanıklı" değişmezi arasındaki gerilim, hangi taneli-lik (granularity) seviyesinde, hangi dayanıklılık ödünüyle, hangi yazma-yetkisi disipliniyle çözülür?

## Karar

### (a) Stream modeli — doküman içeriği, nesnenin KENDİ stream'ine yazılır; yeni bir stream tipi icat edilmez

`docId`, `doc` tipindeki `LuminaObject`'in kendi iş kimliğidir (ADR-0003'ün ULID `id`'si). Snapshot ve denetim olayları, o nesnenin **zaten var olan** event stream'ine yazılır — ADR-0003'ün kurduğu `objectId (ULID) → streamId (uuid)` eşlemesi (`objects_view` projeksiyonunda tutulan) üzerinden çözülen AYNI `streamId`'ye, `EventStoreService.append(streamId, expectedVersion, newEvents)`'in mevcut iyimser-eşzamanlılık mekanizmasıyla. Bu, `ObjectCreated`/`ObjectRenamed`/`FieldValueChanged` gibi nesnenin diğer yaşam-döngüsü olaylarıyla TAM OLARAK aynı stream'dir — ayrı bir "doküman içerik stream'i" ya da yeni bir `streamType` yok.

**Not (isimlendirme netliği):** Görev tanımında "docId == objectId" ve "streamId = objectId" ifadeleri kullanılmıştı; bu ADR bilinçli olarak daha kesin bir ifadeye çeviriyor. ADR-0003 gereği `objectId` (ULID) ile `streamId` (rastgele UUID) HİÇBİR ZAMAN birebir aynı değer değildir — aralarında `objects_view`'da tutulan bir arama eşlemesi vardır (ADR-0003'ün reddettiği "(B) codec ile streamId ≡ objectId" alternatifini tekrar açmamak için). Buradaki gerçek karar "docId == objectId" (doğru ve trivial: `doc` nesnesinin kendi id'si zaten `docId`'dir) ile "AYNI stream'e yaz, yeni stream tipi icat etme" (asıl mimari karar) ifadelerinin doğru okunmasıdır; "streamId = objectId" satırı bu ADR'nin resmi kaydında YOKTUR, yerine "nesnenin zaten çözülmüş `streamId`'sine yaz" geçer.

### (b) Yazma yetkisi — yalnızca SUNUCU yazar; istemci asla doğrudan olay üretmez

Snapshot ve denetim olaylarını yalnızca SUNUCU tarafı üretir — spesifik olarak, WebSocket gateway'in (`DocCollabGateway`) bir doküman "odası" için bellekte tuttuğu yetkili `Y.Doc`. Hiçbir istemci `DocumentContentSnapshotted`/`DocumentEdited` olayını doğrudan event store'a yazamaz; istemciler yalnızca Yjs update'lerini ve awareness verisini WS üzerinden gateway'e gönderir, gateway bunları yetkili `Y.Doc`'a uygular ve debounce penceresi dolduğunda KENDİSİ snapshot'ı yazar.

Bu, ADR-0006/F1-T10'un ilişki-yarışı desenlerinin çözdüğü "kimin ne zaman yazdığı" sınıfı sorunu baştan önler: birden fazla istemci aynı dokümana eşzamanlı bağlıyken, event store'a yazan TEK bir yazıcı (o odanın sunucu-taraflı gateway örneği) olduğu için stream üzerinde çapraz-istemci yarış YOKTUR — CRDT'nin kendi birleştirme garantisi zaten eşzamanlı düzenlemeleri bellek içinde tutarlı hale getiriyor, event store'a giden yazım bu zaten-birleşmiş durumun periyodik bir fotoğrafı.

**Kabul edilen sınırlama — çoklu-örnek (horizontal scaling) kapsam DIŞI.** Bu tasarım, bir doküman odasının HER ZAMAN tek bir sunucu sürecinde barındırıldığını varsayar. Birden fazla sunucu süreci aynı `docId` için ayrı bellek-içi `Y.Doc` kopyaları tutarsa (yatay ölçekleme), her kopya kendi bağımsız yazıcısı olur ve bu ADR'nin "tek yazıcı" garantisi bozulur. F1-T11 bunu ÇÖZMÜYOR — bilinen bir sınırlama olarak kayda geçiriliyor (ör. sticky-session yönlendirmesi veya tek-örnek varsayımı bugün için yeterli kabul ediliyor); yatay ölçekleme ihtiyacı doğduğunda ayrı bir görev/ADR (muhtemelen Redis tabanlı Yjs odası paylaşımı veya benzeri bir çapraz-örnek senkron katmanı) gerekecektir.

### (c) Snapshot içeriği — TAM durum, artımlı diff değil; sınırlı-kayıp penceresi bilinçli bir ödün

Her `DocumentContentSnapshotted` olayı `Y.encodeStateAsUpdate(doc)`'un ürettiği TAM, kendi kendine yeterli durumu taşır (artımlı bir diff değil). Yeniden kurma kuralı basittir: "yalnızca EN SON snapshot'ı uygula" — snapshot'lar arası zincir/diff biriktirme yok.

Debounce penceresi **10 sn hareketsizlik VEYA art arda N update, hangisi önce gerçekleşirse** olarak tetiklenir (spec §3).

**Graceful shutdown (SIGTERM) → senkron flush, kayıp YOK.** Gateway, süreç düzgün kapatılırken (SIGTERM sinyali) çıkmadan ÖNCE tüm aktif oda `Y.Doc`'ları için senkron bir flush/snapshot yapar — debounce zamanlayıcısının dolmasını beklemez, o anki durumu hemen `document_snapshots`'a yazar. Bu, planlı yeniden başlatma/dağıtım (deploy) senaryolarının **kayıpsız** olmasını sağlar ve spec'in Kabul Kriteri #4'ünü ("sunucu yeniden başlatıldıktan sonra son snapshot'tan doküman içeriği kayıpsız yeniden kurulur") doğrudan bu davranış karşılar — Kabul #4 yalnızca graceful shutdown'ın senkron flush yapması koşuluyla doğrudur.

**Ungraceful crash (SIGKILL / güç kesintisi) → son pencere kaybolabilir, belgelenmiş ödün.** Sunucu, flush fırsatı BULAMADAN (ör. SIGKILL, OOM, donanım arızası) çökerse, son snapshot'tan bu yana geçen debounce penceresi içindeki düzenlemeler kaybolur. Bu **kasıtlı, sınırlı ve belgelenmiş bir dayanıklılık ödünüdür — "kayıpsız" değişmezinin ihlali DEĞİLDİR**: kabul kriterlerindeki "kayıpsız birleşme" garantisi CRDT'nin EŞZAMANLI düzenlemeleri doğru birleştirmesiyle ilgilidir (§ (b)'de zaten sağlanıyor), "ani çökme anında sıfır veri kaybı" ile ilgili DEĞİLDİR. İkisi farklı garanti sınıflarıdır ve bu ADR yalnızca ikincisinde, sınırlı bir pencereyle, bilinçli bir ödün kabul eder.

**PR4 entegrasyon testleri bu ikisini AYRI kanıtlar** (tek bir "restart testi"nde birleştirilMEZ): (1) _graceful restart_ — SIGTERM → süreç kapanır → yeniden kurulur; pencere içindeki son update'ler dahil hiçbir veri kaybolmaz. (2) _simüle çökme_ — flush fırsatı vermeyen ani sonlandırma (ör. `process.kill(pid, 'SIGKILL')` veya gateway'in flush handler'ını atlatan bir test kancası) → yalnızca son snapshot'a kadar olan durum kurtarılır; debounce penceresindeki son N update'in belgelenmiş biçimde kaybolduğu açıkça doğrulanır (bu bir hata değil, kabul edilen ödünün testle sabitlenmesidir).

### (d) RBAC↔WS köprüsü — `WorkspaceMembershipGuard`'ın çekirdeği yeni bir `WorkspaceMembershipService`'e çıkarılır

`WorkspaceMembershipGuard.canActivate` (`apps/server/src/workspaces/workspace-membership.guard.ts`) bugün yalnızca `context.switchToHttp().getRequest()` üzerinden çalışıyor — bir WS gateway'in bağlantı handshake'inde Nest farklı bir execution context (`switchToWs()`) kullandığı için bu guard, WS bağlamında OLDUĞU GİBİ yeniden kullanılamaz.

Karar: guard'ın çekirdek üyelik-sorgusu (`memberships` tablosuna `(workspaceId, userId)` bileşik sorgusu + "üye değil → 403" kararı) yeni, injectable bir `WorkspaceMembershipService.assertMembership(userId, workspaceId): Promise<void>` metoduna çıkarılır (üye değilse `ForbiddenError`, kullanıcı yoksa `UnauthorizedError` fırlatır — guard'ın bugünkü hata sınıflandırması BİREBİR korunur). Mevcut `WorkspaceMembershipGuard` bu yeni servise delege eden ince bir sarmalayıcıya indirgenir; **guard'ın kendi gözlemlenebilir davranışı/testleri DEĞİŞMEZ** (aynı `canActivate` sözleşimi, aynı hata tipleri, aynı `request.membership` yan etkisi). Yeni `DocCollabGateway`'in bağlantı işleyicisi, herhangi bir Nest guard/HTTP bağlamı OLMADAN, aynı servisi doğrudan çağırarak bir soket odaya katılmadan önce yetkisiz yükseltme (upgrade) denemelerini reddeder.

Bu, ADR-0006/ADR-0010'un "mevcut mekanizmayı yeniden icat etme, çıkar ve paylaş" disipliniyle aynı desendir — HTTP guard'ın davranışını değiştirmeden, WS bağlamının ihtiyacı olan çağrılabilir çekirdeği ayrıştırır.

### (e) DoS sınırları — snapshot boyut tavanı ve WS mesaj hız sınırı (eşikler taslak, security-reviewer'a bağlı)

İki sınır öngörülüyor:

- **Snapshot payload boyut tavanı** — taslak: **5 MB** (kodlanmış Yjs update, base64 öncesi ham boyut). `checklist`'in 200-öğe tavanının (`CHECKLIST_ITEM_LIMIT`, `packages/core-objects/src/checklist-commands.ts`, F1-T10 PR6b emsali) aynı ruhu: append zamanında reddedilen, sabit ve test edilebilir bir üst sınır.
- **WS gelen update mesajı hız sınırı** — bağlantı başına, henüz sayısallaştırılmamış bir üst sınır (ör. saniyede N mesaj).

Bu iki eşik de **taslak/geçici**; kesin sayılar, uygulama PR'ının `security-reviewer` denetiminde gerçek tehdit modeline (ör. ortalama doküman boyutu, tipik oturum sıklığı) göre kesinleştirilecek — burada NİHAİ olarak sunulmuyor, yalnızca "bir sınır olacak ve şu civarda başlanacak" kaydı bırakılıyor.

### (f) Kalıcılık şeması — `objects_view` jsonb'sine EKLENMEZ; ayrı `document_snapshots` tablosu

Snapshot'lar `objects_view`'ın (`apps/server/src/objects/objects-view.projection.ts`'in bugün `checklist`/`recurrenceRule` için kullandığı) jsonb kolonlarına EKLENMEZ: bu tablo her nesne listeleme/sorgulama çağrısında yüklenir; büyük bir ikili blob'u oraya koymak HER liste yanıtını şişirirdi (bir dokümanın snapshot'ı yalnızca o doküman AÇILDIĞINDA gerekli, listede değil).

Bunun yerine ayrı, amaca özel bir tablo tanımlanır: **`document_snapshots`** — `objectId` (ULID, FK), `version` (stream-içi pozisyon, `DomainEvent.version`'la hizalı), `snapshot` (`bytea`), `createdAt`. Bu tablo, kendi migration'ıyla (CLAUDE.md gereği down script'i dahil) F1-T11'in uygulama PR'ında kurulur; okuma yolu ("son snapshot'ı getir") `objectId` + `MAX(version)` ile tek satır sorgusu olur, `objects_view`'ın liste sorgularına hiçbir maliyet eklemez.

## Blok şeması (`packages/core-objects/src/doc/`) — saf tipler, framework bağı yok

Spec §1 gereği, `checklist`/`recurrence-rule`'un kendi dosyalarına ayrılması emsaliyle (`packages/core-objects` bugün düz bir yapı: `commands.ts`, `replay.ts`, `fields/`, `relations/`, `saved-views/`), yeni bir `doc/` alt dizini eklenir:

```
interface InlineRichText { /* metin parçası + biçim işaretleri; bu ADR'nin
  kapsamı dışında ayrıntılandırılacak, implementer PR'ında somutlaşır */ }

interface Block {
  id: string;               // ULID
  type: 'paragraph' | 'heading1' | 'heading2' | 'heading3'
      | 'bulletList' | 'numberedList' | 'todo' | 'code' | 'quote' | 'divider';
  content: InlineRichText[];
  children: Block[];
}
```

Değişmez: `divider` tipi bloklar `children` taşıyamaz (mantıksal olarak `content` da taşımaz — yalnızca bir ayraçtır). Bu, `packages/core-objects/src/doc/` içinde saf bir doğrulayıcı fonksiyonla zorunlu kılınır (ör. `validateBlock(block): void`, ihlalde `packages/shared/errors`'tan bir hata fırlatır) — CLAUDE.md'nin "domain paketleri framework import edemez" kuralı gereği bu pakette HİÇBİR Yjs/React bağı yoktur; `Y.XmlFragment`'a çeviri `apps/server/src/docs`'ta (framework'e bağlı katman) yaşar.

## Olay tipleri

- **`DocumentContentSnapshotted { docId, snapshot: base64(Yjs update), version }`** — sunucu-taraflı gateway tarafından, debounce penceresi tetiklendiğinde üretilir; `snapshot` TAM durumdur (bkz. Karar (c)).
- **`DocumentEdited { docId, actorId, at }`** — hafif denetim olayı; içerik taşımaz, oturum başına BİR KEZ üretilir (kimin ne zaman düzenlediğinin izlenebilirliği için). `packages/core-objects/src/replay.ts`'in `switch (event.type)`'ına eklenmesi gerekir (repodaki de-facto yetkili olay-tipi listesi); her iki tip de replay'de no-op/geçersiz-durum üretmeyecek şekilde ele alınmalı (spec'in kapsamı yalnızca kalıcılık/yeniden kurma davranışını, `LuminaObject`'in çekirdek alanlarını DEĞİŞTİRMEZ).

## Katlanabilir başlık durumu — paylaşılan CRDT belgesinin PARÇASI DEĞİL

`heading1/2/3` bloklarının açık/kapalı (collapsed/expanded) durumu **istemci-yerel UI durumudur** — ne paylaşılan `Y.Doc`'a (dolayısıyla ne başka istemcilere WS üzerinden yayılır) ne de olay günlüğüne yazılır. Bu, spec'in açık kabul kriteriyle birebir örtüşür: bir istemcinin kapattığı başlık, aynı dokümanı görüntüleyen başka bir istemcinin ekranında YANSIMAMALIDIR. Uygulamada bu, `apps/web`'in kendi bileşen state'inde (ör. React state/local storage) tutulur — `packages/core-objects/src/doc/`'un `Block` tipine hiçbir "collapsed" alanı EKLENMEZ (eklenirse yanlışlıkla CRDT/olay serileştirmesine sızma riski doğar).

### Değerlendirilip reddedilen alternatifler

- **Her Yjs update'ini ayrı bir domain olayı yapmak.** Reddedildi — spec'in kendi gerekçesi: pratik değil (I/O darboğazı) ve anlamsal olarak yanlış (update'ler iş-anlamlı olaylar değil, protokol parçaları).
- **Yeni bir "doküman içerik stream'i" (ayrı `streamType`/ayrı `streamId`) icat etmek.** Reddedildi — ADR-0003'ün `objectId → streamId` eşlemesi zaten her nesne için TEK bir stream öngörüyor; ikinci bir stream türü, "bir nesne = bir stream" modelini kırar ve iki stream arasında (nesnenin çekirdek yaşam-döngüsü olayları ile doküman içeriği arasında) hiçbir zorunlu sıralama garantisi olmadan gereksiz karmaşıklık ekler.
- **İstemcinin doğrudan event store'a snapshot yazması.** Reddedildi — çoklu-istemci senaryosunda çapraz-istemci yazıcı yarışı doğurur; tek yetkili yazıcı (sunucu-taraflı gateway) bu sınıf sorunu tasarım gereği ortadan kaldırır.
- **Artımlı diff snapshot zinciri (yalnızca son snapshot'tan bu yana değişen kısmı yazmak).** Reddedildi — yeniden kurma mantığını ("en son N snapshot'ı sırayla uygula") karmaşıklaştırır ve zincirde bir ara snapshot bozulursa/kaybolursa tüm sonraki zinciri geçersiz kılma riski taşır; TAM durumun tekrar tekrar yazılmasının disk maliyeti, doğruluğunu ve yeniden-kurma basitliğini kaybetmeye değecek kadar yüksek değerlendirilmedi.
- **Snapshot'ları `objects_view` jsonb'sine gömmek.** Reddedildi — her liste/sorgu çağrısını büyük ikili blob'la şişirir; ayrı tablo, okuma yolunu yalnızca doküman gerçekten açıldığında tetikler.
- **Collapsed/expanded başlık durumunu CRDT'ye (awareness verisi olarak dahi) yazmak.** Reddedildi — spec'in açık kabul kriteri bunu YASAKLIYOR; awareness verisi bile "geçici ama paylaşılan" bir kanaldır, bu durumun tanım gereği paylaşılmaması gerekiyor.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- CRDT'nin yüksek-frekanslı update akışı ile olay günlüğü değişmezi arasındaki gerilim, yeni bir stream tipi icat edilmeden, ADR-0003'ün mevcut `objectId → streamId` eşlemesi ve `EventStoreService.append`'in iyimser-eşzamanlılık mekanizması üzerinden çözüldü.
- Tek-yazıcı (sunucu-taraflı gateway) disiplini, çapraz-istemci yazım yarışını tasarım gereği ortadan kaldırıyor — F1-T10/ADR-0010'un çapraz-stream yarış çözümlerine benzer bir kategori sorunu, burada daha basit biçimde (yarış-sonrası kontrol yerine, yarışın hiç oluşmaması) önleniyor.
- `WorkspaceMembershipGuard`'ın çekirdeği yeni bir servise çıkarılarak hem HTTP hem WS bağlamında AYNI yetkilendirme mantığı kullanılıyor — HTTP guard'ın gözlemlenebilir davranışı korunuyor, WS için ayrı/paralel bir RBAC mantığı icat edilmiyor.
- Snapshot kalıcılığı, `objects_view`'ın liste-sorgusu maliyetine dokunmadan ayrı bir tabloda (`document_snapshots`) yaşıyor.
- Blok şeması saf, framework-free bir pakette (`packages/core-objects/src/doc/`) yaşıyor — CLAUDE.md'nin domain-paketi kısıtına uyuyor ve `checklist`/`recurrence-rule` emsalini izliyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- **Çoklu-örnek yatay ölçekleme** — F1-T11'in kapsamı dışında; tek-sunucu-örneği/sticky-session varsayımı bugün için kabul edildi, gerektiğinde ayrı bir görev/ADR (muhtemelen çapraz-örnek Yjs oda paylaşımı, ör. Redis tabanlı) gerekecek.
- **Sınırlı, belgelenmiş çökme-penceresi veri kaybı** — graceful shutdown (SIGTERM) senkron flush yaptığı için planlı yeniden başlatma kayıpsızdır; yalnızca flush fırsatı bulamayan ANİ çökmede (SIGKILL/OOM/güç) debounce penceresi (10 sn VEYA N update) içindeki düzenlemeler kaybolabilir. Bu "kayıpsız CRDT birleşmesi" garantisinden AYRI bir garanti sınıfıdır ve bilinçli olarak sınırlı tutuldu; PR4'ün entegrasyon testleri graceful-restart (kayıpsız) ile simüle-çökme (belgelenmiş kayıp) senaryolarını AYRI kanıtlar.
- **Kesin DoS eşikleri** (5MB snapshot tavanı, WS mesaj hız sınırı) — taslak; uygulama PR'ının `security-reviewer` denetiminde kesinleştirilecek.
- **Sürüm geçmişi UI'ı ve çevrimdışı-öncelikli senkron** — spec'in kendi "Kapsam Dışı" bölümünde zaten net: snapshot geçmişi bu görevde saklanır ama gösterilmez; çevrimdışı SQLite+Yjs entegrasyonu Faz 2/3'e ertelendi.
