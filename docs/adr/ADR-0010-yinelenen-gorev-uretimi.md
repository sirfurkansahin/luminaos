# ADR-0010: Yinelenen Görev Üretimi — Çapraz-Stream İdempotent Yazım ve `causationEventId`

**Durum:** Kabul edildi
**Tarih:** 2026-08-03
**İlgili görev:** [F1-T10 — Görev Deneyimi](../specs/F1-E3/F1-T10-gorev-deneyimi.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E3: Görev + Doküman + Takvim Çekirdeği" (F1-T10 satırı) ve CLAUDE.md "Mimari Değişmezler": _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_ — ayrıca "ADR Ne Zaman Gerekir" maddesinin ikinci fıkrası: karar birden fazla pakete/gelecekteki göreve dayatılan bir sözleşim tanımlıyor (`causationEventId`, Faz 2 Otomasyon Motoru'nun — `docs/PLAN.md` Kapsam I — kendi tetikleyici-üretimli ilişkileri için emsal oluşturuyor).

> Bu ADR mimari-kritiktir. F1-T10'un görev deneyimini tek bir kullanıcı aksiyonundan (durum → "Bitti") üç ayrı olay akışına (kaynak görev, yeni görev, yeni ilişki) dayanıklı-tek-seferlik yazım garantisiyle bağlaması, önceki hiçbir görevde karşılaşılmamış bir çapraz-stream idempotency sorunu doğurduğundan, koda geçilmeden ÖNCE insan onayı planlama aşamasında alındı. Bu ADR, o onaylanan tasarımı koddan ÖNCE belgeler (ADR-0003/F1-T1 emsali).

## Bağlam

F1-T10, `task` nesne tipini gerçek bir görev deneyimine dönüştürüyor; kapsamın bir maddesi, `status` custom field'ı `isDone: true` bayrağı taşıyan bir seçeneğe geçtiğinde otomatik olarak tam bir yeni `task` nesnesi üretilmesi ve bunun F1-T3'ün ilişki sistemiyle önceki göreve bağlanmasıdır — idempotent olmak zorunda (aynı tamamlanma olayı ikinci kez işlense bile ikinci bir nesne üretilmemeli).

Bu, kod tabanında ilk kez ortaya çıkan bir sınıf sorundur: **tek bir kullanıcı aksiyonunun, senkron olarak üç AYRI event-sourced varlığın (kaynak görevin kendi `lumina-object` stream'i, yeni üretilen görevin kendi stream'i, ikisini bağlayan yeni `Relation`'ın kendi stream'i) event stream'ine dayanıklı-tek-seferlik yazması gerekiyor. Önceki hiçbir görev bu deseni gerektirmedi:

- ADR-0005/F1-T2'nin `FieldValueChanged`'i ve ADR-0007/F1-T4'ün formül yeniden-hesaplaması, tek bir stream'e (nesnenin KENDİ stream'ine) tek bir `append()` çağrısıyla yazar — çapraz-stream değil.
- ADR-0006/F1-T3'ün `Relation`'ı kendi stream'inde yaşar ama HER ZAMAN kullanıcının doğrudan komutuyla, tek bir `create()` çağrısında kurulur — otomatik/türetilmiş bir yazım değil.
- Mevcut tek idempotency mekanizması, `EventStoreService.tryLoadIdempotentReplay`'dir (`apps/server/src/event-store/event-store.service.ts`) — bu yalnızca "AYNI batch, AYNI stream'e, AYNI beklenen versiyonla yeniden gönderildi mi" sorusuna bakar (event id + hedef versiyon eşleşmesi); tüketici tarafında (consumer-side) genel bir idempotency-key/checkpoint tablosu kod tabanının hiçbir yerinde yoktur. Bu, F1-T10'un ihtiyacından KÖKTEN farklı bir sorundur: F1-T10, "bu tamamlanma olayı için bir yinelenen görev zaten üretildi mi" sorusuna, üç FARKLI stream'e bakarak cevap vermek zorunda.

Çözülmesi gereken merkezi soru: mevcut altyapıyı (event store'un kendi idempotent-replay'i, F1-T3'ün ilişki-yarışı post-catchUp deseni) yeniden icat etmeden, bu çapraz-stream tek-seferlik garantisi nasıl kurulur — ve bu orkestrasyon mantığı, hangi katmanda, hangi paket/servis sınırında yaşamalı?

## Karar

### (a) Yeni `RelationKind` üyesi — `'recurrenceOf'`, yapısal olarak kısıtlanmamış

`packages/core-objects/src/relations/relation.ts`'teki kapalı birleşim (`RelationKind = 'parentChild' | 'reference' | 'dependency'`) `'recurrenceOf'` ile genişletilir; aynı isim, `relation-commands.ts` ve `relation-replay.ts`'teki (ikisi de kendi `KNOWN_RELATION_KINDS` runtime guard dizisine sahip, ADR-0006'nın "tanınmayan olay tipi no-op" ileriye-uyumluluk disipliniyle) her iki listeye de eklenir. `parentChild`'ın "en fazla bir aktif ebeveyn" kuralının (ADR-0006 §"Merkezi mimari karar") aksine, `recurrenceOf` hiçbir döngü/tekillik doğrulama dalı almaz — bir kaynak görev, yaşamı boyunca birden çok kez tamamlanıp her seferinde yeni bir yinelenen görev üretebilir (`fromId` = kaynak görev, `toId` = yeni üretilen görev), bu yapısal olarak `dependency`/`reference`'a değil `parentChild`'a benzeyen ama ONUN tekillik kısıtını taşımayan üçüncü bir davranış sınıfıdır.

### (b) `Relation.causationEventId?: string` — genel amaçlı, isimlendirmesi yinelenmeye özgü olmayan bir alan; partial unique index ile desteklenen bir soy kaydı

`Relation` arayüzüne (bugün `{ id, workspaceId, fromId, toId, kind, status, createdAt, updatedAt }`) opsiyonel bir `causationEventId?: string` alanı eklenir; `relations_view`'a (`apps/server/src/db/schema/relations-view.ts`) karşılık gelen nullable bir `causation_event_id` kolonu ve ADR-0006'nın `relations_view_active_parent_key` partial unique index'iyle (`(workspace_id, to_id) WHERE kind = 'parentChild'`, `0007_ordinary_thor.sql`) BİREBİR AYNI desende yeni bir partial unique index eklenir: `(workspace_id, kind, causation_event_id) WHERE causation_event_id IS NOT NULL`. Bu, "bir tetikleyici olayı, aynı türden en fazla bir ilişki üretebilir" kuralını DB seviyesinde zorunlu kılar — `parentChild`'ın "bir çocuğun en fazla bir ebeveyni olsun" kuralının yapısal ikizi, ama konusu farklı (çocuk-tekilliği değil, tetikleyici-olay-tekilliği).

Bu alan kasıtlı olarak GENEL isimlendirilmiştir (`recurrenceCausationEventId` gibi yinelenmeye-özgü bir ad değil): Faz 2'nin Otomasyon Motoru'nun (`docs/PLAN.md` Kapsam I, `packages/automation`) kendi otomatik-üretilmiş ilişkilerini aynı alanla işaretleyebilmesi için ileriye-dönük, bilinçli bir zemin bırakılıyor. **Açıkça belirtilmeli:** bu görev hiçbir genel tetikleyici/dinleyici çerçevesi KURMUYOR, yalnızca bu tek alanı ve tek özel-amaçlı kullanım yerini ekliyor — Otomasyon Motoru kendi dispatcher'ını kendi zamanında inşa edecek.

### (c) İki tamamlayıcı idempotency katmanı — yeni bir idempotency-key tablosu icat edilmez

**Katman A — `causationEventId` partial-unique-index soy kaydı, "yarışı kaybettiysem mevcut satırı döndür" davranışıyla.** `RelationsService.create`'in bugünkü `parentChild` için kullandığı "post-catchUp kendi satırım gerçekten yazıldı mı" kontrolü (ADR-0006 §"Güvenlik sertleştirmesi" — kaybeden çağıran bugün `ConflictError` görür) `recurrenceOf` + `causationEventId` için de çalışır, ama SONUCU kasıtlı olarak farklılaştırılır: `parentChild`'ın yarış kaybı bir KULLANICI aksiyonunun gerçek çakışmasıdır (yüzeye çıkarılmalı → `ConflictError`), oysa `recurrenceOf`'un yarış kaybı otomatik bir yan-etkinin arka-plan tekilleştirmesidir (yüzeye çıkarılacak bir kullanıcı hatası değil) — bu yüzden kaybeden çağıran, hata fırlatmak yerine `causationEventId` eşleşen MEVCUT ilişkiyi okuyup döndürür. Bu, ADR-0006'nın deseninin ÜÇÜNCÜ bir bağlamda (ADR-0007'nin formül-tanımı bağlamından sonra) tekrar kullanımıdır, ama sonuç davranışında bilinçli bir sapma taşır.

**Katman B — deterministik stream id'ler, `tryLoadIdempotentReplay`'i bedavaya kazanmak için.** Yeni görevin VE yeni ilişkinin `streamId`'si `randomUUID()` ile DEĞİL, tetikleyici tamamlanma olayının (`FieldValueChanged`, `isDone: true`'ya geçişi taşıyan olay) `id`'sinden deterministik olarak türetilir (ör. bir sabit tuzla `uuidv5`, ya da eşdeğer deterministik türetme). Sonuç: orkestrasyon çağrısı tekrarlanır/çift-işlenirse (ör. bir consumer'ın en-az-bir-kez teslim garantisiyle aynı tamamlanma olayını iki kez işlemesi), ikinci deneme AYNI `streamId`'ye AYNI `expectedVersion`'la yazmayı dener — bu tam olarak `EventStoreService.tryLoadIdempotentReplay`'in zaten çözdüğü senaryodur (event id + hedef versiyon eşleşirse, hata fırlatmadan önceki sonucu sessizce yeniden döndürür). Hiçbir yeni idempotency-key tablosu icat edilmez; mevcut event store mekanizması, girdileri deterministik yaparak ÜCRETSİZ olarak devreye sokulur.

### (d) Orkestrasyon yeri — yeni `apps/server/src/recurrence/task-recurrence.service.ts`, `ObjectsService` İÇİNDE değil

Bu orkestrasyon, `ObjectsService`'e (ADR-0007'nin formül yeniden-hesaplaması veya ADR-0008'in AI alan yenilemesi gibi) GÖMÜLMEZ — formül/AI yeniden-hesaplaması nesne-tipinden-bağımsız GENEL bir mekanizmadır (herhangi bir nesne tipindeki herhangi bir formül/ai alanı için çalışır), oysa "durum Bitti'ye geçince yeni bir görev üret" saf bir `task`'a-özgü İŞ KURALIDIR — bunu genel bir servise gömmek, `ObjectsService`'in nesne-tipi-agnostik sözleşmesini kirletirdi.

Yeni servis `apps/server/src/recurrence/task-recurrence.service.ts`'te yaşar. `ObjectsService.setFieldValues`, kendi olay ekleme (`append`) çağrısı BAŞARIYLA tamamlandıktan SONRA bu yeni servise TEK, dar, açık bir metot çağrısı yapar — `setFieldValues`'in bugün zaten sahip olduğu "kendi yazımı bittikten sonra yan bir servise açık çağrı yap" desenine birebir benzer (bkz. `scheduleOnSourceChangeAIRefreshes` çağrısı, ADR-0008'in `onSourceChange` AI-yenileme zamanlamasında kullandığı desen). **Açıkça belirtilmeli:** bu, genel bir olay-dinleyici/kayıt-defteri/dispatcher DEĞİLDİR — böyle genelleştirilmiş bir tetikleyici altyapısı Faz 2'nin Otomasyon Motoru'nun işidir; bu görev, o altyapıyı zamanından önce inşa etmekten kasıtlı olarak kaçınır.

### (e) Kabul edilen risk — çapraz-stream transaction yok, "yeniden-çağrılırsa idempotent" garantisi, "garanti teslim" değil

Event store'un stream'ler arası bir transaction'ı yoktur (her stream kendi optimistic-concurrency versiyonuna sahiptir, ADR-0002). Durum-değişikliği olayı zaten commit olduktan SONRA yinelenen-üretim adımı başarısız olursa, otomatik bir yeniden deneme YOKTUR — kod tabanında hiçbir kuyruk (queue) altyapısı yok, bu görevin kapsamı dışında. Bu ADR'nin verdiği garanti **"yeniden çağrılırsa idempotenttir"** — **"garanti nihai teslimat"** değil. Bu, spec'in gerçek kabul kriteriyle (aynı tamamlanma olayının iki kez işlenmesi ikinci nesneyi üretmemeli — yeniden-işleme üzerine YİNELENMEZLİK) birebir örtüşür, daha güçlü bir garanti iddia edilmiyor.

### (f) Tetikleyici tespiti — `isDone` bayrağının false→true geçişi, her düzenlemede değil

Tetikleme, `status` alanının ÖNCEKİ seçilen seçeneğinin `isDone` bayrağı ile YENİ seçimin `isDone` bayrağı karşılaştırılarak yapılır — yalnızca gerçek bir false→true geçişinde ateşlenir. Zaten tamamlanmış bir göreve yapılan sonraki düzenlemeler (ör. `priority` değişikliği, ya da `status`'un "Bitti"den "Bitti" olmayan bir başka `isDone:true` seçeneğine — böyle bir seçenek varsa — geçişi DIŞINDA bir true→true durumu) tetiklemeyi tekrarlamaz.

### (g) Kalıtım kuralı — başlık ve custom field değerleri kopyalanır, kontrol listesi boşalır, durum sıfırlanır

Üretilen yeni görev, kaynağın `title`'ını ve custom field değerlerini (öncelik dahil) kopyalar; kontrol listesi (F1-T10'un `ChecklistItem[]`'i) BOŞ başlar; `status` alanı ilk seçeneğe (`isDone` olmayan, yeni bir döngünün başlangıcı) sıfırlanır. Bu, teknik bir kısıt değil, planlama sırasında insan tarafından verilmiş bir ürün kararıdır.

### Değerlendirilip reddedilen alternatifler

- **Genel bir olay-tetikleyici/otomasyon dispatcher'ı şimdiden inşa etmek.** Reddedildi — bu, Faz 2'nin Otomasyon Motoru'nun (`docs/PLAN.md` Kapsam I) kapsamı; F1-T10'u erken genelleştirmek, tek bir kullanım yeri için gereksiz soyutlama maliyeti getirir ve spec'in kapsamını aşar.
- **Çok-varlıklı yazımı doğrudan `ObjectsService` içine gömmek.** Reddedildi — `ObjectsService` bugün nesne-tipinden-bağımsız genel bir servistir (formül/AI yeniden-hesaplaması gibi HERHANGİ bir nesne tipi için çalışan mekanizmalar barındırır); `task`'a özgü bir iş kuralını buraya gömmek bu genelliği kirletirdi.
- **Ayrı bir idempotency-key/checkpoint tablosu kurmak.** Reddedildi — event store'un `tryLoadIdempotentReplay`'i (deterministik stream id'lerle birleştiğinde) ve ilişkilerin mevcut "post-catchUp kendi satırım yazıldı mı" yarış-kontrolü deseni, aynı garantiyi, yeni bir tablo/mekanizma icat etmeden, ucuza sağlıyor.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- Tek bir kullanıcı aksiyonunun üç ayrı event stream'e senkron, dayanıklı-tek-seferlik yazması, hiçbir yeni idempotency-altyapısı icat edilmeden, mevcut iki mekanizmanın (event store'un deterministik-id replay'i + ilişkilerin partial-unique-index yarış-kontrolü) birleşimiyle çözüldü.
- `causationEventId`, Faz 2'nin Otomasyon Motoru için yeniden kullanılabilir bir emsal bırakıyor (genel isimlendirme, genel partial-unique-index deseni) — ama bu görev kendi kapsamını yalnızca yinelenen-görev kullanım yeriyle sınırlı tutuyor; Otomasyon Motoru kendi dispatcher'ını ayrıca inşa etmek zorunda kalacak, bu alan onun için hazır bir birincil-anahtar sağlıyor.
- Yeni `RelationKind` üyesi (`recurrenceOf`) küçük, düşük riskli bir şema genişlemesi — mevcut üç türün (`parentChild`/`reference`/`dependency`) hiçbirinin doğrulama mantığına dokunmuyor.
- Orkestrasyonun `task-recurrence.service.ts`'te ayrı yaşaması, `ObjectsService`'in nesne-tipinden-bağımsız genelliğini korurken, `setFieldValues`'in zaten sahip olduğu "yazım sonrası yan-servis çağrısı" desenini (AI-yenileme zamanlaması emsali) tekrar kullanıyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- Garanti-nihai-teslimat (kuyruk/retry altyapısı) — bu görevin kapsamı dışında; bugünkü garanti "yeniden çağrılırsa idempotent", "asla kaybolmaz" değil. Üretimde gerçek bir kayıp gözlemlenirse, ayrı bir kuyruk-altyapısı görevi (muhtemelen Faz 2) gerekir.
- Genel tetikleyici/dinleyici/dispatcher çerçevesi — kasıtlı olarak KURULMUYOR; bu Otomasyon Motoru'nun (F2-E5) kendi işi.
- `causationEventId`'nin `reference`/`dependency` türleri için kullanımı — bu görev yalnızca `recurrenceOf` + partial-unique-index kombinasyonunu uyguluyor; alanın kendisi genel ama bugünkü tek tüketicisi budur.
