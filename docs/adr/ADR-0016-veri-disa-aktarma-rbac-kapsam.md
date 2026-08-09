# ADR-0016: Veri Dışa Aktarma — RBAC Sınırı (Salt Üyelik), Projeksiyon-Tabanlı JSON, Yjs→Markdown Doğrudan Köprüsü, Native iCal Kapsamı

**Durum:** Kabul edildi
**Tarih:** 2026-08-10
**İlgili görev:** [F1-T18 — Tam Veri Dışa Aktarma: JSON + Markdown + iCal](../specs/F1-E4/F1-T18-veri-disa-aktarma.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E4: AI Servisi v1 + Veri Çıkışı" (F1-T18 satırı, satır 231) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin **HER İKİ** fıkrası da bu kararı tetikliyor: (1) karar "Mimari Değişmezler"den birine **doğrudan dokunuyor** — _"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."_; (2) karar birden fazla pakete ve gelecekteki görevlere dayatılan bir sözleşim tanımlıyor — RBAC sınırı, Faz 2+ Context Fabric/Memory Passport export'ları dahil, henüz var olmayan tüm gelecekteki okuma/export uç noktalarını bağlayacak.

> Bu ADR, o değişmezi kod tabanında **ilk kez somut bir uç noktaya döken** karardır. `docs/adr/` içindeki 14 mevcut ADR'nin taranması doğruladı: hiçbiri bugüne kadar "veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" değişmezine atıfta bulunmamış — bu satır CLAUDE.md'de bir niyet beyanı olarak duruyordu, hiçbir kararla test edilmemişti. Aynı zamanda spec'in kendisi (`F1-T18`, "Açık Sorular") RBAC sınırının nerede çizileceğini AÇIKÇA çözülmemiş bırakıyor: workspace üyeliği yeterli mi, yoksa değişmez başka türlü mü yorumlanmalı? Bu ADR o soruyu kapatıyor ve kapanışı, bu görevin ötesine geçen bir kural olarak kayda geçiriyor — F1-T18'den SONRA gelecek her export/okuma-şekilli uç nokta (Faz 2+ Context Fabric, Memory Passport export'ları dahil) bu kuralla bağlı olacak. Ayrıca, spec'in kendi "Mevcut Durum" bölümünün yanlış varsaydığı bir teknik gerçeği (Markdown export'un `Block[]`/`blocksToMarkdown` üzerinden kurulacağı varsayımı) düzeltiyor — bu düzeltme koddan ÖNCE, ayrı bir insan onayı gerektirdi (CLAUDE.md Çalışma Ritüeli madde 2'nin istisnası: mimari karar/spec'ten sapma).

## Bağlam

F1-T18, PLAN.md'nin "tam veri dışa aktarma (JSON + Markdown + iCal) — ilk sürümden itibaren" ifadesini somutlaştırıyor. Spec üç açık mimari soru bırakıyor: (1) JSON export'un veri kaynağı — projeksiyon mu, event-replay mi; (2) RBAC'ın export ile kesişimi — CLAUDE.md'nin kısıtlama-yasağı ile F0-T5'in workspace-üyeliği RBAC'ı nasıl bir arada durur; (3) Markdown export'un doküman içeriğini nereden okuyacağı.

Keşif üç bulguyu doğruladı:

1. **RBAC emsali yalnızca mutasyon eylemlerinde rol-gate uyguluyor, okuma eylemlerinde değil.** `apps/server/src/fields/fields.controller.ts`'in `requireAdmin` (satır 162, `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)`'a ek olarak inline çağrılıyor, satır 56/103/126) — şema mutasyonu (field-definition oluşturma/güncelleme/silme) için. `apps/server/src/saved-views/saved-views.service.ts` (satır 79) `shared: true` (workspace-geneli görünüm) oluşturmayı admin ile sınırlıyor. Her iki gate de **idari mutasyon** eylemleri üzerinde — ne biri ne diğeri bir OKUMA yolunu kısıtlamıyor. `ObjectsController` (`apps/server/src/objects/objects.controller.ts`, satır 53, 80, 116) gibi tüm okuma uç noktaları yalnızca `SessionAuthGuard`+`WorkspaceMembershipGuard` taşıyor, ek rol kontrolü YOK.
2. **JSON export'un doğal kaynağı zaten var, tekrar icat gerekmiyor.** `ObjectsService.list` (satır 436) ve `getActiveFieldDefinitionsGroupedByType` (satır 1439, private) `objects_view`+`field_definitions` üzerinden okuyor; `RelationsService.getRelated` `relations_view` üzerinden okuyor. `EventStoreService.readByWorkspace` (`apps/server/src/event-store/event-store.service.ts`) de var ama bugüne kadar hiçbir OKUMA UÇ NOKTASI event-replay üzerine kurulmamış — yalnızca projeksiyon rebuild/test/persistence senaryolarında kullanılıyor.
3. **Spec'in Markdown-export varsayımı yanlış temellendirilmiş.** Spec (satır 22) `blocksToMarkdown`'ın `blocksToPlainText`'in (`packages/core-objects/src/doc/blocks-to-plain-text.ts`) `Block[]`/`InlineRichText` şeması (ADR-0011'in tasarladığı, `packages/core-objects/src/doc/block.ts`) üzerinde bir kardeş fonksiyon olacağını varsayıyor. Doğrudan doğrulama bu boru hattının **hiç doldurulmadığını** ortaya çıkardı: gerçek işbirlikli editör (BlockNote, `apps/web/src/views/doc/DocEditor.tsx`) içeriği BlockNote'un kendi dahili etiket şemasıyla bir `Y.XmlFragment` (`'document-store'` anahtarıyla) olarak saklıyor; kod tabanında hiçbir yer bu Yjs yapısını `Block[]`'a çevirmiyor. `DocumentReconstructionService.getLatestSnapshot` ham bir `Buffer` döndürüyor, asla `Block[]` değil. Gerçek Yjs yapısını yürüyen TEK kanıtlanmış emsal `apps/server/src/docs/yjs-plain-text.ts`'in `extractPlainTextFromYjsUpdate`'i (F1-T13'ün arama indeksleme ihtiyacı için yazıldı) — `Y.XmlFragment`/`Y.XmlElement`/`Y.XmlText` ağacını doğrudan, `Block[]`'a hiç dokunmadan yürüyor (iteratif, açık yığın tabanlı).

Çözülmesi gereken merkezi sorular: (1) export uç noktasına hangi RBAC sınırı uygulanır ve bu sınır gelecekteki export/okuma özelliklerini nasıl bağlar; (2) JSON export'un veri kaynağı projeksiyon mu event-replay mi; (3) Markdown export gerçekte hangi veri yapısından üretilir; (4) iCal export'un native/dış-cache kapsamı ne olur; (5) tek uç nokta mı, workspace-geneli/nesne-bazlı ayrı uç noktalar mı.

## Karar

### (a) RBAC sınırı — salt workspace üyeliği, HİÇBİR rol-gate yok

Export erişimi yalnızca mevcut `SessionAuthGuard`+`WorkspaceMembershipGuard` (yeni bir guard İCAT EDİLMİYOR) gerektirir. Hiçbir formatta, hiçbir koşulda `requireAdmin`-tarzı bir rol kontrolü export uç noktasına uygulanmaz.

**Gerekçe:** `fields.controller.ts`'in `requireAdmin`'i ve `saved-views.service.ts`'in admin-gated `shared: true`'su (her ikisi de `docs/adr/ADR-0005-custom-fields-motoru.md`'de belgeli, bilinçli rol-gate'ler) **idari MUTASYON** eylemleri üzerine kurulu — şema değiştirme, workspace-geneli görünüm oluşturma. Export bir **OKUMA** eylemidir, çağıranın ZATEN erişimi olan veri üzerinde. CLAUDE.md'nin değişmezi bu okumayı daha fazla kısıtlamayı YASAKLIYOR — workspace üyeliği (F0-T5'in zaten var olan yetki sınırı) export için yeterli ve tek koşuldur; bu bir "kısıtlama" değil, var olan yetki sınırının doğal sonucu (spec satır 25'in kendi ayrımı).

**Bağlayıcılık — açıkça kayda geçirilir:** bu, F1-T18'in ötesine geçen bir kural belirliyor. Faz 2+'nin export/okuma-şekilli tüm gelecekteki uç noktaları (Context Fabric, Memory Passport export'ları dahil) çağıranın ZATEN erişimi olan veriyi okuyorsa, bu kuralla bağlıdır: gelecekteki bir implementer, kod tabanında `requireAdmin` deseni MUTASYON'lar için var diye export/okuma yoluna sırf o desen "elde var" olduğu için `requireAdmin` EKLEMEMELİDİR. Rol-gate yalnızca idari mutasyon eylemleri içindir, okuma/export için değildir — bu ayrım, gelecekteki her yeni export özelliğinin kendi RBAC kararını yeniden tartışmasını gereksiz kılar.

### (b) JSON export veri kaynağı — projeksiyon-tabanlı, event-replay DEĞİL

JSON export `objects_view`+`relations_view`+`field_definitions`'tan okur — `ObjectsService.list`'in ve `getActiveFieldDefinitionsGroupedByType`'ın (`apps/server/src/objects/objects.service.ts`) zaten kurduğu sorgu deseni, `RelationsService.getRelated`'ın (`apps/server/src/relations/relations.service.ts`) zaten kurduğu ilişki-okuma deseni AYNEN kullanılır — uygulamadaki HER DİĞER okuma yolunun zaten dayandığı AYNI projeksiyonlar. Event-replay (`EventStoreService.readByWorkspace`) BİLİNÇLİ OLARAK KULLANILMIYOR: hiçbir kabul kriteri tarihçe/audit-trail talep etmiyor — yalnızca "tüm nesne tipleri, fieldValues/checklist/recurrenceRule/ilişkiler kapsansın" isteniyor, bunların hepsi projeksiyonda zaten an-itibariyle mevcut.

**Bu, CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür" değişmeziyle GERİLİM YARATMAZ:** projeksiyonlar, o değişmezin KENDİ açıkça yetkilendirdiği türetilmiş görünümlerdir ("bağlam grafiği ve tüm projeksiyonlar türetilir") — event log'un yerine geçen paralel bir kaynak değil, ondan türetilen tek okunan yüzey. Uygulamadaki her diğer okuma yolu (`ObjectsService.list`, `RelationsService.getRelated`, `saved-views`, `search`) zaten bu projeksiyonlara dayanıyor; export'ta da aynı projeksiyonları kullanmak yeni bir emsal İCAT ETMİYOR, var olan disiplini tutarlı biçimde sürdürüyor.

### (c) Tek uç nokta, opsiyonel `objectId` daraltması

`GET /workspaces/:workspaceId/export?format=json|markdown|ical&objectId=<opsiyonel>` — TEK uç nokta, spec'in "workspace-geneli mi nesne-bazlı mı" açık sorusunu ucuz biçimde çözer: `objectId` VERİLMEZSE workspace'in tamamı export edilir, VERİLİRSE tek bir nesneye daraltılır. Bu davranış her üç formatta AYNI şekilde uygulanır. İki ayrı uç nokta (workspace-geneli + nesne-bazlı) RBAC/sorgu mantığını gereksiz yere ikiye katlardı — tek uç nokta, tek RBAC kontrolü, tek sorgu deseni parametrize edilir.

### (d) Markdown export — yalnızca `doc` tipi, Yjs→Markdown DOĞRUDAN köprüsü (`Block[]` boru hattı BYPASS edilir)

Bu görevin en önemli düzeltmesi: spec'in kendi varsaydığı `blocksToMarkdown`/`Block[]` yolu **İNŞA EDİLMEZ**. Bunun yerine yeni bir `apps/server/src/docs/yjs-to-markdown.ts` yazılır — `yjs-plain-text.ts`'in kanıtlanmış traversal desenini (`Y.XmlFragment`/`Y.XmlElement`/`Y.XmlText` ağacını iteratif, açık-yığın ile yürüyen) GENİŞLETİR: düz metin biriktirmek yerine, gerçek XML eleman etiket adlarına (BlockNote'un dahili başlık/liste/vb. etiketleri) dayanarak Markdown syntax'ı (başlıklar, listeler vb.) üretir.

Yjs→`Block[]` deserializer'ı **İNŞA EDİLMİYOR**, `blocksToMarkdown`/`Block[]` bu özellik için **KULLANILMIYOR**.

**Gerekçe (insan onaylı, iki alternatif tartılarak seçildi):** `Block[]` temeli, BlockNote'un belgelenmemiş dahili etiket şemasına karşı DOĞRULANMAMIŞ — daha yüksek riskli, daha büyük bir PR (reverse-engineering + yeni deserializer + yeni test yüzeyi) gerektirirdi. `yjs-plain-text.ts`'in traversal'ı ise GERÇEK veriye karşı ZATEN kanıtlanmış (F1-T13'ün arama indekslemesinde üretimde çalışıyor) — aynı kabul kriterlerine daha küçük, daha düşük riskli bir yolla ulaşır.

**Açıkça kayda geçirilir — ölü boru hattı bulgusu:** `Block[]`/`blocksToPlainText`/`validateBlock` (`packages/core-objects/src/doc/block.ts`, `blocks-to-plain-text.ts`) artık kod tabanında iki özelliğin de (arama indeksleme VE Markdown export — bu şemayı tüketebilecek TEK iki aday) KULLANMADIĞI, tasarlanmış-ama-ölü bir boru hattı olarak DOĞRULANMIŞ durumda. Bu ADR onu SİLMİYOR — F1-T18 kapsamı dışı — ama gelecekteki bir temizlik adayı olarak İŞARETLİYOR: gelecekteki bir görev, ya ADR-0011'in vaat ettiği Yjs→`Block[]` köprüsünü nihayet kurmaya (ve mevcut iki tüketiciyi ona geçirmeye) ya da `Block[]` şemasını ve testlerini biçimsel olarak kaldırmaya karar vermeli.

**Kapsam:** yalnızca `doc` tipi nesneler. `task`'ın checklist/custom-field verisi zaten JSON export yolunda tam kapsanıyor; v1'de `task` için Markdown export YOK.

### (e) iCal export — yalnızca native `timeblock` nesneleri, dış takvim cache'i HARİÇ

Yalnızca `objects_view`'dan `type = 'timeblock'` olan `LuminaObject`'ler (gömülü `timeBlock: { start, end }` alanlarıyla) `VEVENT` olarak export edilir. Cache'lenmiş dış (Google/Outlook) takvim etkinlikleri — tamamen ayrı `calendar_events_cache` tablosunda tutulan (`apps/server/src/db/schema/calendar-events-cache.ts`) — HARİÇ TUTULUR.

**Gerekçe:** `docs/adr/ADR-0012-takvim-senkron.md` §(a)'nın read-through-cache tasarımını doğrudan miras alır — dış etkinlikler ASLA event-sourced değildir, ASLA `LuminaObject` değildir, yapısal olarak `objects_view`'da HİÇ görünmez. Dışlama bu yüzden bir FİLTRELEME MANTIĞI gerektirmez — inşa-gereği-dışlama'dır (exclusion-by-construction). Ayrıca dışlama gerekçesi salt mekanik değil: cache'lenmiş kopyaları "LuminaOS'in veri dışa aktarımı" olarak export etmek, ÜÇÜNCÜ-TARAF-SAHİPLİ verinin kaynağını (provenance) yanlış temsil ederdi — export'un anlamı LuminaOS'in kendi doğruluk kaynağı olduğu veridir, yabancı bir kaynağın izdüşümü değil.

### (f) PDF export — kapsam DIŞI

PLAN.md'nin lafzı (satır 231) yalnızca JSON+Markdown+iCal listeliyor. F1-T11'in spec notundaki PDF anması (`docs/specs/F1-E3/F1-T11-dokuman-editoru.md`) ileriye-dönük bir gözlemdi, bu görev için bir taahhüt DEĞİL. PDF, olası bir gelecek göreve ertelenir.

## Alt-PR ayrıştırması

ADR onayından SONRA, üç alt-PR öngörülüyor (tek plan onayı hepsini kapsar, CLAUDE.md Çalışma Ritüeli madde 2):

- **PR1 — JSON export.** `apps/server/src/export/`'ta `ExportService`/`ExportController`; `GET /workspaces/:workspaceId/export?format=json[&objectId=]`; `ObjectsService.list`/`RelationsService` projeksiyon-sorgu desenlerinin yeniden kullanımı (§b); uygulama genelinde her yerde kullanılan `lifecycle != 'deleted'` temel predikatının miras alınması. RBAC = yalnızca üyelik (§a). Bu PR'da `doc` tipi nesneler yalnızca metadata olarak görünür (gövde PR2'de eklenir).
- **PR2 — Markdown export.** Yeni `yjs-to-markdown.ts` (§d), `format=markdown&objectId=` ile bağlanır (yalnızca doc), ayrıca PR1'in JSON export'unu `doc` tipi nesneler için `content: { format: 'markdown', text }` alanıyla zenginleştirir.
- **PR3 — iCal export.** Elle yazılmış, minimal RFC5545 `VEVENT` üretici (yeni bir çalışma-zamanı bağımlılığı YOK — spec'in kabul kriterleri yalnızca start/end/title/UID alanlarını gerektiriyor; tekrarlayan örnekler F1-T10 tarafından zaten ayrı `LuminaObject`'lere açıldığı için recurrence-rule/timezone kütüphanesi karmaşıklığı gerekmiyor, UTC `Z`-son-ekli zaman damgaları yeterli). `format=ical`, yalnızca native `timeblock` (§e). `UID`, `objectId`'den DETERMİNİSTİK türetilir (tekrarlanan export'lar arasında sabit — takvim istemcisinin idempotent güncellemesi için). `SUMMARY` (başlık) alanı RFC5545 TEXT kaçışına (virgül/noktalı virgül/ters eğik çizgi/satır sonu) tabidir. Yalnızca-test devDependency bir iCal parser'ı (ör. `ical.js`) üretilen çıktıyı gerçek bir parser'a karşı doğrular — kaçış ve UID-sabitliği durumları dahil.

## Alternatifler ve Reddedilme Gerekçeleri

- **Event-replay tabanlı JSON export (tam fidelity/tarihçe).** Reddedildi (v1 için) — hiçbir kabul kriteri talep etmiyor, anlamlı ölçüde daha pahalı, uygulamada event-replay üzerine kurulu HİÇBİR mevcut okuma yolu emsali yok. İleride opsiyonel bir "tam tarihçe" export modu olarak yeniden ele alınabilir.
- **Workspace-geneli ve nesne-bazlı ayrı uç noktalar.** Reddedildi — tek uç nokta + opsiyonel `objectId`, gerçek bir kazanç olmadan RBAC/sorgu mantığını iki uç noktaya çoğaltmaktan kaçınıyor.
- **Export'u rol-bazlı kısıtlamak (ör. "yalnızca admin export edebilir").** Reddedildi — CLAUDE.md'nin değişmezi tarafından DOĞRUDAN yasaklanıyor; ayrıca kod tabanında bir OKUMA-kısıtlama deseni olarak hiçbir emsali yok (rol-gate'ler yalnızca idari mutasyonlar için var).
- **Yjs→`Block[]` deserializer'ını şimdi kurup ADR-0011'in tasarladığı boru hattını nihayet aktive etmek.** Bu görev için reddedildi — BlockNote'un belgelenmemiş dahili etiket/attribute şemasını reverse-engineer etmeyi gerektiren daha büyük, daha riskli bir PR; hâlihazırda kanıtlanmış `yjs-plain-text.ts` traversal'ının genişletilmesi aynı kabul kriterlerine daha küçük, daha düşük riskli bir yolla ulaşıyor. Gelecekte bir seçenek olarak işaretli bırakıldı, tamamen reddedilmedi.
- **Dış takvim cache etkinliklerini iCal export'a dahil etmek ("takvimimdeki her şeyi export et").** Reddedildi — bu etkinlikler üçüncü-taraf-sahipli veri kopyaları, LuminaOS'in kendi verisi değil; onları yeniden export etmek veri kaynağını (provenance) yanlış temsil eder ve "veri dışa aktarma"nın LuminaOS'in doğruluk kaynağı olduğu veriye uygulanma amacına uymaz.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- "Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" değişmezi ilk kez somut, test edilebilir bir implementasyona kavuşuyor.
- Gelecekteki export/okuma özelliklerinin (Faz 2+ Context Fabric/Memory Passport export'ları dahil) uymak zorunda olduğu, belgeli bir kural: rol-gate yalnızca idari mutasyon için, okuma/export için asla.
- Yeni bir sorgu motoru icat edilmeden, Faz 1'in tüm nesne tiplerinin JSON/Markdown/iCal kapsamı tamamlanıyor — mevcut projeksiyonlar ve `yjs-plain-text.ts`'in kanıtlanmış traversal deseni yeniden kullanılıyor.
- Spec'in kendi yanlış varsayımı (Markdown export'un `Block[]` üzerinden kurulacağı) koddan önce düzeltiliyor, daha büyük/riskli bir PR'a girmeden önce.

**Neyi erteliyoruz / kabul ediyoruz:**

- Tam olay-tarihçesi export'u yok — yalnızca an-itibariyle (current-state) projeksiyon.
- PDF export yok.
- Faz 2+ nesne tiplerinin kapsanması yok.
- `Block[]`/`blocksToPlainText` boru hattı kullanılmayan ölü kod olarak KALIYOR (işaretlendi, kaldırılmadı) — gelecekteki bir temizlik görevinin kararı.
- Markdown export `doc` tipiyle sınırlı — v1'de `task` için Markdown render'ı yok.
- Zamanlanmış/otomatik export yok — yalnızca istek-üzerine (on-demand), spec gereği.
