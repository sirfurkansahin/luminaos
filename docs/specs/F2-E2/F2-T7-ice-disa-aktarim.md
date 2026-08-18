# F2-T7 — İçe/Dışa Aktarım: Açık Şema (JSON-LD) + ChatGPT/Claude Bellek İçe Aktarma Sihirbazı

**Epik:** F2-E2 (Memory Passport) · **Durum:** Tamamlandı — PR #138 (docs: ADR-0023 + spec), PR #139 (PR1: JSON-LD export backend), PR #140 (PR2: içe aktarma sihirbazı + export düğmesi).
**Bağımlılık:** F2-T5 (Memory Passport CRUD API'si — `apps/server/src/memory/`, `packages/memory`, ADR-0022; merged), F2-T6 (`apps/web`'in Memory Passport paneli, `MemoryPassportPanel.tsx`; merged), F1-T18/ADR-0016 (mevcut export altyapısı — `apps/server/src/export/`, tek-uç-nokta-çok-format deseni, RBAC=salt üyelik kararı).

> ⚠️ MİMARİ-KRİTİK GÖREV: CLAUDE.md'nin ADR kriterinin (b) fıkrasına giriyor — "açık şema (JSON-LD)" tanımı, tanım gereği LuminaOS'in dışına açılan, gelecekteki görevlere (F2-T8'in erişim politikası manifestoları bellek segmentlerini bu şemaya göre tarif edebilir; F2-T12'nin MCP sunucusu bu şemayı dışarı sunabilir) ve olası dış tüketicilere dayatılan bir sözleşim. Ayrıca "ChatGPT/Claude bellek içe aktarma sihirbazı" ifadesi, BU İKİ ÜRÜNÜN kendi bellek özelliklerinin gerçek, kararlı, herkese açık dokümante edilmiş bir dışa aktarma formatına sahip olduğunu VARSAYIYOR — bu varsayım kod tabanında hiçbir yerde doğrulanmamış ve ben (Claude) bu iki ürünün güncel/kararlı bir export şemasının var olup olmadığını güvenilir şekilde bilmiyorum. Bu görev için gerçek bir dış-format uydurmak yerine, kapsam bilinçli olarak genel bir içe aktarma biçimiyle sınırlanmalı — bu, ADR-0016 §(d)'nin BlockNote'un belgelenmemiş şemasını reverse-engineer etmek yerine daha küçük/kanıtlanmış bir yol seçmesiyle aynı türde bir risk-azaltma kararı. `architect` taslağı + insan onayı koddan önce zorunlu.

## Amaç

Memory Passport kayıtları (F2-T5) için (1) LuminaOS dışına taşınabilir, açıkça belgelenmiş bir JSON-LD şeması/export'u kurmak ve (2) kullanıcının dışarıdan (başka bir sistemden) bellek verisini LuminaOS'e aktarabileceği bir içe aktarma sihirbazı kurmak. "ChatGPT/Claude'a özel" format desteği, gerçek formatları doğrulanmadan (bkz. MİMARİ-KRİTİK not) taahhüt edilmez — v1 kapsamı genel, biçim-agnostik bir içe aktarma akışıyla sınırlanır.

## Mevcut Durum

- **F2-T5'in CRUD API'si hazır** (`apps/server/src/memory/memory-records.controller.ts`): `GET/POST/PATCH/DELETE /workspaces/:workspaceId/memory`, `POST` yalnızca TEK bir `{content: string}` kaydı oluşturuyor — TOPLU (bulk) oluşturma endpoint'i YOK. `MemoryRecord = {id, workspaceId, userId, content, kaynakOlayId, createdAt, updatedAt, deletedAt}` (`packages/memory/src/memory-record.ts`).
- **F2-T6'nın UI'ı hazır** (`apps/web/src/views/shared/MemoryPassportPanel.tsx`): mevcut kayıtları listeler/düzenler/siler/tekli-ekler; bu görevin sihirbazı bu panelin yanına veya içine eklenecek yeni bir akış.
- **F1-T18/ADR-0016'nın export altyapısı zaten var ve genişletilebilir desen kurmuş** (`apps/server/src/export/`): `GET /workspaces/:workspaceId/export?format=json|markdown|ical&objectId=` — TEK uç nokta, `format` parametresiyle dallanan, RBAC = salt `SessionAuthGuard`+`WorkspaceMembershipGuard` (rol-gate YOK, ADR-0016 §a — "export bir OKUMA eylemidir, CLAUDE.md'nin değişmezi bunu kısıtlamayı yasaklıyor" kuralı bu görevi de bağlar). F2-T5 PR3 zaten bu export'un JSON gövdesine `memoryRecords: MemoryRecord[]` alanını eklemiş durumda (caller'ın kendi kayıtları, tombstone hariç).
- **Repoda hiçbir JSON-LD implementasyonu yok.** Grep sıfır sonuç (yalnızca PLAN.md/spec metinlerinde geçiyor) — bu görev repodaki İLK JSON-LD yüzeyini kuracak.
- **Repoda hiçbir "içe aktarma" (import) mekanizması yok.** Ne bir dosya-yükleme akışı, ne dış-formattan-ayrıştırma servisi, ne de toplu-kayıt-oluşturma endpoint'i mevcut — F2-T7 bunların hepsini ilk kez kuracak.
- **ChatGPT/Claude'un gerçek bellek export formatı BU REPODA VE BENİM BİLGİMDE DOĞRULANAMAZ.** Bu iki ürünün "hafıza" özellikleri değişken/ürün-içi bir özellik; kararlı, sürüm numaralı, herkese açık dokümante edilmiş bir export JSON şeması olduğuna dair güvenilir bir kaynak yok. Bu şemayı tahmin ederek bir ayrıştırıcı (parser) yazmak, ADR-0016'nın BlockNote'un belgelenmemiş şemasını reverse-engineer etmekten kaçınma gerekçesiyle AYNI riski taşır (bkz. Kapsam Dışı).

## Kapsam

1. **JSON-LD export şeması (ADR'de sabitlenir, bkz. Açık Soru 1-2):** `MemoryRecord` için bir `@context` tanımı + `@type` alanı; her kayıt `{@context, @type, @id, content, createdAt, ...}` şeklinde JSON-LD uyumlu üretilir. Şemanın kapsamı yalnızca Memory Passport kayıtlarıyla sınırlı (F1-T18'in genel `LuminaObject` JSON export'u bu görevde JSON-LD'ye TAŞINMAZ).
2. **JSON-LD export uç noktası (ADR'de sabitlenir, bkz. Açık Soru 2):** Mevcut `ExportService`'e yeni bir `format=json-ld` mi eklenir, yoksa `apps/server/src/memory/`'ye özel yeni bir uç nokta mı (`GET /workspaces/:workspaceId/memory/export?format=json-ld`) kurulur — karar ADR'de netleşir. Hangi seçenek seçilirse seçilsin, RBAC = ADR-0016 §(a)'nın miras alınması (salt üyelik, rol-gate yok).
3. **Genel içe aktarma sihirbazı (`apps/web`):** Kullanıcının serbest-metin (satır satır) veya basit bir JSON dizisi (`{content: string}[]`) yapıştırabileceği/yükleyebileceği bir çok-adımlı akış: yapıştır/yükle → ayrıştırılmış önizleme (kaç kayıt bulundu, örnek içerikler) → onay → her kayıt için F2-T5'in `POST /workspaces/:workspaceId/memory` uç noktasına ayrı bir istek (bkz. Açık Soru 4 — toplu endpoint kapsam dışı bırakılırsa).
4. **"ChatGPT/Claude" adlandırması yalnızca UI kopyası düzeyinde ele alınır (bkz. Açık Soru 3):** sihirbaz, kullanıcıya "ChatGPT/Claude'dan kopyaladığın bellek metnini buraya yapıştır" gibi bir yönlendirme sunabilir (serbest-metin girdisi zaten bunu karşılar), ama bu iki ürüne özel bir dosya-formatı ayrıştırıcısı YAZILMAZ.
5. **Hata/kısmi-başarı ele alımı:** içe aktarma sırasında bazı kayıtların oluşturulması başarısız olursa (ör. boş içerik), kullanıcıya hangi kayıtların başarılı/başarısız olduğu açıkça gösterilir — sessizce yutulmaz.
6. **ADR:** `architect` subagent'ı ile JSON-LD şema tasarımı + export uç nokta kararı + içe aktarma kapsamının genel-format sınırlaması insan onayından önce yazılır (bir sonraki boş ADR numarası alınır — yazım sırasında teyit edilir).

## Kapsam DIŞI

- **ChatGPT'ye veya Claude'a özel dosya-formatı ayrıştırıcıları** — bu iki ürünün gerçek export formatı doğrulanmadan (bir insan bu formatın güncel bir örneğini/dokümantasyonunu sağlamadan) böyle bir ayrıştırıcı YAZILMAZ. Doğrulanırsa, ayrı bir gelecekteki görev/ADR kararı.
- **Otomatik/periyodik senkronizasyon** (ör. ChatGPT hesabına bağlanıp belleği otomatik çekmek) — yalnızca elle yapıştır/yükle akışı, hiçbir üçüncü-taraf API entegrasyonu yok (MCP-native entegrasyon F2-E3'ün kapsamı, burada değil).
- **F1-T18'in genel `LuminaObject` JSON export'unun JSON-LD'ye taşınması** — yalnızca Memory Passport kayıtları JSON-LD'ye kavuşuyor, diğer nesne tipleri bu görevin kapsamı dışı.
- **Toplu (bulk) kayıt oluşturma endpoint'i, eğer Açık Soru 4'ün kararı client-side döngüyse** — o zaman bu ayrı bir gelecekteki performans-iyileştirme görevi olur.
- **Dışa aktarılan JSON-LD'nin bir üçüncü-taraf semantik-web aracıyla (ör. bir RDF store) test edilmesi** — yalnızca sözdizimsel geçerlilik (geçerli JSON + gerekli `@context`/`@type`/`@id` alanları) bu görevde doğrulanır.
- **F2-T8** (bellek kullanım politikası manifestoları) — ayrı görev.

## Açık Sorular

1. **[KRİTİK]** JSON-LD `@context`'i nasıl tasarlanır — LuminaOS'e özel, sade bir sözlük mü (ör. `content`→`https://luminaos.dev/vocab#content` gibi kendi IRI'lerimiz), yoksa mümkün olduğunca `schema.org` terimleri mi kullanılır (ör. `content`→`schema:text`, kayıt tipi→`schema:Note` veya `schema:CreativeWork`)?
   - **Öneri:** `schema.org` terimleriyle mümkün olduğunca eşle (yaygın araçlarla uyumluluk, tekerleği yeniden icat etmeme), LuminaOS'e özel alanlar (`kaynakOlayId` gibi karşılığı olmayanlar) için kendi ek sözlüğümüzü tanımla. İnsan onayı gerekiyor çünkü bu, dışa açılan bir sözleşim.
2. **[KRİTİK]** JSON-LD export nereden sunulur — F1-T18'in `ExportService`'ine `format=json-ld` olarak mı eklenir (ADR-0016'nın tek-uç-nokta desenini genişletir), yoksa `apps/server/src/memory/`'ye özel, F2-T5'in modülüne ait yeni bir uç nokta mı olur?
   - **Öneri:** `apps/server/src/memory/`'ye özel yeni bir uç nokta (`GET /workspaces/:workspaceId/memory/export?format=json-ld`). Gerekçe: F1-T18'in export'u genel workspace-çapında bir "her şeyi dışa aktar" akışı; JSON-LD'nin asıl amacı Memory Passport'un TAŞINABİLİRLİĞİ (başka bir sisteme veya kullanıcının kendi arşivine) — kavramsal olarak F2-T5'in modülüne ait, `ExportService`'in genel `format` enum'unu bellek-özel bir kavramla kirletmek yerine.
3. **[KRİTİK]** "ChatGPT/Claude bellek içe aktarma sihirbazı" ifadesi PLAN.md'de yer alıyor ama bu iki ürünün gerçek export formatı bu oturumda doğrulanamıyor. Kapsam nasıl sınırlanır?
   - **Öneri:** v1'de yalnızca GENEL bir içe aktarma biçimi (serbest-metin, satır-satır veya basit JSON dizisi) kurulur; UI kopyası kullanıcıyı "ChatGPT/Claude'dan kopyaladığın metni buraya yapıştır" şeklinde yönlendirebilir ama özel bir dosya-formatı ayrıştırıcısı yazılmaz. Gerçek formatlar netleştiğinde (bir insan güncel bir export örneği sağladığında) ayrı bir görev/PR'da eklenir. İnsan onayı gerekiyor çünkü PLAN.md'nin lafzından BİLİNÇLİ bir daralma.
4. Toplu içe aktarma nasıl uygulanır — sihirbaz her kayıt için F2-T5'in mevcut `POST /memory`'sine ayrı bir istek mi atar (client-side döngü), yoksa yeni bir `POST /memory/bulk` endpoint'i mi eklenir?
   - **Öneri:** v1'de client-side döngü (mevcut API'yi genişletmeden, mekanik/basit). Büyük hacimli importlar için performans endişesi ortaya çıkarsa gelecekte bir bulk endpoint ayrı bir görev olarak eklenebilir.
5. JSON-LD export'un RBAC'i ADR-0016 §(a)'nın aynısı mı (salt üyelik, rol-gate yok)?
   - **Öneri:** Evet — export bir okuma eylemi, ADR-0016'nın "rol-gate yalnızca idari mutasyon içindir" kuralı bu görevi de bağlıyor (ADR-0016'nın kendi "Bağlayıcılık" notu bunu açıkça öngörüyor). Kritik değil, yalnızca teyit.

## Kabul Kriterleri

- [x] Açık Soru 1-5'in insan kararları ADR-0023'te kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu.
- [x] JSON-LD export uç noktası, geçerli bir `@context`/`@type`/`@id` içeren, caller'ın kendi (tombstone hariç) kayıtlarını döndürüyor, testli (10 saf fonksiyon testi + 25 entegrasyon testi).
- [x] Cross-user/cross-workspace izolasyon JSON-LD export'ta da korunuyor (F2-T5'in `list()` metodunun aynı garantisi), testli.
- [x] İçe aktarma sihirbazı: yapıştır/yükle → önizleme → onay → kayıtların oluşturulması uçtan uca çalışıyor, testli.
- [x] Kısmi başarısızlık durumunda hangi kayıtların oluşturulup hangilerinin başarısız olduğu kullanıcıya gösteriliyor, testli.
- [x] İçe aktarılan kayıtlar F2-T5'in event-sourced `MemoryRecordAdded` akışından geçiyor (doğrudan DB yazımı YOK) — mevcut CRUD API'si (`useCreateMemoryRecordMutation`) yeniden kullanılıyor.
- [x] `security-reviewer` denetiminde bulgu yok (hem PR1 backend hem PR2 frontend için ayrı ayrı denetlendi) — içe aktarma sırasında `userId`/`workspaceId` yalnızca session'dan, kullanıcı girdisinden asla; `parseImportInput` hiçbir zaman `content` dışında bir alan taşımıyor.
- [x] `pnpm --filter @luminaos/memory` ve `pnpm --filter @luminaos/server`/`@luminaos/web` typecheck/lint/test yeşil (regresyon yok).

---

**Sıradaki adım:** F2-T7 kapandı, F2-E2'nin bir sonraki (ve son) görevi F2-T8 ("Bellek kullanım politikası: hangi ajanın hangi bellek segmentine erişebildiği manifestolarla", `docs/PLAN.md` satır 251). F2-T8'in henüz bir spec dosyası yok — önce spec yazılmalı:

```
docs/specs/F2-E2/F2-T8-bellek-kullanim-politikasi.md spec dosyasını yaz, sonra Plan Mode ile F2-T8'i planla.
```
