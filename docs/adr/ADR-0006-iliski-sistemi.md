# ADR-0006: İlişki Sistemi — Global Graf Doğrulaması, Kendi Stream'i Olan İlişki Varlığı ve Sorgu-Anında Askıya Alma

**Durum:** Kabul edildi
**Tarih:** 2026-07-24
**İlgili görev:** [F1-T3 — İlişki Sistemi](../specs/F1-E1/F1-T3-iliski-sistemi.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E1: Lumina Object Modeli" (F1-T3 satırı) ve CLAUDE.md "Mimari Değişmezler": _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_ — ayrıca "Kodlama Sözleşmeleri": _"Domain paketleri (`core-objects`, `context-fabric`, `memory`, `automation`) framework import edemez — saf TypeScript kalır"_ (bu görev yeni bir bağımlılık eklemedi, ama ADR-0005'in zod istisnası emsalinin sınırlarını netleştirmeye devam eder).

> Bu ADR dokümantasyon amaçlıdır (F0-T6/ADR-0002 ve F1-T2/ADR-0005 emsali): F1-T3 spec'i bu görevi mimari-kritik olarak işaretlememişti (F1-T1/ADR-0003'teki gibi koda-geçmeden-önce zorunlu insan onayı yok). Kararlar planlama sırasında gerekçelendirildi, üç ilişki türü (parentChild/reference/dependency) ile birlikte domain, projeksiyon ve HTTP katmanları uygulandı ve her adım `security-reviewer` denetiminden geçti. Bu ADR, koddan SONRA, gerçekleşen mimariyi belgeler.

## Bağlam

F1-T1 (ADR-0003) tek-nesne yaşam döngüsünü, F1-T2 (ADR-0005) tek-nesneye-bağlı alan tanımlarını/değerlerini kurmuştu — ikisinin de doğrulama mantığı **tek bir varlığın kendi olay akışına** bakarak karar verebiliyordu (`replayObject`/`replayFieldDefinition`, sadece kendi stream'ini okur). F1-T3, üç ilişki türünü (ebeveyn-çocuk, referans, bağımlılık) çift yönlü tutarlılık garantisiyle kurmak istiyor: bir nesnenin en fazla bir ebeveyni olabilir, ebeveyn-çocuk döngüsü kurulamaz, bağımlılık zinciri döngü içeremez, aynı çift arasında aynı türden referans tekrarlanamaz.

Bunların hiçbiri tek bir ilişkinin kendi olay geçmişinden çıkarılamaz — hepsi **workspace'in o türdeki TÜM diğer ilişkilerinin** o anki durumuna bakan global bir graf özelliğidir ("bu kenarı eklersem grafın herhangi bir yerinde döngü oluşur mu?", "bu çocuğun zaten başka bir ebeveyni var mı?"). Bu, F1-T1/F1-T2'nin "komut kendi state'ini kendi event'lerinden türetir" modelinden kökten farklı bir doğrulama şekli gerektiriyordu ve bu ADR'nin merkezi gerilimidir: **saf domain fonksiyonlarını, tek-varlık disiplinini bozmadan, çok-varlıklı/global bir doğrulamaya nasıl açarız?**

İkincil gerilimler: (1) her ilişki kendi stream'inde yaşarsa, F1-T1/F1-T2'nin tek-stream `readStream → replay → optimistic version` modelinin sağladığı doğal eşzamanlılık çakışması (aynı stream'e iki yazım = version çakışması) burada YOK — iki farklı ilişki iki farklı stream'e yazılır, hiçbiri diğeriyle çakışmaz; bu, global kuralların DB seviyesinde nasıl korunacağı sorusunu doğurur. (2) soft-delete edilmiş bir nesnenin ilişkileri "kaybolmalı" ama kalıcı olarak silinmemeli — bu bilgi nerede, ne zaman hesaplanır? (3) ilişki oluşturma/kaldırma hangi role açık olmalı — F1-T2'nin şema-yönetimi admin-gate'i mi, yoksa farklı bir varsayılan mı?

## Karar

### Varlık ve stream modeli: Relation, kendi event stream'ine sahip ayrı bir varlık (FieldDefinition emsali, FieldValueChanged değil)

`Relation` (`packages/core-objects/src/relations/relation.ts`): `{ id (ULID), workspaceId, fromId, toId, kind: 'parentChild'|'reference'|'dependency', status: 'active'|'removed', createdAt, updatedAt }`. Her `Relation` **kendi `streamType = 'relation'` event stream'ine** sahiptir (`RelationCreated`/`RelationRemoved`) — F1-T2'nin `FieldDefinition`'ıyla birebir aynı desen, F1-T2'nin `FieldValueChanged`'ıyla (nesnenin KENDİ `lumina-object` stream'ine yazılan olay) **kasıtlı olarak farklı**. Gerekçe: `FieldValueChanged`'in nesnenin stream'inde yaşamasının nedeni "varsayılan değerlerin `ObjectCreated` ile aynı `append()` çağrısında atomik yazılması" zorunluluğuydu (ADR-0005) — `Relation` için böyle bir atomiklik şartı yok; bir ilişki, iki nesnenin varlığından SONRA, ayrı bir komutla kurulur, hiçbir nesnenin oluşturulmasıyla "aynı anda" olmak zorunda değildir. Dolayısıyla ayrı stream, ne bir kısıtlama ne bir kolaylık kaybı getirir.

`relation-commands.ts`'teki saf komutlar (`createRelation`/`removeRelation`) `RelationEventDraft[]` döndürür; `relation-replay.ts`'teki `replayRelation`, `field-replay.ts`'in katı fold disipliniyle birebir aynıdır (ilk olay `RelationCreated` olmalı, her payload alanı `typeof`/bilinen-`RelationKind` guard'larıyla doğrulanır, tanınmayan olay tipi no-op — ADR-0003'ün `replayObject`'inin `default: return state` dalıyla aynı ileriye-uyumluluk mantığı).

### Merkezi mimari karar — `createRelation`, kendi geçmişini değil, workspace'in DİĞER ilişkilerini parametre olarak alır

F1-T1'in `createObject`'i ve F1-T2'nin `defineField`'i, sadece **kendi** (henüz var olmayan ya da kendi state'inden gelen) girdilerine bakarak karar verebiliyordu — tek-varlık kuralları (boş title reddi, bilinmeyen tip reddi) her zaman o tek varlığın kendi verisinden türetilebilir. `createRelation(input, existingRelations: Relation[])` ise **imza düzeyinde farklıdır**: ikinci parametre olarak workspace'in AYNI türdeki (parentChild/dependency/reference) diğer TÜM aktif ilişkilerini alır, çünkü:

- **parentChild tekil-ebeveyn kuralı**, `toId`'nin zaten aktif bir ebeveyni olup olmadığını bilmeyi gerektirir — bu bilgi, oluşturulmakta olan ilişkinin kendi (henüz var olmayan) geçmişinde yoktur, workspace'teki DİĞER `parentChild` ilişkilerinde vardır.
- **Döngü tespiti** (`findParentCycle`/`findDependencyCycle`, `relation-graph.ts`), önerilen kenarın workspace'in mevcut aynı-türden kenar kümesine eklenmesiyle bir döngü oluşup oluşmayacağını sorar — saf, senkron, framework-free O(V+E) algoritmalar: `findParentCycle` bir çocuk→ebeveyn haritası kurup önerilen ebeveynden yukarı doğru zinciri yürür (önerilen çocuğa ulaşırsa döngü); `findDependencyCycle`, önerilen hedeften BFS ile geriye doğru önerilen kaynağa bir yol arar (bulursa, önerilen kenarla birlikte döngü kapanır). İkisi de yalnızca `status: 'active'` ilişkileri dikkate alır (kaldırılmış ilişkiler döngü hesabına girmez) ve spec'in "1000 nesnelik zincirde <50ms" performans AC'sini karşılamak üzere doğrusal zaman karmaşıklığıyla yazılmıştır — dedike bir 1000-düğümlü performans testiyle (`relation-graph.test.ts`) doğrulanmıştır.
- **reference'ın yönsüz-çift tekrar reddi**, `{fromId, toId}`'yi yönden bağımsız (`{A,B} ≡ {B,A}`) bir küme olarak workspace'in diğer aktif referanslarıyla karşılaştırmayı gerektirir.

Bu, F1-T1/F1-T2'nin "komut saf kalır, sadece kendi state'ine bakar" ilkesini **bozmaz** — komutlar hâlâ saf, senkron, deterministik ve framework-free'dir; sadece girdi kümesi genişler (bir varlık yerine bir varlık + o türdeki komşu varlıklar kümesi). Sunucu katmanı (`RelationsService.create`) bu genişletilmiş girdiyi `relations_view` üzerinden `getActiveRelationsOfKind(workspaceId, kind)` sorgusuyla besler — okuma modelinden gelen bu veri yalnızca **doğrulama girdisi**dir, karar hâlâ saf domain fonksiyonunda verilir (F1-T1'in "komut kararları her zaman olay akışından, projeksiyondan değil" ilkesinin ruhu korunur: burada projeksiyon yalnızca komşu ilişkilerin listesini sağlar, kendi ilişkinin karar mantığını değil).

### Yön kuralları — bu görevle sabitlenen, kalıcı API sözleşmeleri

Bu görev üç yön kuralını **kesin olarak** sabitler (gelecekte değiştirilmesi API'yi kıracağından, bilinçli bir tasarım kararı olarak buraya not edilir):

- **parentChild**: `fromId` = ebeveyn, `toId` = çocuk.
- **dependency**: `fromId`, `toId`'yi bloklar (`fromId` blocks `toId`; `toId` is blocked by `fromId`).
- **reference**: yönden bağımsız/simetriktir — `fromId`/`toId` sırası API açısından anlam taşımaz; tekrar tespiti `{A,B}` çiftini yönsüz karşılaştırır.

### Soft-delete etkileşimi: askıya alma, saklanan bir kolon değil, sorgu-anında JOIN filtresi

Spec'in "nesne soft-delete olunca ilişkileri askıya alınır, restore'da geri gelir" şartı, `RelationsService.getRelated(objectId)`'de **iki JOIN sorgusuyla** (`getRelationsWithActiveCounterpart`, ileri ve geri yön için ayrı ayrı) çözülür: `relations_view`, `objects_view` ile karşı-uçtaki (`objectId`'nin kendisi değil, ilişkinin DİĞER ucu) nesne üzerinden INNER JOIN'lenir, `objects_view.lifecycle != 'deleted'` koşuluyla. Bu, HER istekte yeniden hesaplanır — hiçbir "askıda" durumu ayrı bir kolonda saklanmaz veya önbelleklenmez. Sonuç: bir nesne restore edildiğinde, ona bağlı ilişkiler **otomatik olarak** yeniden görünür hâle gelir, çünkü askıya alma hiçbir zaman yazılmamış, sadece okuma anında türetilmiştir — ADR-0005'in "rol-bazlı görünürlük filtrelemesi her istekte yapılır, saklanan view'da değil" kararıyla aynı disiplinin bir tekrarıdır (orada "kime göre hidden" değişkeni çağıranın rolüydü, burada "kim aktif" değişkeni karşı-ucun lifecycle'ıdır — ikisi de önceden hesaplanamaz).

`getRelated`, üç türü gruplu döner: `parentChild: { parent, children, childrenCount }`, `dependency: { blocks, blockedBy }`, `reference: []` (simetrik olduğundan ileri/geri sorgu sonuçları `dedupeById` ile birleştirilir). **Kasıtlı olarak uygulanmayan:** spec'in "tamamlanma özeti" ifadesi, düz bir `childrenCount` sayısına indirgendi — `LuminaObject`'in bugün bir "completed" durumu yok (yalnızca `lifecycle: active/archived/deleted`, ADR-0003), bu yüzden "tamamlanma" kavramını icat etmek bu görevin kapsamı dışına çıkardı; bu, planlama sırasında kullanıcı onayıyla netleştirilen bir kapsam-daraltma kararıdır, sonradan keşfedilen bir eksiklik değil.

### Rol gating: admin+ değil, hiçbir rol kısıtlaması yok

`FieldsController`'ın şema-yönetimi rotaları (`FieldDefinition` tanımlama/güncelleme/arşivleme) admin+ gerektirirken (ADR-0005), `RelationsController`'ın üç rotası (`POST /`, `DELETE /:relationId`, `GET /object/:objectId`) **hiçbir ek rol kontrolü yapmaz** — sınıf seviyesindeki `SessionAuthGuard` + `WorkspaceMembershipGuard` yeterlidir, `guest` dahil her üye ilişki kurabilir/kaldırabilir/okuyabilir. Bu bilinçli bir asimetridir: `FieldDefinition` bir **şema/izin konfigürasyonu** nesnesidir (kimin hangi alanı görebileceğini/düzenleyebileceğini belirler — yanlış ellerde workspace'in veri modelini bozar), oysa bir `Relation` iki nesne arasındaki **ilişki metadata'sıdır** — her iki nesneyi de zaten görebilen/üzerinde işlem yapabilen bir üye, aralarında bir bağ kurmakla ek bir yetki sınırını aşmaz. `assertObjectExists`, `fromId`/`toId`'nin çağıranın workspace'ine ait olduğunu (var olma + kapsam) doğrular; bu, tek gerekli güvenlik sınırıdır.

### Güvenlik sertleştirmesi — DB'de partial unique index, ve kasıtlı olarak ERTELENEN iki kardeş risk

F1-T1/F1-T2'de her varlık kendi stream'inde `readStream(streamId).length` ile optimistic-concurrency versiyonu aldığından, aynı varlığa yönelik iki eşzamanlı yazım doğal olarak çakışır ve biri reddedilir. **F1-T3'te bu güvence YOKTUR**: `toId`'si aynı olan iki FARKLI parentChild ilişkisi (iki farklı ebeveyn adayı, aynı çocuk için) iki FARKLI stream'e yazılır — hiçbiri diğeriyle stream-version çakışması yaşamaz, ikisi de kendi `existingRelations` ön-kontrolünü, diğeri henüz commit olmadan, geçebilir.

Bu, ADR-0005'in "eşzamanlı `define()` yarışı projeksiyonu kalıcı kilitlememeli" dersinin (bkz. ADR-0005 §"Uygulama sırasında ortaya çıkan iki güvenlik-sertleştirmesi kararı") burada TEKRARLANAN bir uygulamasıdır — sadece bu kez in-memory ön-kontrol tek başına yeterli olmadığından, DB seviyesinde kalıcı bir sertleştirme eklendi:

- `relations_view` üzerinde **partial unique index** `relations_view_active_parent_key` — `(workspaceId, toId) WHERE kind = 'parentChild'`. Bu, "bir çocuğun en fazla bir aktif ebeveyni olsun" kuralını DB seviyesinde zorunlu kılar.
- `RelationsViewProjection`'ın `RelationCreated` case'i bu partial index'i hedefleyen `onConflictDoNothing` kullanır — kaybeden `INSERT` sessizce atlanır, projeksiyon **hiçbir zaman** ham bir Postgres unique-violation ile çökmez/checkpoint'i tıkamaz (ADR-0005'in "poison pill" sınıfı hatasının aynısı, burada önceden önlenmiştir).
- `RelationsService.create`, `parentChild` türü için `catchUp` SONRASI kendi `relationId`'sinin gerçekten `relations_view`'a yazılıp yazılmadığını doğrular; yazılmadıysa çağıran yarışı gerçekten kaybetmiştir ve `ConflictError` görür (sessiz bir yanlış-201 değil).

**Bilinçli olarak KABUL EDİLEN/ERTELENEN iki kardeş risk** (aynı sınıftaki yarış koşulları, DB seviyesinde KAPATILMADI):

1. **reference'ın yönsüz-çift tekrar reddi** için eşdeğer bir DB kısıtı yok — bunu ifade etmek `LEAST(fromId,toId), GREATEST(fromId,toId)` türünden normalize edilmiş/hesaplanmış bir index gerektirirdi; bu görev için karmaşıklığa değmediği değerlendirildi.
2. **dependency'nin döngü-serbestliği** için hiçbir basit unique-index eşdeğeri yoktur — graf-döngüsüzlüğü bir tekil-index kısıtıyla ifade edilemeyen bir invaryanttır; tam kapatma uygulama-seviyesi kilitleme (advisory lock ya da benzeri) gerektirir, bu görevin kapsamı dışında bırakıldı.

Bu iki durumda da yarış penceresi dar (iki eşzamanlı `create()` çağrısının tam olarak aynı ön-kontrol anında çakışması gerekir) ve sonucu en kötü ihtimalle "olması gerekenden bir fazla referans/döngü riski taşıyan geçici veri" olup, kalıcı bir projeksiyon çökmesi değildir — bu risk sınıfının parentChild'dan daha düşük önemde olduğu, planlama sırasında değerlendirildi.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- Üç ilişki türü, tek bir olay çifti (`RelationCreated`/`RelationRemoved`) ve tek bir varlık modeliyle temsil ediliyor — çift kayıt yok, ters yön her zaman `getRelated`'da projeksiyonda türetiliyor (spec'in "tek olay, iki yönü de temsil eder" şartı).
- Global-graf doğrulama kuralları (tekil-ebeveyn, döngü tespiti, yönsüz-çift tekrar reddi), F1-T1/F1-T2'nin saf/senkron/framework-free komut disiplinini bozmadan, ek bir parametre (`existingRelations`) ile genişletilerek karşılandı.
- 1000 düğümlü zincirde <50ms performans AC'si, doğrusal zaman (O(V+E)) graf algoritmalarıyla ve dedike bir performans testiyle kanıtlandı.
- Soft-delete/restore etkileşimi hiçbir ekstra durum saklamadan, saf sorgu-anında JOIN filtresiyle çözüldü — restore otomatik olarak ilişkileri geri getirir.
- ADR-0005'in "unique-kısıt-ihlalini projeksiyonda sessizce yut, servis seviyesinde post-catchUp varlık kontrolüyle doğrula" deseni, ikinci kez, farklı bir bağlamda (ayrı stream'ler arası yarış) başarıyla uygulandı — bu artık iki görev boyunca doğrulanmış, tekrar kullanılabilir bir mimari desen.
- Replay determinizmi (olayların hangi sırayla gelirse gelsin projeksiyonun aynı sonucu vermesi), `relations-related.integration.test.ts`'teki `ProjectionRunner.rebuild()` çağrısıyla doğrulandı.

**Neyi erteliyoruz:**

- İlişkiye göre görünüm gruplaması — F1-T6'nın sorgu katmanı kapsamındadır (spec'in kendi kapsam-dışı maddesi).
- Otomatik zamanlama kaydırması (bağımlılık zinciri → takvim tarihleri) — Faz 2 takvim işlerinde ele alınacak (spec'in kendi kapsam-dışı maddesi).
- Gerçek bir "tamamlanma özeti" — `childrenCount`'un ötesinde, `LuminaObject`'e bir "completed" durumu eklenmeden (bugün yalnızca `lifecycle` var) anlamlı bir tamamlanma yüzdesi/özeti hesaplanamaz; bu, `LuminaObject`'in yaşam döngüsüne dokunacak ayrı bir görev gerektirir.
- `reference`'ın yönsüz-çift tekrar reddi ve `dependency`'nin döngü-serbestliği için DB-seviyesi yarış-koşulu sertleştirmesi — kabul edilen/ertelenen bir risk olarak yukarıda gerekçelendirildi; ihtiyaç somutlaşırsa (örn. üretimde gerçek bir çakışma gözlemlenirse) ayrı bir sertleştirme görevi açılmalı.
- Kalıcı silme (`purge`) sırasında ilişkilerin ne olacağı — ADR-0003'ün kendi `purge` arayüzü gibi, bu görev de yalnızca bir not düşer (soft-delete edilmiş bir nesnenin ilişkileri askıya alınır, ama nesne kalıcı silinirse ilişki satırları ne olur, `purge` uygulandığında ayrıca ele alınmalı — bugün `relations_view`'daki `onDelete: 'cascade'` FK'ları yalnızca satırın veritabanından fiziksel silinmesini kapsar, olay günlüğündeki `RelationCreated`/`RelationRemoved` olaylarını değil).
