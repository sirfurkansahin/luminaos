# ADR-0030: Notetaker Botu Mimarisi — Üçüncü-Parti `MeetingBotClient`, Ayrı `meeting_details` Tablosu, Sağlayıcı-İmzalı Webhook, `transcriptText` Rol-Bazlı RBAC'ı

**Durum:** Kabul edildi
**Tarih:** 2026-08-21
**İlgili görev:** [F2-T13 — Notetaker Botu: Meet/Zoom/Teams Toplantı Kaydı + Transkript](../specs/F2-E4/F2-T13-notetaker-botu.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E4: Toplantı Zekâsı (Kapsam H)" (F2-T13 satırı) ve [ADR-0029](./ADR-0029-hibrit-ai-veri-siniflandirmasi.md) — bu ADR, ADR-0029'un genel veri-hassasiyeti politikasını F2-T13'ün somut üçüncü-parti mimarisine uygular, politikayı YENİDEN TARTIŞMAZ.

> Bu ADR'nin (a)-(c), (g), (j) maddeleri spec'in (`F2-T13-notetaker-botu.md`) Açık Sorular 1/2/4/7'sine ve plan onayında verilen mimari karara **AYNEN kayıt** geçiriyor — icat etmiyor (ADR-0027/ADR-0028'in aynı kural için kullandığı format). Bu ADR'nin KENDİ katkısı, spec'in ve planın açıkça `architect`'e bıraktığı beş somut karar: **(d)** `meeting_details` tablosunun tam şeması, **(e)** `MeetingBotClient` arayüzü + somut adapter şekli, **(f)** webhook imza doğrulama mekanizması, **(h)** `transcriptText`'in rol-bazlı görünürlük kuralı, **(i)** sağlayıcı tespitinin body-alanı mı yoksa URL-deseni-tespiti mi olacağı.

## Bağlam

1. **`ObjectType` union + `objectTypeRegistry`'nin tam şekli doğrulandı** (`packages/core-objects/src/lumina-object.ts:6`: `export type ObjectType = 'task' | 'doc' | 'note' | 'timeblock';`; `packages/core-objects/src/object-type-registry.ts:9-14`: `Record<ObjectType, {titleRequired: boolean}>`, `timeblock: {titleRequired: false}` dahil dört girdi). Yeni bir tip eklemek = union'a bir üye + registry'ye bir girdi eklemek — `timeblock`'un F1-T12'de izlediği AYNI mekanizma, yeni bir kayıt yolu İCAT EDİLMİYOR.
2. **`timeblock_external_pushes` tablosu, "özellik-özel bir kaygı için ayrı yan-tablo" emsalinin doğrulanmış örneği** (`apps/server/src/db/migrations/0016_tiny_hannibal_king.sql`): `object_id varchar(26) NOT NULL` (dikkat: **FK YOK** — `objects_view` bir event-log projeksiyonu, FK'lanabilir bir tablo değil, bu yüzden `object_id` düz bir doğrulanmamış-şekilde-referans-veren kolon), `calendar_account_id`'ye GERÇEK FK, `(object_id, calendar_account_id)` üzerinde unique index. `meeting_details` bu AYNI deseni izliyor (Karar d): `objectId` düz `varchar(26)`, FK yok.
3. **`ExternalCalendarEvent` arayüzünün tam şekli doğrulandı** (`packages/integrations/src/calendar-connector.ts:8-13`): yalnızca `{externalId: string; title: string; start: string; end: string}` — `meetingUrl` alanı hiç yok. `MockCalendarConnector` (aynı dosya, satır 62-122) tek somut implementasyon; gerçek Google/Outlook bağlayıcısı henüz YOK (yalnızca `CalendarAccount`'un `provider: 'google' | 'outlook'` tip imzası var, gerçek OAuth akışı F1-T12'nin kapsamı dışında bırakılmış).
4. **`calendar_events_cache` şemasının tam şekli doğrulandı** (`apps/server/src/db/schema/calendar-events-cache.ts:20-44`): `{id, calendarAccountId, workspaceId, externalId, title, eventStart, eventEnd, updatedAt}` — konum/URL alanı yok. `CalendarSyncPollerService.pollOnce` (`apps/server/src/calendar/calendar-sync-poller.service.ts:49-94`) `connector.listEvents()`'ten dönen her `event`'i `.insert(calendarEventsCache).values({...}).onConflictDoUpdate({...})` ile eşliyor — bu mapping'in HEM `values` HEM `set` bloğuna `meetingUrl: event.meetingUrl` eklenmesi gerekecek (PR2'nin kapsamı).
5. **`env.ts`'in "tek, opsiyonel sır" okuma deseni doğrulandı** (`apps/server/src/config/env.ts:238-246`, `readAnthropicApiKey`): absent/blank → `undefined` (asla fatal, boot zamanında process.exit YOK), değer şekil-doğrulaması YOK (gerçek doğrulama çağrı zamanında). `NOTETAKER_WEBHOOK_SECRET` (Karar f) bu AYNI deseni izleyecek — `readOAuthAppCredentials`'ın (satır 170-188) çift-alan/pair-completeness varyantı DEĞİL, çünkü webhook secret'ı TEK bir değer (client_id/client_secret ikilisi değil).
6. **`MembershipRole` union + `hasAtLeastRole` sıralama yardımcısı doğrulandı** (`apps/server/src/workspaces/membership.util.ts:1-12`): `'owner' | 'admin' | 'member' | 'guest'`, `ROLE_RANK = {guest:0, member:1, admin:2, owner:3}`, `hasAtLeastRole(role, minimum)`. Bugüne kadarki İKİ gerçek tüketici (`fields.controller.ts:165`, `saved-views.service.ts:90/199`) HER İKİSİ DE `hasAtLeastRole(callerRole, 'admin')` — idari bir MUTASYON eylemini kapılıyor. **Bu ADR, `hasAtLeastRole`'ün bir OKUMA yoluna (bir alanın GÖRÜNÜRLÜĞÜNE) uygulanan İLK kullanımı** (Karar h) — aynı fonksiyon yeniden kullanılıyor, yeni bir mekanizma İCAT EDİLMİYOR, yalnızca yeni bir eksen (mutasyon-gate → alan-görünürlük-gate) üzerinde.
7. **Bu kod tabanında `crypto.timingSafeEqual` için HİÇBİR emsal YOK** (doğrulandı: `apps/server/src/auth/password.ts`'in `verifyPassword`'ü `argon2.verify`'e sarmalı — argon2 kendi sabit-zamanlı karşılaştırmasını içeride yapıyor, çağıran kod hiçbir zaman ham hash'leri kendisi karşılaştırmıyor; kod tabanı genelinde `timingSafeEqual`/`timing-safe`/`constant-time` sıfır eşleşme). Bu ADR bu ilkeyi bu kod tabanına İLK KEZ getiriyor (Karar f) — egzotik bir yöntem değil, Node'un standart `node:crypto` ilkeli, HMAC imza karşılaştırması için doğru/beklenen araç.
8. **ADR-0028'in `McpTokenAuthGuard`/workspace-bağımsız `POST /mcp` modeli, BİLİNÇLİ KONTRAST noktası** (Karar g): o ADR'nin güven modeli kullanıcı-üretimli bir PAT'e (kimlik VAR) dayanıyordu; bu ADR'nin webhook'u sağlayıcı-imzalı bir callback'e (kullanıcı kimliği YOK, yalnızca sağlayıcı kimliği doğrulanıyor) dayanıyor — F2-T13 spec'inin kendi vurgusu (satır 4) da bunu "İKİNCİ, FARKLI türden inbound güven sınırı" olarak işaretliyor. `POST /mcp`'nin workspace-bağımsız URL tasarımının ARKASINDAKİ gerekçe (ADR-0028 §d: "URL parametresi ile gerçek yetki kaynağı bağımsız iki kaynak OLMASIN") burada da geçerli — `POST /webhooks/notetaker`'da zaten HİÇ URL parametresi yok, dolayısıyla o sınıf güvenlik açığı yapısal olarak imkansız (URL'de taşınan bir kimlik YOK ki gerçek yetkiyle uyuşmazlık çıksın).
9. **`apps/web/src/views/shared/CommandPalette.tsx` doğrulandı, var** — spec'in Açık Soru 4 önerisinin (yeni bir hızlı-eylem eklenmesi) izleyeceği mevcut yüzey; bu ADR'nin kapsamı değil, PR5'in `implementer`'ına bırakılıyor.

## Karar

### (a) Üçüncü-parti toplantı-bot API'si — kendi tarayıcı-otomasyonumuz DEĞİL (insan kararı, aynen kayıt)

Kendi bot/tarayıcı-otomasyon altyapımızı inşa etmek yerine, ZATEN VAR olan bir üçüncü-parti "meeting bot" API hizmeti kullanılır. Bu ADR'nin somut örnekleri **Recall.ai** tarzı bir API'yi (bot bir toplantı linkiyle davet edilir, sağlayıcı kendi tarafında katılır/kaydeder/transkribe eder, iş bitince bir webhook'la haber verir) referans alıyor — ama mimari, `MeetingBotClient` arayüzü (Karar e) ARKASINDA tutuluyor, tıpkı `CalendarConnector`'ın (Bağlam madde 3) belirli bir takvim sağlayıcısına sıkı bağlanmaması gibi. Sağlayıcı adı değişirse (Recall.ai yerine başka bir vendör), yalnızca `MeetingBotClient`'ın TEK bir somut implementasyonu değişir — çağıran kod (`MeetingsService`) DEĞİŞMEZ.

**Gerekçe:** kendi tarayıcı-otomasyonu botu inşa etmek (Meet/Zoom/Teams'in her birinin kendi DOM/protokolüne karşı bir headless-browser botu yazmak, oturum açma/katılma/ses-yakalama akışlarını sürdürmek) bu görevi aylar süren ayrı bir mühendislik projesine büyütürdü — spec'in kendi "Mevcut Durum" bulgusu (satır 19) bunu zaten reddediyor.

### (b) `meeting` `ObjectType` — mevcut union+registry mekanizmasıyla eklenir (insan kararı, aynen kayıt)

`packages/core-objects/src/lumina-object.ts`'in `ObjectType` union'ına `'meeting'` eklenir (Bağlam madde 1). `object-type-registry.ts`'e `meeting: { titleRequired: true }` girdisi eklenir — bir toplantının başlığı (`meetingUrl`'den veya takvim etkinliğinden türetilse bile) her zaman anlamlı bir tanımlayıcı olduğundan `task` ile AYNI kural (`titleRequired: true`), `doc`/`note`/`timeblock`'un `false`'undan FARKLI.

### (c) `meeting_details` — ayrı yan-tablo, `objects_view`'a GÖMÜLÜ DEĞİL (insan kararı, aynen kayıt)

`timeBlockStart`/`timeBlockEnd`'in (ADR-0012, `timeblock` nesnesine gömülü İKİ küçük zaman damgası) AKSİNE, toplantı alanları (`transcriptText` — potansiyel olarak BÜYÜK bir metin, `providerRecordingUrl`, `status`) `objects_view`'a gömülmek yerine YENİ, ayrı bir `meeting_details` tablosunda tutulur. **Gerekçe:** `objects_view`'a gömülü alanlar HER okuma sorgusuna (nesne listeleme, arama, context-graph traversal) otomatik olarak dahil olur — iki küçük zaman damgası için bunun maliyeti ihmal edilebilir, ama potansiyel olarak KB'larca büyük bir transkript metni için bu, gereksiz yere HER `objects_view` sorgusunu ağırlaştırır. `timeblock_external_pushes`'ın (Bağlam madde 2) "özellik-özel bir kaygı ayrı bir yan-tabloda yaşar" emsali burada AYNEN tekrarlanıyor — yeni bir desen İCAT EDİLMİYOR.

### (d) [ARCHITECT KARARI] `meeting_details` tablosunun tam şeması

```ts
// apps/server/src/db/schema/meeting-details.ts
import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const meetingProviderEnum = pgEnum('meeting_provider', [
  'google-meet',
  'zoom',
  'microsoft-teams',
]);

export const meetingStatusEnum = pgEnum('meeting_status', [
  'sunuldu',
  'beklemede',
  'kaydedildi',
  'basarisiz',
]);

export const meetingDetails = pgTable(
  'meeting_details',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // `meeting` LuminaObject'in ULID'i (packages/core-objects'in `newObjectId()`'i,
    // Bağlam madde 1) -- objects_view bir projeksiyon olduğundan (FK'lanabilir
    // bir tablo değil), timeblock_external_pushes'ın object_id kolonu (Bağlam
    // madde 2) gibi FK'siz düz bir varchar(26).
    objectId: varchar('object_id', { length: 26 }).notNull(),
    meetingUrl: text('meeting_url').notNull(),
    provider: meetingProviderEnum('provider').notNull(),
    status: meetingStatusEnum('status').notNull().default('sunuldu'),
    // Bot vendörünün (Karar a/e) bu toplantı-daveti için verdiği kendi kimliği --
    // webhook'un (Karar g) EŞLEŞTİRME anahtarı.
    providerMeetingRef: text('provider_meeting_ref').notNull(),
    providerRecordingUrl: text('provider_recording_url'),
    transcriptText: text('transcript_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Webhook'un `providerMeetingRef` ile TAM eşleşme araması O(1) index-lookup
    // olsun VE (istatistiksel olarak imkansız olsa da) bir vendör kimliğinin
    // sessizce iki farklı `meeting` nesnesine bağlanmasını DB seviyesinde
    // engellensin diye -- ADR-0028 §b'nin `tokenHash` unique index'inin AYNI
    // gerekçesi.
    uniqueIndex('meeting_details_provider_meeting_ref_idx').on(table.providerMeetingRef),
    // v0'da bir `meeting` nesnesi tam olarak BİR bot-daveti/detay satırı taşır
    // (yeniden davet = yeni bir `meeting` nesnesi, Karar a/g'nin sıkı opt-in'i
    // ve F2-T14'e ertelenen "aynı toplantıya tekrar davet" senaryosu gereği) --
    // bu invariant'ı DB seviyesinde de garanti eder.
    uniqueIndex('meeting_details_object_id_idx').on(table.objectId),
  ],
);
```

`status` enum değerleri Türkçe (`sunuldu`/`beklemede`/`kaydedildi`/`basarisiz`) — spec'in Açık Soru 5 önerisiyle (`sunulan`/`beklemede`/`kaydedildi`/`başarısız`) aynı anlam kümesi, yalnızca dilbilgisel olarak durum-adı biçimine (fiil değil sıfat/isim biçimi) ve ASCII-güvenli enum-değeri yazımına (Postgres enum literalinde Türkçe özel karakterden kaçınmak için `basarisiz`) normalize edildi.

### (e) [ARCHITECT KARARI] `MeetingBotClient` arayüzü + somut adapter şekli

```ts
// packages/integrations/src/meeting-bot-client.ts
export interface MeetingBotInviteRequest {
  meetingUrl: string;
  meetingObjectId: string; // meeting_details.objectId -- webhook eşleştirmesi için değil, vendöre "bizim referansımız" olarak iletilir
}

export interface MeetingBotInviteResult {
  providerMeetingRef: string; // meeting_details.providerMeetingRef'e yazılır
}

export interface MeetingBotClient {
  inviteBot(request: MeetingBotInviteRequest): Promise<MeetingBotInviteResult>;
}
```

Somut adapter, `CalendarConnector`'ın `MockCalendarConnector`/gerçek-bağlayıcı ayrımını (Bağlam madde 3) birebir izler: `RecallMeetingBotClient implements MeetingBotClient` (constructor: `{apiKey: string; webhookUrl: string}`), `inviteBot` vendörün "bot oluştur" uç noktasına `{meeting_url, webhook_url, metadata: {luminaosMeetingObjectId}}` benzeri bir gövde POST'lar, dönen vendör-kimliğini `providerMeetingRef` olarak sarar. **Not — dürüstlük payı:** Recall.ai'nin GERÇEK canlı API'sinin tam alan adları/uç nokta yolu bu oturumda bu repoya karşı DOĞRULANAMADI (harici bir servis, repo içinde bir SDK/doğrulama fikstürü yok) — `implementer`, PR3'e başlamadan ÖNCE vendörün güncel API dokümantasyonuna karşı bu istek/yanıt şeklini teyit etmeli; bu ADR'nin sabitlediği şey `MeetingBotClient` arayüzünün KENDİSİ ve `MockMeetingBotClient`'ın (testler için, `MockCalendarConnector`'ın responder-tabanlı deseniyle AYNI ruhta) davranışı — vendörün tam wire-format'ı DEĞİL.

`MockMeetingBotClient` testler için: `MockCalendarConnector.fixed`/`refreshTokenResponder` desenini (Bağlam madde 3, satır 108-121) izleyen, deterministik bir sahte `providerMeetingRef` üreten (`mock-bot-${counter}`) test double'ı.

### (f) [ARCHITECT KARARI] Webhook imza doğrulaması — HMAC-SHA256 + `crypto.timingSafeEqual`

```ts
// apps/server/src/notetaker/notetaker-webhook-auth.guard.ts (özet)
import { createHmac, timingSafeEqual } from 'node:crypto';
// ...
const rawBody: Buffer = request.rawBody; // ham byte'lar üzerinden imza -- body-parser'ın
// yeniden-serileştirdiği JSON DEĞİL (bkz. not)
const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
const providedHex = request.headers['x-notetaker-signature'];

if (
  typeof providedHex !== 'string' ||
  providedHex.length !== expectedHex.length || // timingSafeEqual FARKLI uzunluktaki
  // buffer'larda THROW eder -- önce
  // uzunluk eşitse karşılaştır, değilse
  // doğrudan reddet (kısa-devre bir
  // uzunluk-sızıntısı DEĞİL: uzunluk
  // zaten hex-digest'in SABİT boyutu,
  // gizli bir bilgi taşımıyor)
  !timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'))
) {
  throw new UnauthorizedError();
}
```

- **Header adı:** `X-Notetaker-Signature` — hex-kodlanmış HMAC-SHA256 imzası.
- **Neden `timingSafeEqual`, düz `===` DEĞİL:** bir imza karşılaştırması `===` ile yapılırsa, JavaScript'in string karşılaştırması İLK FARKLI byte'ta erken çıkar — saldırgan, yanıt süresindeki mikro-farkları ölçerek imzayı byte-byte tahmin edebilir (klasik zamanlama saldırısı). Bağlam madde 7'nin doğruladığı gibi bu kod tabanında hiç emsali yok; bu, Node'un bu tam senaryo için var olan standart, doğru ilkelidir — egzotik/icat edilmiş bir mekanizma değil.
- **Ham body zorunluluğu:** HMAC, body-parser'ın PARSE EDİP YENİDEN SERİLEŞTİRDİĞİ JSON üzerinden değil, isteğin HAM byte'ları üzerinden hesaplanmalı (JSON.stringify'ın anahtar sırası/boşluk farkı, sağlayıcının imzaladığı orijinal byte dizisiyle eşleşmeyebilir) — Nest'in `bodyParser.json({verify: (req, _res, buf) => { req.rawBody = buf; }})` seçeneğiyle yakalanır. Bu, `implementer`'a literal bir uygulama notu olarak bırakılıyor.
- **Sır kaynağı:** `env.ts`'e `notetakerWebhookSecret?: string` eklenir — `readAnthropicApiKey`'in (Bağlam madde 5) BİREBİR "absent/blank → `undefined`, asla fatal, şekil-doğrulaması yok" deseni. **Ancak istek-zamanı davranışı FARKLI:** sır boot'ta eksikse süreç YİNE DE açılır (Anthropic anahtarı gibi), ama guard, `secret === undefined` iken gelen HER webhook isteğini **fail-closed** olarak 401 ile reddeder (imzasız/doğrulanamaz bir payload'ı "sır yok diye" sessizce işlemek, "sır var ama yanlış" durumundan daha kötü bir davranış olurdu).

### (g) Webhook güven modeli — workspace-bağımsız `POST /webhooks/notetaker`, `providerMeetingRef` eşleştirmesi (insan kararı, aynen kayıt)

`POST /webhooks/notetaker` — URL'de `:workspaceId` YOK (ADR-0028'in `POST /mcp`'siyle AYNI yapısal gerekçe, Bağlam madde 8). Gelen payload'ın `providerMeetingRef`'i `meeting_details.providerMeetingRef` üzerinde TAM eşleşme (Karar d'nin unique index'i) ile aranır; eşleşme bulunamazsa istek sessizce/genel bir hata ile reddedilir (hangi ref'in var/yok olduğu saldırgana SIZDIRILMAZ — ADR-0026 §i'nin "geçersiz/süresi-dolmuş ayrımını yapmama" disipliniyle AYNI ilke). Bulunan satırın `objectId`'si üzerinden HANGİ workspace'e ait olduğu `meeting` nesnesinin kendisinden (event log'dan) çözülür — webhook, kullanıcı kimliği TAŞIMIYOR, yalnızca sağlayıcı kimliği (Karar f'nin HMAC'i) doğrulanmış oluyor.

**Cross-workspace izolasyonu:** bir workspace'in webhook'u, farklı bir workspace'in `meeting_details` satırını ASLA etkileyemez — `providerMeetingRef`'in unique index'i (Karar d) yapısal olarak bunu garanti eder (her ref TEK bir satıra, dolayısıyla TEK bir `objectId`'ye, dolayısıyla TEK bir workspace'e bağlı).

### (h) [ARCHITECT KARARI] `transcriptText` görünürlüğü — `guest` HARİÇ, `hasAtLeastRole(callerRole, 'member')`

`GET /workspaces/:workspaceId/meetings/:meetingId` (`SessionAuthGuard`+`WorkspaceMembershipGuard` arkasında), `transcriptText`'i yalnızca `hasAtLeastRole(callerRole, 'member')` (Bağlam madde 6) `true` döndüğünde yanıta dahil eder; `guest` rolü toplantının VARLIĞINI/metadata'sını (`title`, `provider`, `status`, `meetingUrl`, `createdAt`) görebilir ama `transcriptText` alanı yanıtta `null`/omitted olarak döner — 403/404 DEĞİL (toplantının kendisi zaten üyelik-kapılı, `transcriptText` yalnızca EK bir alan-görünürlük filtresi).

**Rol seçimi gerekçesi:** `guest`, `ROLE_RANK`'ta EN DÜŞÜK sıradaki rol (Bağlam madde 6) — kod tabanının genel niyetiyle tutarlı olarak, dış/sınırlı bir işbirlikçi rolü temsil ediyor. Bir toplantı transkripti, TÜM katılımcıların FİLTRELENMEMİŞ, ham konuşma içeriğini taşır (ADR-0029'un Kademe 1'i) — bir `doc`/`note`'un yazarının bilinçli olarak yazdığı metinden daha az "düzenlenmiş", potansiyel olarak daha samimi/rastgele konuşma içerebilir. `member`/`admin`/`owner` (workspace'in tam üyeleri) görebilir, `guest` (en kısıtlı rol) göremez — bu, `hasAtLeastRole`'ün ZATEN kurduğu sıralamanın DOĞRUDAN, YENİ bir eşik İCAT ETMEDEN uygulanması.

**ADR-0016 ile çelişki YOK — açıkça ayrıştırılıyor:** ADR-0016 §(a)'nın "export/okuma yolunda rol-gate YOK" kuralı, özel olarak `GET .../export` uç noktasının BLANKET politikasına dairdi (bir kullanıcının ZATEN erişimi olan veriyi TOPLU dışarı taşıması). Bu ADR'nin `transcriptText` kısıtlaması İSE `ContextService`'in `canViewField`'ının (ADR-0018) ZATEN kurduğu "alan-bazlı izin filtresi" kategorisine giriyor — `meeting_details.transcriptText` bir `field_definitions` satırı OLMADIĞI (özel-alan motorunun DIŞINDA, sabit bir sistem alanı) için literal `canViewField` fonksiyonu buraya UYGULANAMAZ (o fonksiyon bir `FieldPermissions` config nesnesi bekliyor, meeting_details'ın hiç sahip olmadığı), bu yüzden AYNI İLKENİN (bazı alanlar rol-bazlı gizlenir) SABİT-KODLANMIŞ bir uygulaması gerekiyor — YENİ bir kısıtlama KATEGORİSİ icat edilmiyor, ZATEN var olan `canViewField` ilkesinin `meeting`'in kendi okuma uç noktasına özgü, config-tabanlı olmayan bir tekrarı. ADR-0016 yalnızca export uç noktasını kapsıyor, bu ADR'nin `GET .../meetings/:id`'si export DEĞİL — ADR-0016 DEĞİŞMEDEN, tam kapsamıyla geçerli kalıyor.

### (i) [ARCHITECT KARARI] Sağlayıcı tespiti — açık body-alanı DEĞİL, URL-deseninden OTOMATIK tespit

`POST /workspaces/:workspaceId/meetings` isteği yalnızca `{meetingUrl: string}` alır — `provider` alanını istemciden İSTEMEZ. Sunucu, `meetingUrl`'i regex desenleriyle sınıflandırır:

```ts
const PROVIDER_PATTERNS: Array<{ provider: MeetingProvider; pattern: RegExp }> = [
  { provider: 'google-meet', pattern: /meet\.google\.com/i },
  { provider: 'zoom', pattern: /zoom\.us/i },
  { provider: 'microsoft-teams', pattern: /teams\.microsoft\.com/i },
];
```

Hiçbir desen eşleşmezse `ValidationError` (400, "desteklenmeyen toplantı linki") — v0 yalnızca üç adlandırılmış sağlayıcıyı destekliyor, tanınmayan bir URL'yi "bilinmeyen sağlayıcı" olarak kabul ETMİYOR.

**Gerekçe:** (1) daha az zorunlu alan, daha basit bir istemci sözleşmesi (özellikle ad hoc link-yapıştırma akışında, kullanıcı zaten sadece linki yapıştırıyor — hangi sağlayıcı olduğunu ayrıca seçmesi gereksiz bir sürtünme); (2) istemci-beyan-edilen `provider` ile GERÇEK URL'nin uyuşmazlığı sınıfını (kullanıcı yanlışlıkla "zoom" seçip bir Meet linki yapıştırırsa) yapısal olarak İMKANSIZ kılıyor — TEK doğruluk kaynağı URL'nin kendisi; (3) takvim-tetiklemeli akış zaten `calendar_events_cache.meetingUrl`'den (PR2) URL'yi otomatik çekiyor, kullanıcıdan hiç sağlayıcı seçimi istemiyor — ad hoc akışın da AYNI (yalnızca-URL) sözleşmeyi paylaşması iki akış arasında tutarlılık sağlıyor.

### (j) Sıkı opt-in — otomatik/sessiz bot-katılımı YOK (insan kararı, aynen kayıt)

Hem takvim-tetiklemeli hem ad hoc akış, HER ZAMAN kullanıcının açık "botu davet et" eylemini gerektirir — hiçbir arka-plan zamanlayıcısı/poller (`CalendarSyncPollerService`'in kendisi dahil) bir toplantıya OTOMATIK bot göndermez. `MeetingsService.inviteBot` yalnızca `POST /workspaces/:workspaceId/meetings` çağrıldığında tetiklenir.

## Mimari Değişmezlerle İlişki

- **"Hassas veri sınıfları buluta ham gönderilmez."** [ADR-0029](./ADR-0029-hibrit-ai-veri-siniflandirmasi.md)'nun Kademe 0 kuralını (ham ses/görüntü LuminaOS sunucusundan ASLA geçmez) bu ADR'nin mimarisi YAPISAL olarak uyguluyor: `MeetingBotClient.inviteBot` (Karar e) yalnızca bir `meetingUrl` GÖNDERİR ve bir `providerMeetingRef` ALIR — hiçbir ses/video byte'ı LuminaOS'in kod yolundan GEÇMEZ (vendör, toplantı platformuna DOĞRUDAN, LuminaOS'i araya sokmadan bağlanıp kaydediyor). Webhook (Karar g) LuminaOS sunucusuna yalnızca `transcriptText` (ADR-0029 Kademe 1) ve `providerRecordingUrl` (ham veriye bir REFERANS, ham verinin KENDİSİ değil) iletir. ADR-0029'un Kademe 0 onay şartı (tek-seferlik, kullanıcı-bazlı, görünür) bu ADR'nin kapsadığı PR5'in UI'ına bir gereksinim olarak taşınıyor.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR HİÇBİR export özelliğine dokunmuyor, HİÇBİR export uç noktasını kısıtlamıyor — `transcriptText`'in `GET .../meetings/:id` üzerindeki rol-bazlı görünürlüğü (Karar h) `GET .../export`'tan TAMAMEN AYRI bir uç nokta/kod yolu, ADR-0016'nın kapsadığı davranışı hiçbir şekilde değiştirmiyor (bkz. Karar h'nin son paragrafı, açık ayrıştırma).

## Değerlendirilip reddedilen alternatifler

- **Kendi tarayıcı-otomasyonu bot altyapımızı inşa etmek.** Reddedildi (Karar a, insan kararı) — aylar süren ayrı bir mühendislik projesi, spec'in kapsamının çok ötesinde.
- **`meeting` alanlarını `objects_view`'a gömmek (timeBlock deseni).** Reddedildi (Karar c) — potansiyel olarak büyük `transcriptText`'i HER `objects_view` okumasına dahil eder, gereksiz sorgu maliyeti; ayrı yan-tablo zaten kanıtlanmış bir emsal (`timeblock_external_pushes`).
- **`objectId` üzerinde gerçek bir FK.** Reddedildi (Karar d) — `objects_view` bir projeksiyon, FK'lanabilir bir fiziksel tablo değil; `timeblock_external_pushes` da AYNI nedenle FK'siz.
- **`McpTokenAuthGuard`'ın PAT modelini webhook'a uygulamak.** Reddedildi (Karar f/g) — sağlayıcı callback'inde kullanıcı kimliği YOK, PAT modeli buraya kavramsal olarak UYMUYOR; HMAC-imza doğrulaması doğru araç.
- **İmza karşılaştırmasında düz `===`/string eşitliği.** Reddedildi (Karar f) — klasik zamanlama-saldırısı yüzeyi; `crypto.timingSafeEqual` standart doğru araç.
- **`POST /workspaces/:workspaceId/meetings`'te açık bir `provider` body-alanı istemek.** Reddedildi (Karar i) — istemci-beyanı/URL uyuşmazlığı riski, gereksiz sürtünme; URL-deseninden otomatik tespit tek-doğruluk-kaynağı ilkesini koruyor.
- **`transcriptText`'i TÜM üyelere (guest dahil) göstermek, yalnızca üyelik-kapılamak.** Reddedildi (Karar h) — insanın spec-inceleme sırasında AÇIKÇA talep ettiği düzeltme; ham transkript içeriğinin hassasiyeti salt-üyelik'ten daha sıkı bir eşik gerektiriyor.
- **Takvim etkinliklerine otomatik/varsayılan bot daveti (opt-out modeli).** Reddedildi (Karar j, insan kararı) — diğer toplantı katılımcılarının haberi olmadan kaydedilme riski, en kısıtlayıcı varsayılan tercih edildi.

## Sonuçlar / Etkiler

**Şimdi ne kazanıyoruz:**

- CLAUDE.md'nin eksik ADR atfını kapatan ADR-0029'un politikası, F2-T13'ün somut mimarisinde SOMUT, test edilebilir bir uygulamaya kavuşuyor.
- `meeting` nesne tipi, mevcut union+registry mekanizması yeniden kullanılarak, yeni bir kayıt yolu icat edilmeden ekleniyor.
- Bu kod tabanının İKİNCİ inbound güven sınırı (ADR-0028'den SONRA), TAMAMEN FARKLI bir güven modeliyle (sağlayıcı-imza, kullanıcı-kimliği değil) doğru şekilde ayrıştırılıyor.
- `hasAtLeastRole`'ün ilk OKUMA-yolu (mutasyon değil) kullanımı, mevcut rol-sıralama altyapısının genellenebilirliğini kanıtlıyor.
- Ham ses/görüntünün LuminaOS sunucusundan hiçbir zaman geçmediği, çalışma-zamanı bir kontrole değil, `MeetingBotClient`'ın arayüz ŞEKLİNE (yalnızca URL gönderir/ref alır) dayanan YAPISAL bir garanti.

**Bilinen Sınırlamalar (neyi erteliyoruz/kabul ediyoruz):**

- **(a) Gerçek Google/Outlook takvim bağlayıcısı henüz YOK** — `meetingUrl` alanının takvim-tetiklemeli otomatik tespiti yalnızca `MockCalendarConnector` üzerinden test edilebilir; gerçek sağlayıcı OAuth'u ve gerçek toplantı-linki ayrıştırması, gerçek bağlayıcı OAuth akışı geldiğinde (ayrı bir gelecek görev) ele alınacak.
- **(b) `meeting_details` satırları için saklama/silme politikası YOK** — bir transkriptin ne kadar süre tutulacağı, kullanıcının "sil" diyebileceği bir mekanizma bu ADR'nin kapsamında değil; F2-T14'ün ("Saklama tercihleri + otomatik aksiyon çıkarımı") doğrudan işi.
- **(c) Tek, sabit vendör — çoklu-vendör failover YOK.** `MeetingBotClient`'ın arayüz-arkası tasarımı (Karar e) gelecekte bir vendör değişikliğini İZOLE bir karar olarak bırakıyor, ama v0 aynı anda yalnızca TEK bir somut adapter'ı DI'a bağlıyor — bir vendör kesintisinde otomatik geçiş YOK.
- **(d) Bot-katılım BAŞARISIZLIĞI için yeniden-deneme/backoff politikası YOK.** Başarısız bir davet yalnızca `status: 'basarisiz'` olarak işaretlenir — otomatik yeniden deneme YOK, kullanıcı manuel olarak yeni bir davet başlatmalı.

---

**Sıradaki adım:** Bu ADR, [ADR-0029](./ADR-0029-hibrit-ai-veri-siniflandirmasi.md) ile BİRLİKTE insan onayına sunulur — özellikle Karar (d) (tablo şeması), (e) (`MeetingBotClient` arayüzü + Recall.ai wire-format'ının implementer tarafından teyit edilmesi gerekliliği), (f) (HMAC mekanizması), (h) (`transcriptText` rol eşiği) ve (i) (URL-deseninden otomatik sağlayıcı tespiti) onaylanmalı. Onaylanırsa `test-writer` → `implementer` → `security-reviewer` ritüeline, spec'in önerdiği PR bölünmesiyle (PR1: `meeting` tipi + `meeting_details` şeması; PR2: takvim `meetingUrl` genişlemesi; PR3: `MeetingBotClient` + davet/okuma uç noktaları; PR4: webhook; PR5: ad hoc UI + tek-seferlik onay ekranı) geçilir.
