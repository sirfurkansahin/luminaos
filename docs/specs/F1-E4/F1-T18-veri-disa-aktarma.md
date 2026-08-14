# F1-T18 — Tam Veri Dışa Aktarma: JSON + Markdown + iCal

**Epik:** F1-E4 (AI Servisi v1 + Veri Çıkışı) · **Durum:** Tamamlandı (ADR-0016 + PR1-3, bkz. İlerleme Notu)
**Bağımlılık:** F1-T1 (nesne çekirdeği — `objects_view`), F1-T2 (Custom Fields — `fieldValues`), F1-T3 (ilişki sistemi — `relations_view`), F1-T10 (`checklist`/`recurrenceRule`), F1-T11 (doküman içeriği — `document_snapshots`, `DocumentReconstructionService`, `Block`/`InlineRichText` tipleri, `blocksToPlainText` emsali), F1-T12 (`timeblock` — `timeBlockStart`/`timeBlockEnd`), F0-T5 (RBAC), F0-T6 (event store)

## Amaç

PLAN.md (satır 231) bu görevi "tam veri dışa aktarma (JSON + Markdown + iCal) — ilk sürümden itibaren" olarak tanımlıyor. CLAUDE.md'nin "Mimari Değişmezler" listesi bunu bir kural olarak zaten önceden koymuş: **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu görev, o değişmezi ilk kez somut bir API/UI'a döken görevdir — LuminaOS'te tutulan hiçbir kullanıcı verisi, kilitli/yalnızca-uygulama-içinden-erişilebilir kalamaz; workspace'in tam durumu (nesneler, dokümanlar, zaman blokları) üç standart formatta (JSON, Markdown, iCal) dışa aktarılabilir olmalı.

## Mevcut Durum (keşif — koddan doğrulandı)

- `objects_view` (`apps/server/src/db/schema/objects-view.ts`): her nesnenin GÜNCEL durumu zaten tek bir satırda projekte edilmiş — `fieldValues` (jsonb), `checklist` (jsonb), `recurrenceRule` (jsonb, nullable), `timeBlockStart`/`timeBlockEnd` (timestamp, nullable). JSON export'un en hazır kaynağı burası, ama yalnızca "an itibariyle" durumu taşıyor — CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür" değişmeziyle gerilimde: projeksiyon tarihçe/provenance taşımıyor, tam fidelity için event-replay gerekir (bkz. Açık Sorular).
- F1-T11'in doküman içeriği yalnızca `document_snapshots`'ta opak bir Yjs binary blob olarak duruyor. `DocumentReconstructionService.getLatestSnapshot` en son snapshot'ı ham `Buffer` olarak döndürüyor — `Block[]` biçimine ÇEVİRMİYOR. `blocksToPlainText` (`packages/core-objects/src/doc/`, F1-T13'ün ihtiyacıyla eklendi) var ama yapıyı (başlık/liste/vb.) DÜZ METNE indirgiyor — Markdown syntax'ı üretmiyor. F1-T18 muhtemelen yeni bir `blocksToMarkdown` (aynı pakette, saf, `blocksToPlainText`'in yanında) yazmalı.
- F1-T11'in kendi spec'i (`docs/specs/F1-E3/F1-T11-dokuman-editoru.md`, Kapsam DIŞI) bunu doğrudan işaret ediyor: _"Doküman şablonları, dışa aktarım formatları (Markdown/PDF export — F1-T18 kapsamına yakın, ayrı ele alınır)."_ — PDF burada anılıyor ama PLAN.md'nin F1-T18 satırı yalnızca JSON+Markdown+iCal listeliyor; PDF'in bu görevin kapsamında olup olmadığı netleşmeli (bkz. Açık Sorular, muhtemelen kapsam dışı).
- F1-T12: `timeblock` nesne tipi zaten var, `start`/`end` `objects_view`'da plain `timestamp` sütunları (indexlenebilir olacak şekilde bilinçli tasarlanmış). iCal export bunlardan `VEVENT` üretecek. Ancak dış (Google/Outlook) takvim etkinlikleri ADR-0012'ye göre LuminaOS'in doğruluk kaynağı DEĞİL — salt-okunur bir read-through cache (yabancı verinin izdüşümü). Bunları iCal export'a dahil etmek "bizim verimiz"i değil, üçüncü-taraf verisinin bir kopyasını yeniden dışa aktarmak anlamına gelir (bkz. Açık Sorular).
- Repo genelinde `.ics`/`VEVENT`/iCalendar üreten hiçbir kod yok — greenfield.
- `relations_view` (F1-T3): nesneler arası ilişkiler ayrı bir projeksiyonda tutuluyor — tam JSON export'un nesne başına yalnız kendi alanlarını değil, ilişkilerini de kapsaması gerekir (aksi halde export'tan geri yüklenen/okunan veri eksik olur).

## Kapsam

1. **JSON export:** Bir workspace'in (veya tek bir nesnenin) tam durumunu JSON olarak dışa aktarır — nesneler (`fieldValues`/`checklist`/`recurrenceRule` dahil), field-definition şeması (custom field tanımları, JSON'un kendi başına anlamlı/yorumlanabilir olması için) ve ilişkiler (`relations_view`) kapsanır. Tasarım kararı (plan aşamasında netleşir): projeksiyon-tabanlı (hızlı, an-itibariyle) mı, event-replay-tabanlı (tam fidelity, tarihçe dahil, daha pahalı) mı.
2. **Markdown export:** `doc` tipi nesneler için, `document_snapshots`'taki Yjs içeriği `DocumentReconstructionService` ile çekilip yeni bir `blocksToMarkdown` (core-objects, saf) ile okunabilir Markdown metnine çevrilir (başlıklar, listeler, vb. yapı korunur).
3. **iCal export:** `timeblock` nesneleri standart `VEVENT` alanlarıyla (başlangıç/bitiş/başlık) bir `.ics` dosyasına dışa aktarılır. Dış (cache'lenmiş) takvim etkinliklerinin dahil edilip edilmeyeceği tasarım kararı (bkz. Açık Sorular).
4. **Kapsam genişliği:** Workspace-geneli tam dışa aktarma (PLAN.md'nin "tam veri dışa aktarma" ifadesiyle uyumlu, öncelikli) ve/veya nesne-bazlı export (tek bir `task`/`doc`) — ikisinin de gerekip gerekmediği plan aşamasında netleşir.
5. **RBAC ile kesişim:** CLAUDE.md'nin "veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" değişmezi, F0-T5'in mevcut workspace-üyeliği RBAC'ıyla nasıl kesişiyor netleşmeli — export, kullanıcının ZATEN erişimi olan workspace verisiyle sınırlı olabilir (bu bir "kısıtlama" değil, var olan yetki sınırının doğal sonucu), ama workspace İÇİNDE rol bazlı bir export kısıtlaması (ör. "yalnızca admin export edebilir") YASAK olmalı (bkz. Açık Sorular ve Kabul Kriterleri).
6. **API:** Muhtemelen `GET /workspaces/:workspaceId/export?format=json|markdown|ical` (workspace-geneli) ve/veya nesne-bazlı bir varyant — tasarım kararı, plan aşamasında netleşir.

## Kapsam DIŞI

- Gerçek PDF export — F1-T11'in notu Markdown/PDF'i birlikte anıyor ama PLAN.md'nin F1-T18 satırı yalnızca JSON+Markdown+iCal listeliyor; plan aşamasında teyit edilecek, muhtemelen ayrı bir gelecek görev.
- Veri İÇE aktarma (import) — bu görev yalnızca dışa aktarmayı kapsar.
- Zamanlanmış/otomatik periyodik export (ör. günlük otomatik yedekleme) — v1 istek-üzerine (on-demand) export'tur.
- Dış (Google/Outlook) takvim etkinliklerinin iCal export'una dahil edilmesi — muhtemelen kapsam dışı (LuminaOS'in doğruluk kaynağı değil), plan aşamasında teyit edilir.
- Faz 2+ nesne tiplerinin (Context Fabric, Memory Passport vb.) export'u — bu görev yalnızca Faz 1'de var olan nesne tiplerini kapsar.

## Açık Sorular (Plan Aşamasında Netleşecek)

- JSON export projeksiyon-tabanlı (`objects_view`/`relations_view`'dan, hızlı) mı, yoksa event-replay-tabanlı (event log'dan, tam fidelity/tarihçe dahil, daha pahalı) mı olacak?
- Kapsam: workspace-geneli tam export mu, nesne-bazlı export mu, yoksa ikisi de mi — v1'de hangisi önceliklendirilecek?
- RBAC/export ilişkisinin kesin sınırı: workspace üyeliği export için yeterli mi (rol farketmeksizin, guest dahil herkes), yoksa CLAUDE.md'nin değişmezi başka bir şekilde mi yorumlanmalı?
- iCal export yalnızca LuminaOS'in kendi `timeblock` nesnelerini mi kapsıyor, yoksa dış (cache'lenmiş) takvim etkinliklerini de mi?
- Markdown export yalnızca `doc` tipini mi kapsıyor, yoksa `task`'ların checklist/custom field'ları da (ör. front-matter veya tablo olarak) Markdown'a dahil mi?
- PDF export bu görevin kapsamında mı (F1-T11'in notu) yoksa PLAN.md'nin lafzına sadık kalıp (yalnızca JSON+Markdown+iCal) ayrı bir göreve mi bırakılıyor?

## Kabul Kriterleri

- [x] Bir workspace'in tam JSON export'u üretilebilir; tüm nesne tipleri (`fieldValues`/`checklist`/`recurrenceRule`/ilişkiler dahil) ve field-definition şeması kapsanır (testli, PR1).
- [x] `doc` tipi bir nesnenin Markdown export'u, orijinal blok yapısını (başlıklar, listeler vb.) okunabilir Markdown syntax'ına çevirir (testli, gerçek Yjs snapshot'a karşı, PR2).
- [x] `timeblock` nesneleri geçerli bir `.ics` (iCalendar) dosyasına, standart `VEVENT` alanlarıyla (başlangıç/bitiş/başlık) dışa aktarılır; üretilen dosya bilinen bir iCal parser'ıyla (`ical.js`) doğrulanabilir (testli, PR3).
- [x] Export, kullanıcının workspace'teki mevcut erişim sınırları İÇİNDE çalışır (RBAC'ı bypass etmez) ama bu sınırlar içinde hiçbir özellik-bazlı/rol-bazlı kısıtlama (ör. "yalnızca admin export edebilir") uygulanmaz — CLAUDE.md'nin "veri dışa aktarma kısıtlanamaz" değişmezine testli kanıt (ADR-0016 §a, her üç PR'da guest-rolü testleriyle kanıtlı).
- [x] security-reviewer: export uç noktasının RBAC'ı doğru miras aldığı (workspace-dışı veri sızıntısı yok), export edilen içerikte hiçbir sistem-içi/hassas meta verinin (ör. şifreli takvim token'ları) sızmadığı doğrulanır (her PR'da ayrı ayrı, PR3'te 3 format için birleşik geçiş).

## İlerleme Notu

ADR-0016 (`docs/adr/ADR-0016-veri-disa-aktarma-rbac-kapsam.md`) ile netleşen kararlara göre bir ADR + 3 alt-PR'da tamamlandı:

- **ADR-0016** (#113) — RBAC=salt üyelik (rol-gate yok), JSON=projeksiyon-tabanlı, tek endpoint+opsiyonel `objectId`, Markdown=doc-only+doğrudan Yjs→Markdown (spec'in yanlış varsaydığı `Block[]`/`blocksToMarkdown` boru hattı yerine — o boru hattı hiçbir özellik tarafından kullanılmayan ölü kod olarak tespit edildi ve kayda geçirildi), iCal=yalnızca native `timeblock`, PDF kapsam dışı.
- **PR1** (#114) — `ExportService`/`ExportController`, `GET /workspaces/:workspaceId/export?format=json[&objectId=]`. security-reviewer'ın bulduğu bir hata (objectId daraltmasında ilişkilerin hep boş dönmesi) düzeltildi.
- **PR2** (#115) — `apps/server/src/docs/yjs-to-markdown.ts`: BlockNote'un gerçek Yjs ağaç şeması (paket kaynağından doğrulandı) üzerinde çalışan, `yjs-plain-text.ts`'in kanıtlanmış traversal desenini genişleten doğrudan Yjs→Markdown köprüsü. `format=markdown&objectId=` + JSON export'un `doc` nesnelerini `content` alanıyla zenginleştirmesi.
- **PR3** — `apps/server/src/export/ical-generator.ts`: elle yazılmış, yeni çalışma-zamanı bağımlılığı olmayan RFC5545 `VEVENT` üreticisi (deterministik `UID`, RFC5545 TEXT kaçışı, 75-oktet satır katlama — hepsi gerçek bir parser'a (`ical.js`, test-only devDependency) karşı doğrulandı). `format=ical[&objectId=]`.

Toplamda 3 format, tek RBAC deseni (yalnızca workspace üyeliği), CLAUDE.md'nin "veri dışa aktarma kısıtlanamaz" değişmezine ilk kez somut, test edilmiş bir uygulama.
