# ADR-0015: Konuşma Komutları — Payload-Seviyesinde Kapsamlı Ajan-Aksiyon Sözleşmesi, `causationEventId` ile Onay→Yürütme Zinciri

**Durum:** Kabul edildi
**Tarih:** 2026-08-09
**İlgili görev:** [F1-T16 — Konuşma Komutları v1: Çok Adımlı Aksiyonlar + Onay Kartı](../specs/F1-E4/F1-T16-konusma-komutlari.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F1-E4: AI Servisi v1 + Veri Çıkışı" (F1-T16 satırı, satır 229) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesi — **HER İKİ** fıkra da bu kararı doğrudan tetikliyor: (1) karar "Mimari Değişmezler"den birine ("Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar") DOKUNUYOR, sınırında değil; (2) yeni event tiplerinin (`ActionsProposed`/`ActionsDecided`) şekli, spec'in kendi notuyla işaret edilen gelecekteki ajan-özelliklerine (Faz 2/3 Otomasyon Motoru) dayatılan bir emsal bırakıyor.

> Bu ADR, ADR-0014'ten (F1-T15, yalnızca sınırda, ikinci kritere giren bir karar) daha güçlü bir mimari-kritik adaydır: `packages/shared/src/events/domain-event.ts`'in `actorSchema` yorum bloğu, CLAUDE.md'nin zengin ajan-aksiyon sözleşmesinin bilinçli olarak Faz 3'e ertelendiğini ve şu an paylaşılan event zarfının bir parçası OLMADIĞINI açıkça söylüyor — ama aynı yorum, gelecekteki ev sahibi olarak `payload` veya "ayrı bir actor uzantısı"nı zaten işaret ediyor. Bu ertelemenin TEK belgelendiği yer `ADR-0002-event-store.md` (satır 58-62)'dir — tek paragraflık bir kapsam notu, derin bir mimari karşı-argüman değil. F1-T16, tam olarak "ajan bir aksiyon önerir, insan onaylar" özelliğidir ve bu sözleşimi KENDİ üç aksiyon tipi için, KENDİ yeni event tiplerinin payload'ında, paylaşılan zarfa dokunmadan uygulamayı öneriyor. Bu karar koddan ÖNCE, ayrı bir insan onayı gerektiriyor (F1-T16'nın "proceed?" onayından bağımsız — CLAUDE.md Çalışma Ritüeli madde 2'nin istisnası: mimari karar).

## Bağlam

F1-T15 (soru-cevap RAG) salt-okunurdu: retrieval + completion, hiçbir state mutasyonu yok. F1-T16 bunun tam tersini yapıyor — kullanıcı doğal dilde bir komut verir ("şunun için 3 alt görev üret", "bunu Ayşe'ye ata"), sistem sabit/kapalı bir aksiyon-tipi kümesinden (`createTask`, `generateSubtasks`, `assignPeople`) bir öneri listesi üretir ve kullanıcı HER aksiyonu tek tek onaylamadan hiçbirini yürütmez. Bu, `ai-gateway` çıktısının kod tabanında İLK KEZ gerçek state mutasyonuna yol açtığı görevdir.

Keşif üç ayrı boşluğu doğruladı:

1. **Ajan-aksiyon sözleşmesi boşluğu.** `domain-event.ts`'in `actorSchema` şu an yalnızca `{type: 'user'|'agent'|'system', id}` taşıyor (satır 13-18); yorum bloğu CLAUDE.md'nin `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesinin Faz 3'e ertelendiğini ve "ileride payload'da veya ayrı bir actor uzantısında ele alınacağını" açıkça belirtiyor. F1-T16 tam olarak bu sözleşimin ilk gerçek tüketicisidir.
2. **Propose→approve/execute yaşam döngüsü için emsal yok.** En yakın iki emsal `AIUsageRecorded` (`apps/server/src/ai/ai-usage.service.ts` `recordAIUsage`, satır 156-192: tek-seferlik audit kaydı, kendi dedicated stream'i `AI_USAGE_STREAM_TYPE`, ama hiçbir yaşam döngüsü — bir kez yazılır, bir daha güncellenmez) ve `Relation` (`packages/core-objects/src/relations/relation-commands.ts`: kendi stream'inde yaşayan, `RelationCreated`/`RelationRemoved` ile durum geçişi olan, replay edilen bir varlık). Bir öneri kümesi PROPOSED→DECIDED durum geçişine sahip olduğundan `Relation` deseni daha uygun — `AIUsageRecorded`'ın "tek-seferlik fact" deseni burada yetersiz kalır.
3. **Yapılandırılmış çıktı boşluğu.** `AIProvider.complete()` (`packages/ai-gateway/src/provider.ts:35-37`) hâlâ yalnızca `{prompt, maxTokens?, model?} → {text, usage, model?}` — JSON/tool-use gibi yapılandırılmış bir çıktı modu yok. En yakın emsal `resolveAIFieldValue`'nun (`apps/server/src/ai/resolve-ai-field-value.ts`) `outputType: 'select'` davranışı: sabit bir seçenek kümesine karşı doğrula, geçersizse AYNI render edilmiş prompt'a bir kez retry, yine başarısızsa fırlatmayan bir `AIFieldErrorValue` sentinel'i döndür (satır 42-78).

`causationEventId` deseni zaten kanıtlanmış: ADR-0010 (F1-T10), `Relation.causationEventId?: string` alanını ve `(workspace_id, kind, causation_event_id) WHERE causation_event_id IS NOT NULL` partial unique index'ini kurdu — bir tetikleyici olayının, aynı türden en fazla bir sonuç üretmesini DB seviyesinde zorunlu kılan, deterministik `streamId` türetimiyle `EventStoreService.tryLoadIdempotentReplay`'i (event id + hedef versiyon eşleşmesiyle sessiz no-op) bedavaya kazanan bir mekanizma (`apps/server/src/recurrence/task-recurrence.service.ts`, satır 65/95-119/222/298). Bugün yalnızca `createRelation` (`relation-commands.ts:35`) `causationEventId?` kabul ediyor; `createObject` (`packages/core-objects/src/commands.ts:20-26`, `CreateObjectInput`) bu alanı taşımıyor.

Çözülmesi gereken merkezi sorular: (1) ajan-aksiyon sözleşmesi hangi seviyede, ne kadar kapsamlı uygulanır; (2) öneri kümesinin yaşam döngüsü hangi event/stream tasarımıyla modellenir, gerçek mutasyona nasıl bağlanır; (3) yapılandırılmış aksiyon çıktısı `AIProvider`'ı genişletmeden nasıl elde edilir; (4) iki-aşamalı API'de öneri durumu nerede, nasıl tutulur.

## Karar

### (a) Ajan-aksiyon sözleşmesi — payload-seviyesinde, KAPSAMLI (scoped), paylaşılan zarfa DOKUNULMAZ

CLAUDE.md'nin `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesi, `domain-event.ts`'in `actorSchema`/`domainEventSchema`'sına HİÇBİR DEĞİŞİKLİK yapılmadan, F1-T16'nın iki YENİ event tipinin (`ActionsProposed`, `ActionsDecided`) PAYLOAD'ında uygulanır — bu, şemanın kendi yorum bloğunun zaten meşru ilan ettiği tam uzantı noktasıdır ("ileride payload'da... ele alınacak").

```ts
// ActionsProposed.payload
{
  proposalId: string;
  workspaceId: string;
  sourceObjectId?: string;
  command: string;
  actions: Array<{
    actionId: string;
    type: 'createTask' | 'generateSubtasks' | 'assignPeople';
    intent: string;        // niyet
    rationale: string;     // gerekçe
    resources: string[];   // kaynaklar[] — etkilenecek objectId'ler (varsa)
    rollbackNote: string;  // geri_alma_planı — insan-okunur NOT; gerçek undo YOK (kapsam dışı)
    params: Record<string, unknown>; // aksiyon-tipine özgü (ör. createTask: {title}, generateSubtasks: {count}, assignPeople: {userIds})
  }>;
}

// ActionsDecided.payload
{
  proposalId: string;
  decisions: Array<{ actionId: string; decision: 'approved' | 'rejected' }>;
}
```

Bu, spec'in kendi Kapsam Dışı maddesiyle ("ajan-aksiyon sözleşiminin TÜM gelecekteki ajan-özelliklerine genellenebilir TAM bir modelini kurmak" — YASAK) çelişmez: sözleşim yalnızca F1-T16'nın kendi 3 aksiyon tipi için, kendi payload'ında var oluyor; paylaşılan zarfa veya başka HİÇBİR göreve dayatılan bir kontrat yok. `domainEventSchema`'nın `.strict()` doğası (bilinmeyen üst-seviye anahtarları reddeder) ve `payload: z.record(z.string(), z.unknown())`'ın opak doğası (ADR-0002 §"Olay şeması") bu uzantıyı yapısal olarak zaten destekliyor — hiçbir migration/şema değişikliği paylaşılan katmanda gerekmiyor.

### (b) Event/stream tasarımı — kendi dedicated stream'i, `Relation`'ın "kendi yaşam döngüsü" deseni miras alınır

Her `parse` çağrısı yeni bir `proposalId` + kendi dedicated stream'i (`streamType: 'action-proposal'`) alır: `ActionsProposed` version 1, `ActionsDecided` version 2, AYNI stream'e yazılır. Bu, `AIUsageRecorded`'ın "tek-seferlik audit fact, kendi stream'i ama yaşam döngüsü yok" deseni yerine `Relation`'ın "kendi yaşam döngüsü olan, kendi stream'inde replay edilen varlık" deseni miras alınarak seçildi — bir öneri kümesi gerçekten PROPOSED→DECIDED durum geçişine sahip ve `decide` uç noktasının hangi aksiyonların hâlâ karar beklediğini bilmesi için bu durumun (`ActionProposalProjection` aracılığıyla) okunabilir olması gerekiyor; `AIUsageRecorded`'ın "yaz ve unut" modeli bu ihtiyacı karşılamaz.

Yürütme sırasında, her onaylanan aksiyon MEVCUT komuta (`createObject`/`createRelation`/`setFieldValues`) delege edilir; bu komutların ürettiği GERÇEK mutasyon event'leri (`ObjectCreated`/`RelationCreated`/`FieldValueChanged`) `causationEventId = ActionsDecided event'inin id'si` taşır — ADR-0010'un ZATEN kurduğu idempotency mekanizmasını AYNEN tekrar kullanır.

**Düzeltme (implementasyon öncesi doğrulamada tespit edildi):** ADR-0010 §(b)/(c) İKİ katman TASARLAMIŞTI — Katman A (`relations_view`'a `causation_event_id` kolonu + `(workspace_id, kind, causation_event_id) WHERE causation_event_id IS NOT NULL` partial unique index) ve Katman B (deterministik `streamId`/event id türetimi). Koda geçmeden önceki doğrudan doğrulama, **Katman A'nın hiçbir zaman inşa edilmediğini** ortaya çıkardı: `relations-view.ts` şemasında böyle bir kolon yok, hiçbir migration'da `causation_event_id` metni geçmiyor, `RelationsViewProjection` bu alanı payload'dan hiç okumuyor/yazmıyor. `RelationCreated`'ın payload'ında `causationEventId` alanı VAR (`relation-commands.ts:35,113-115`) ama yalnızca EVENT LOG'da bir soy-kaydı olarak duruyor, DB-seviyeli bir dedup mekanizması YOK. Gerçekte tek çalışan mekanizma **Katman B**'dir — `apps/server/src/recurrence/deterministic-uuid.ts`'in `deterministicUuid(namespace, name)` fonksiyonu (bağımsız, genel amaçlı, RFC 4122 v5) ile türetilen deterministik stream/event id'ler, `EventStoreService`'in zaten var olan idempotent-replay'ini (event id + hedef versiyon eşleşmesi) ücretsiz devreye sokuyor — `task-recurrence.service.ts`'te doğrudan doğrulandı (satır 121-133: hem yeni nesnenin hem yeni ilişkinin stream/event id'leri `causationEventId`'den türetiliyor, NE `createObject` NE `createRelation`'ın kendisi bu türetmeyi yapıyor — türetme tamamen SUNUCU KATMANINDA, çağıran tarafta oluyor).

**Karar (düzeltilmiş):** F1-T16'nın yürütme katmanı SADECE Katman B'yi kullanır — `TaskRecurrenceService`'in birebir aynı desenini tekrar eder: `executeAction()` (PR5), onaylanan her aksiyon için `deterministicUuid()` ile `ActionsDecided`'ın id'sinden stream/event id'leri türetir ve bunları `eventStore.append`'e AÇIKÇA geçirir. **Hiçbir yeni idempotency altyapısı icat edilmiyor, hiçbir yeni DB indexi/kolonu eklenmiyor** — aynı onay iki kez işlenirse (ör. bir retry), ikinci deneme aynı deterministik `streamId`'ye aynı beklenen versiyonla yazmayı dener ve `tryLoadIdempotentReplay` mevcut sonucu sessizce döndürür.

`causationEventId` zinciri (`gerçek mutasyon ← ActionsDecided ← ActionsProposed`) denetlenebilirliği somutlaştırır — DB-seviyeli bir index üzerinden değil, EVENT LOG'un kendi payload içeriği üzerinden: `RelationCreated`'ın bugün zaten yaptığı gibi (yalnızca event'in payload'ında durur, ayrıca bir okunabilir kolon/index olarak DEĞİL), CLAUDE.md'nin "kaynaklar[]" ve izlenebilirlik ruhunu yalnızca uygulama mantığıyla değil, event-log'un kendi ham içeriğiyle kanıtlanabilir kılar (bir replay/denetim, `causationEventId` alanını payload'dan okuyarak zinciri takip edebilir).

### (c) `createObject` opsiyonel `causationEventId` kazanır — küçük, mekanik, emsal-tekrarlayan uzantı (payload-seviyesi soy-kaydı, DB indexi DEĞİL)

`packages/core-objects/src/commands.ts`'teki `CreateObjectInput` bugün `causationEventId` KABUL ETMİYOR (yalnızca `createRelation`, `relation-commands.ts:35` ediyor). Bu ADR, `CreateObjectInput`/`ObjectCreated` payload'ına `causationEventId?: string` eklenmesini yetkilendirir — `relation-commands.ts`'nin (satır 113-115: `...(input.causationEventId !== undefined ? {causationEventId: input.causationEventId} : {})`) zaten kurduğu koşullu-yayma (conditional-spread) desenini birebir tekrar eder. **Açıkça belirtilmeli:** (b)'de düzeltildiği gibi, bu bir DB-indexi/dedup mekanizması KURMUYOR (öyle bir mekanizma `RelationCreated` için de yok) — yalnızca event payload'ında bir soy-kaydı (audit-trail) alanı ekliyor, `RelationCreated`'ın bugünkü pratiğiyle tutarlı. Gerçek idempotency, PR5'in yürütme katmanında `deterministicUuid()` ile sağlanır (bkz. (b)). Bu KENDİ BAŞINA yeni bir mimari karar DEĞİLDİR — mevcut, onaylanmış bir payload deseni ikinci bir komuta genişletiliyor; ayrı bir ADR gerektirmez, burada (a)/(b)'nin doğal bir yan-etkisi olarak kayıt altına alınır.

### (d) Aktör atfı — `ActionsProposed` ajanın, gerçek mutasyon event'leri ONAYLAYAN KULLANICININ

`ActionsProposed`'un actor'ü `{type: 'agent', id: 'command-parser'}`'dır (F1-T14/T15'in `AI_GATEWAY_ACTOR` deseniyle aynı ruhta, ayrı bir sabit isim). Ama yürütme sırasında üretilen GERÇEK mutasyon event'leri (`ObjectCreated`, `RelationCreated`, `FieldValueChanged`) **onaylayan kullanıcının** actor'üyle yazılır — `{type: 'user', id: approvingUserId}` — ASLA `'agent'` değil.

**Gerekçe:** bu, "ajan kullanıcının zaten sahip olmadığı bir yetkiyle çalışamaz" ilkesini event-log seviyesinde BAĞIMSIZ OLARAK DOĞRULANABİLİR kılar — yalnızca uygulama mantığının (bug içerebilecek) zorladığı bir davranış değil, event-log'un kendisini sorgulayarak kanıtlanabilecek bir gerçek. Bir denetim sorgusu ("bu `ObjectCreated` hangi kullanıcı kararına dayanıyor?") her zaman gerçek bir İNSAN kararına ulaşır, asla `'agent'` actor'üne düşmez. Bu, spec'in Kabul Kriteri 5(b)'sinin ("yürütme aşamasının yalnızca kullanıcının ZATEN sahip olduğu izinlerle çalıştığı, RBAC'ı aşan bir ajan-yetkisi olmadığı") somut, event-log'da doğrulanabilir karşılığıdır.

### (e) Yapılandırılmış çıktı — JSON-prompt + zod-doğrulama, `AIProvider`'a YENİ mod YOK

`AIProvider.complete()` (`packages/ai-gateway/src/provider.ts:35-37`) sözleşimi DEĞİŞMEZ — hâlâ `{prompt, maxTokens?, model?} → {text, usage, model?}`. Yeni `parseCommand` (`apps/server/src/ai/parse-command.ts`, DB-free, `answerQuestion`/`resolveAIFieldValue`'nun kardeşi): prompt modelden SIKI bir JSON şeması ister; çıktı `JSON.parse` + zod (`ParsedActionsSchema`) ile doğrulanır; ayrıştırma/doğrulama başarısız olursa AYNI render edilmiş prompta bir kez retry (`resolveAIFieldValue`'nun `outputType: 'select'` retry-once deseni birebir), yine başarısızsa `{actions: [], parseError: true, message}` sentinel'i döner — ASLA fırlatmaz, ASLA uydurma aksiyon üretmez (F1-T15'in "halüsinasyon yok" disiplininin doğal devamı, `answerQuestion`'ın boş-pasaj kısa-devresiyle aynı ruhta).

Bu, ADR-0008'in `AIProvider` kontratına dokunmadığından — (a)/(b)'den farklı olarak — KENDİ BAŞINA ayrı bir ADR gerektirmez; burada, ADR-0014 §(c)/(d)'nin daha düşük-riskli kararları kendi ana kararının yanında kaydettiği aynı disiplinle, tamlık için kayıt altına alınıyor.

### (f) İki-aşamalı API, sunucu-taraflı durum — istemci yalnızca proposal id + karar gönderir

`POST .../commands/parse {command, sourceObjectId?}` → `ActionsProposed` yazar (SIFIR mutasyon), `{proposalId, actions}` döner. `POST .../commands/:proposalId/decide {decisions: [{actionId, decision}]}` → `ActionsDecided` yazar, onaylanan her aksiyonu SENKRON yürütür, `{results}` döner. Öneri, iki çağrı arasında event log'da DAYANIKLI olarak yaşar — istemci yalnızca bir proposal id + kararlar dizisi gönderir, tüm aksiyon payload'ını asla geri göndermez.

**Gerekçe:** bu, denetlenebilirliğin BÜTÜNLÜĞÜ için kritik — bir onay, SPESİFİK, zaten kaydedilmiş bir öneriye atıfta bulunmalı, istemcinin keyfi olarak sağladığı ve kullanıcıya gerçekte gösterilenden sapabilecek bir payload'a değil. İstemci tüm payload'ı geri gönderseydi, kötü niyetli veya buggy bir istemci `ActionsProposed`'da hiç yer almayan bir aksiyonu "onaylanmış" gibi gösterebilir, ya da `rationale`/`resources` gibi denetim alanlarını sessizce değiştirebilirdi — event log artık "kullanıcıya gösterilenin aynısı onaylandı" garantisini veremezdi.

## Alt-PR ayrıştırması

ADR onayından SONRA, altı alt-PR öngörülüyor (tek plan onayı hepsini kapsar, CLAUDE.md Çalışma Ritüeli madde 2). **ADR-0014'ten farklı olarak** (orada yalnızca PR2 bu tür bir ADR'a bağımlıydı), burada **ALTI alt-PR'ın TAMAMI** bu ADR'nin (a)/(b) kararlarına bağımlı — hiçbiri bu ADR onaylanmadan test-writer/implementer turunu başlatamaz:

- **PR1** — `packages/core-objects`: `createObject`'e opsiyonel `causationEventId` (§c).
- **PR2** — `apps/server/src/ai`: `parseCommand` (§e) + `selectAIModel`'in `outputType` union'ına `'command'` eklenmesi.
- **PR3** — `apps/server/src/workspaces`: `WorkspaceMembershipService.assertAllMembers(workspaceId, userIds[])` (toplu üyelik doğrulaması, `assignPeople` için).
- **PR4** — `apps/server/src/commands`: `ActionsProposed`/`ActionsDecided` event tipleri (§a/§b), dedicated stream, `ActionProposalProjection` (migration + down script), `CommandsService.parse()`.
- **PR5** — `apps/server/src/commands`: `CommandsService.decide()` + yürütme katmanı (§b/§d — `causationEventId` delegasyonu, onaylayan-kullanıcı actor'ü, `generateSubtasks`'ın kısmi-başarısızlık raporlaması: `partially_executed`/`createdCount`/`totalCount`/`failedAtStep`).
- **PR6** — `apps/server/src/commands`: `CommandsController` + DTO'lar + iki uç nokta (§f).

## Alternatifler ve Reddedilme Gerekçeleri

- **Şimdi hiçbir şey yapmayıp tamamen genelleştirilmiş bir Faz-3 sistemine ertelemek.** Reddedildi — spec'in kendi kapsamı ŞİMDİ bir onay-kartı mekanizması gerektiriyor (F1-T16'nın PLAN.md'de tanımlı görevi); üstelik payload-seviyesinde, kapsamlı yaklaşım gelecekteki genelleştirilmiş sisteme HİÇBİR MALİYET YÜKLEMİYOR (paylaşılan zarfa dokunulmuyor, yeni bir genel kontrat dayatılmıyor) — bugünün ihtiyacını karşılarken yarının kapısını kapatmıyor.
- **Zengin sözleşmeyi doğrudan paylaşılan `domain-event.ts` zarfına eklemek.** Reddedildi — bu, `niyet`/`gerekçe`/`kaynaklar[]`/`geri_alma_planı` alanlarını SİSTEMDEKİ HER event tipine (hiçbir ajan katılımı olmayanlar dahil — `ObjectRenamed`, `RelationRemoved`, vb.) dayatırdı; çok daha büyük ve gerekçesiz bir blast radius. Payload-seviyesinde, yalnızca ajan-üretimli iki yeni event tipinde uygulamak, ihtiyacı olan tek yerde çözer.
- **`AIProvider`'a yeni bir yapılandırılmış-çıktı/tool-use modu eklemek (JSON+zod yerine).** Reddedildi (§e) — daha büyük blast radius (her sağlayıcı implementasyonunu, ör. `AnthropicProvider`'ı değiştirmeyi gerektirirdi) ve bu tek özelliğin ötesinde bugün hiçbir gerçek ihtiyaç yok; JSON-prompt+zod, mevcut `resolveAIFieldValue`'nun retry-once deseniyle aynı disiplinle, sözleşmeye dokunmadan aynı sonucu veriyor.
- **İstemcinin tüm önerilen-aksiyon payload'ını `decide` isteğinde geri göndermesi (tek-istekli onay, sunucu-taraflı durum yok).** Reddedildi (§f) — denetlenebilirlik/audit-trail bütünlüğü riski: bir onay, kullanıcıya GERÇEKTEN gösterilenden sapabilecek keyfi bir istemci-payload'ına değil, event log'da zaten kaydedilmiş SPESİFİK bir öneriye atıfta bulunmalı.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- CLAUDE.md'nin ajan-aksiyon Mimari Değişmez'i, paylaşılan event zarfına dokunulmadan, kendi payload-seviyesinde ve kendi kapalı 3-aksiyon-tipi kapsamında somut olarak karşılanıyor — `domain-event.ts`'in kendi yorum bloğunun işaret ettiği tam uzantı noktası kullanılıyor.
- `causationEventId` zinciri (§b/§d), F1-T16'nın "ajan önerir, insan onaylar" garantisini uygulama-mantığı iddiasından event-log'da bağımsız olarak doğrulanabilir bir gerçeğe dönüştürüyor.
- Hiçbir yeni idempotency/durum-makinesi altyapısı icat edilmiyor — ADR-0010'un gerçekten inşa edilmiş TEK katmanı (deterministik-streamId türetimi, `deterministic-uuid.ts`) ve `EventStoreService`'in mevcut idempotent-replay'i aynen tekrar kullanılıyor (bkz. §b düzeltmesi — ADR-0010'un tasarladığı DB-index katmanı hiç inşa edilmemiş, bu ADR o hataya dayanmıyor).
- `createObject`'in `causationEventId` kazanması (§c), `relation-commands.ts`'nin zaten onaylanmış desenini küçük, mekanik bir adımla ikinci bir komuta genişletiyor — yeni risk sınıfı yok.
- JSON+zod+retry-once (§e), `AIProvider`'ın sözleşimini bozmadan, `resolveAIFieldValue`'nun kanıtlanmış disiplinini yeni bir bağlama taşıyor.
- İki-aşamalı API (§f), audit-trail bütünlüğünü sunucu-taraflı durumla koruyor — istemci hiçbir zaman "neyin onaylandığı"nı yeniden tanımlayamıyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- Ajan-aksiyon sözleşmesinin TÜM gelecekteki ajan-özelliklerine (Faz 2/3 Otomasyon Motoru dahil) genellenebilir tam bir modeli — kasıtlı olarak KURULMUYOR; bu ADR yalnızca F1-T16'nın kendi payload'ını çözüyor, gelecekteki bir görev kendi genelleştirme kararını (muhtemelen kendi ADR'ıyla) ayrıca verecek. Bu ADR'nin isimlendirme/şekil kararları (actionId/intent/rationale/resources/rollbackNote alan adları) o gelecekteki karar için bir emsal bırakıyor ama onu ÖNCEDEN dayatmıyor.
- Gerçek geri-alma (undo) yürütmesi — `rollbackNote` yalnızca insan-okunur bir bilgilendirme notu; gerçek bir undo-komutu çalıştırmak bu görevin kapsamında değil.
- `generateSubtasks`'ın kısmi-başarısızlık durumunda zaten oluşturulmuş alt-görevlerin geri alınması — kapsam dışı; kısmen tamamlanmış sonuç şeffafça raporlanır (`partially_executed`), sessizce geri alınmaz veya gizlenmez.
- Genişletilebilir, plugin tarzı bir aksiyon-tipi sistemi — v1 sabit, kapalı 3 aksiyon tipiyle sınırlı; yeni bir aksiyon tipi eklemek bu ADR'nin şemasını genişletmeyi gerektirecek, ayrı bir karar.
