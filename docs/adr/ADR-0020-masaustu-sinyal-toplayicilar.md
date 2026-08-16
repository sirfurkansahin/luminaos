# ADR-0020: Masaüstü Sinyal Toplayıcılar — Rıza Modeli, Sinyal-İngestion Sözleşimi, Yerinde İşleme Sınırı, Bağlam Grafiği Genişletmesi (`person-topic`/`person-time`), Tauri Capability Modeli

**Durum:** Kabul edildi
**Tarih:** 2026-08-16
**İlgili görev:** [F2-T3 — Masaüstü Kabuktan Sinyal Toplayıcılar (Takvim Durumu, Aktif Pencere Başlığı)](../specs/F2-E1/F2-T3-masaustu-sinyal-toplayicilar.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E1: Lumina Context Fabric" (F2-T3 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin **HER İKİ** fıkrası da bu kararı tetikliyor: **(a)** karar CLAUDE.md'nin "Hassas veri sınıfları buluta ham gönderilmez" mimari değişmezine DOĞRUDAN dokunuyor — aktif pencere başlığı ve takvim olay detayı kullanıcının en hassas ham verilerinden ikisi, ve bu ADR o değişmezi bu görevin dar kapsamı için ilk kez somut, kod-seviyesi bir kurala döküyor; **(b)** karar birden fazla gelecekteki göreve dayatılan bir sözleşim tanımlıyor — burada sabitlenen "dış masaüstü istemci → yeni domain event → event store" ingestion deseni ve rıza modeli, F2-T4'ün (ilgililik/sönümleme skorlama) ve Faz 3'ün Agent Runtime/Ambient Intelligence/Sakin Yazılım vizyonlarının üzerine kuracağı ilk somut emsal; repoda bugüne kadar HİÇBİR domain event sunucu-dışı bir istemciden üretilmemişti. Bu ADR ayrıca ADR-0017 (bağlam grafiği şeması), ADR-0018 (`ContextGraphSyncWorker`'ın 5 saniyelik tazelik sözleşimi) ve ADR-0019'un (Karar f) `apps/desktop`'ı sıfır-komut bıraktığı sınırın üzerine doğrudan inşa ediyor.

> Bu karar seti tamamen insan onaylı geldi (spec'in "Açık Sorular" bölümündeki 5 sorunun tamamı plan incelemesinde kapatıldı) — bu ADR onları icat etmiyor, kod-seviyesi bir sözleşmeye döküyor ve mevcut kod tabanındaki tam emsallerle ilişkilendiriyor. Rıza (Karar 1) ve sinyal ingestion (Karar 2), `apps/server/src/availability/user-availability.service.ts`'in kurduğu "NON-LuminaObject, global-per-user, deterministik-`streamId`'li event-sourced agregat" desenini (`deriveDeterministicUuid` ile), `apps/server/src/fields/field-definitions.projection.ts`'in `onConflictDoNothing`/`requireStringPayloadField` desenini ve `apps/server/src/export/export.controller.ts`'in `requireRole`/guard-stack desenini yeniden kullanıyor — yeni bir idempotency ya da kimlik doğrulama mekanizması icat edilmiyor.
>
> İki karar özellikle kritik ve koddan önce kapatıldı: **Karar 2b** (yayma sıklığı) — masaüstü istemcisinin sabit-aralıklı polling'i, değişmeyen değerleri bile her tick'te sunucuya göndermeye çevrilirse, ortak event log'u (F0-T6'nın `rebuild`'in baştan oynattığı TEK log) tekrarlı telemetriyle kalıcı olarak şişirir — bu yüzden istemci-taraflı "yalnızca değişince gönder" (debounce-on-change) davranışı bağlayıcı bir test sözleşimi olarak sabitleniyor. **Karar 3** — ADR-0017'nin `context_graph_edges` şeması her zaman bir `entity` (LuminaObject) kökü varsaydığından, kişinin kendisiyle ilgili bir sinyali (hiçbir LuminaObject'e bağlı değil) temsil etmek için `edgeType` sözleşimi `person-topic`/`person-time` ile GENİŞLETİLİYOR — şema migration'ı gerekmiyor (kolonlar zaten herhangi bir düğüme referans veriyor), yalnızca `ContextGraphProjection`'ın kod-seviyesi genişlemesi.
>
> Bu ADR, F2-T3'ün sunucu-taraflı rıza+ingestion+bağlam-grafiği genişlemesini VE masaüstü-taraflı Tauri komut/capability/yerinde-işleme sınırını — koddan önce, tek bir tutarlı sözleşim olarak — sabitliyor.

## Bağlam

`apps/desktop` bugün F2-T2b'nin bıraktığı sıfır-komut iskelet halinde: `src-tauri/capabilities/default.json` yalnızca `{"permissions": ["core:default"]}`, `src-tauri/src/lib.rs`'deki `invoke_handler(tauri::generate_handler![])` boş, kod yorumu ADR-0019 Karar (f)'ye referans verip `get_active_window`'u gelecekteki bir F2-T3 komutu olarak adlandırıyor. `Cargo.toml`'da hiçbir OS-API crate'i yok.

Keşif dört bulguyu doğruladı:

1. **Rıza/sinyal-ingestion için tam emsal `UserAvailabilityService`.** `apps/server/src/availability/user-availability.service.ts` — `UserAvailability`, NON-LuminaObject, event-sourced, global-per-user bir agregat; `streamId`'si `deriveDeterministicUuid(NAMESPACE, userId)` (`packages/shared/src/ids/deterministic-uuid.ts`) ile deterministik türetiliyor, `readStream` → `append(streamId, priorEvents.length, [event])` → senkron `projectionRunner.catchUp(this.projection)` → read-back akışı izliyor. Bu, hem rıza hem sinyal-ingestion event'lerinin `streamId` mekaniğini icat etmeden kopyalayabileceği birebir kalıp.
2. **`ContextGraphProjection` (`apps/server/src/context/context-graph.projection.ts`) genişletilebilir, tam okunmuş.** `getOrCreateNode` (idempotent, `onConflictDoNothing` + `(workspaceId, nodeType, naturalKey)` unique-index hedefi), `createEdgeIfAbsent` (`sourceFieldKey` NULL/NOT NULL için iki parçalı-unique-index arasında geçiş yapan), `findEntityNode`, `toUtcDayKey`, `requireStringPayloadField` — hepsi yeni `DesktopSignalCaptured` case'i tarafından DOĞRUDAN yeniden kullanılabilir; hiçbiri `entity` köküne bağımlı değil (`getOrCreateNode`/`createEdgeIfAbsent` herhangi bir `nodeType`/`edgeType` string'i kabul ediyor).
3. **`context_graph_nodes`/`context_graph_edges` şeması zaten `entity` kökü ZORUNLU KILMIYOR.** `context-graph-nodes.ts`'in `fromNodeId`/`toNodeId` kolonları (`context-graph-edges.ts`) herhangi bir `context_graph_nodes.id`'ye referans veriyor — `nodeType` kısıtı yok, kolon seviyesinde `person`'dan `person`'a ya da `person`'dan `topic`'e bir kenar zaten temsil edilebilir. Bu, Karar 3'ün migration GEREKTİRMEDİĞİNİN somut kanıtı.
4. **`field-definitions.projection.ts`, yeni bir okuma-modeli projeksiyonu için tam emsal.** `onConflictDoNothing`/`requireStringPayloadField` deseni, `DesktopSignalConsentProjection`'ın birebir taklit edeceği kalıp; `export.controller.ts`'in `requireRole`/guard-stack deseni (`SessionAuthGuard`+`WorkspaceMembershipGuard`, salt-okunur uçlar için rol-yükseltme kontrolü YOK) yeni ingestion/rıza uçlarının izleyeceği kalıp.

Ayrıca kritik bir bulgu: ADR-0018, `ContextGraphProjection`'ı `ContextGraphSyncWorker` (5 saniyelik `setInterval`, `apps/server/src/context/context-graph-sync.worker.ts`) üzerinden ZATEN "canlı" hale getirdi — ADR-0017 Karar (h)'nin bıraktığı "türetilir ama beslenmiyor" boşluğu kapatıldı. Bu, `DesktopSignalCaptured` event'inin event store'a yazılmasının, HİÇBİR ek kablolama olmadan, en geç 5 saniye içinde bağlam grafiğine yansıyacağı anlamına geliyor — bu ADR yeni bir tazelik mekanizması icat etmiyor, mevcut sözleşmeyi devralıyor.

Çözülmesi gereken merkezi sorular (insan onayıyla kapatıldı, bu ADR'nin görevi bunları kod-seviyesi bir tasarıma dökmek): (1) rıza mekanizması; (2) sinyal-ingestion sözleşimi ve event hacmi kontrolü; (3) bağlam grafiği şema genişletmesi; (4) yerinde işleme sınırı; (5) platform kapsamı; (6) Tauri capability modeli; (7) `ContextGraphProjection` genişletmesi; (8) test stratejisi.

## Karar

### (a) Rıza mekanizması — sunucu-taraflı, olay-kaynaklı

Yeni domain event'ler: `DesktopSignalConsentGranted`/`DesktopSignalConsentRevoked`, payload `{signalType: 'calendar-status' | 'active-window'}`, `actor: {type: 'user', id: <rızayı veren kullanıcı>}`.

Yeni okuma-modeli tablosu `apps/server/src/db/schema/desktop-signal-consents.ts` (`desktop_signal_consents`):

```
id            varchar(26) PRIMARY KEY   -- içeride basılan ULID, diğer tüm okuma-modeli tablolarıyla aynı konvansiyon
workspaceId   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
userId        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE   -- user-availability.ts'in AYNI FK deseni
signalType    varchar(30) NOT NULL
grantedAt     timestamp with time zone NOT NULL
revokedAt     timestamp with time zone NULL
UNIQUE(workspaceId, userId, signalType)
```

Yeni `DesktopSignalConsentProjection` (`apps/server/src/context/desktop-signal-consent.projection.ts`), `handles: ['DesktopSignalConsentGranted', 'DesktopSignalConsentRevoked']` — `field-definitions.projection.ts`'in `onConflictDoNothing`/`requireStringPayloadField` desenini BİREBİR taklit eder:

- `Granted` → `insert(...).onConflictDoUpdate({ target: [workspaceId, userId, signalType], set: { grantedAt: event.occurredAt, revokedAt: null } })` — yeniden-rıza (revoke sonrası tekrar grant) `revokedAt`'ı sıfırlar.
- `Revoked` → `update(...).set({ revokedAt: event.occurredAt }).where(workspaceId+userId+signalType)`.

`streamId`, `UserAvailabilityService`'in deterministik-UUID desenini izler: `deriveDeterministicUuid(DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE, `${workspaceId}:${userId}:${signalType}`)` — sinyal-tipi bazında AYRI bir stream (spec'in "sinyal-tipi bazında ayrı rıza" granülerliğiyle 1:1). Yeni `DesktopSignalConsentsService` (`apps/server/src/context/desktop-signal-consents.service.ts`): `grant`/`revoke`, her ikisi de `append` sonrası SENKRON `projectionRunner.catchUp(this.consentProjection)` çağırır (`UserAvailabilityService.setStatus`'un aynı deseni) — bu, Karar (b)'nin ingestion kontrolünün read-your-writes tazeliğine ihtiyaç duyduğu (kullanıcı rıza verip HEMEN ardından sinyal göndermeye başlayabilir) tek yer, `ContextGraphSyncWorker`'ın 5 saniyelik toleranslı sözleşiminden (ADR-0018) BİLİNÇLİ olarak farklı.

Uçlar, `apps/server/src/context/desktop-signal-consents.controller.ts`:

- `POST /workspaces/:workspaceId/context/desktop-signal-consents` (grant, body `{signalType}`).
- `DELETE /workspaces/:workspaceId/context/desktop-signal-consents/:signalType` (revoke).

Guard stack: `SessionAuthGuard` + `WorkspaceMembershipGuard` (`export.controller.ts`'in AYNI kalıbı). **Self-service by construction, admin-gate YOK:** userId HER ZAMAN `req.user.id`'den alınır — body/param'dan asla — bu yüzden bir kullanıcının başka bir kullanıcının rızasını yönetmesi ROL kontrolüyle değil, API'nin şeklinin kendisiyle imkânsız kılınır. Bu, CLAUDE.md'nin "kullanıcının kendi verisi üzerindeki kontrolü kısıtlanamaz" ruhuyla ve ADR-0016'nın export-kısıtlanamaz kararıyla aynı çizgide.

### (b) Sinyal ingestion — yeni event + endpoint

`POST /workspaces/:workspaceId/context/desktop-signals`, body `{signalType: 'calendar-status' | 'active-window', value: string}`. Guard stack aynı (`SessionAuthGuard`+`WorkspaceMembershipGuard`). Yeni `DesktopSignalsService`/`DesktopSignalsController` (`apps/server/src/context/desktop-signals.service.ts`/`.controller.ts`).

Akış:

1. `DesktopSignalConsentsService`'in okuduğu AYNI `desktop_signal_consents` tablosundan `(workspaceId, req.user.id, signalType)` satırını oku; `grantedAt` dolu VE `revokedAt` NULL değilse `ForbiddenError` (403) — event YAZILMAZ.
2. Rıza varsa `DesktopSignalCaptured` event'i (payload `{signalType, value}`, `actor: {type:'user', id: req.user.id}`) event store'a yazılır. `streamId`, ayrı bir isim uzayıyla (`DESKTOP_SIGNAL_UUID_NAMESPACE`) AYNI `(workspaceId, userId, signalType)` deterministik türetimi — rıza streamiyle karışmaz (farklı `streamType`: `'desktop-signal-consent'` vs `'desktop-signal'`).
3. `ContextGraphProjection`'a senkron `catchUp` çağrısı YAPILMAZ — mevcut `ContextGraphSyncWorker`'a (ADR-0018 Karar a, 5 saniyelik `setInterval`) güvenilir; bu, context grafiğinin zaten kabul ettiği tazelik sözleşimiyle (read-your-writes garantisi YOK) tutarlı, yeni bir istisna eklemez.

### (c) Yayma sıklığı/olay hacmi — istemci-taraflı debounce-on-change (KRİTİK)

`DesktopSignalCaptured`, iş-kritik olaylarla AYNI ortak event log'a yazılır; HER projeksiyonun `rebuild`'i bu logu baştan oynatır (F0-T6 determinizm kabul kriteri). Masaüstü istemcisi sabit aralıklı polling yapacağından, her tick'te — değer değişmese bile — event göndermek log'u tekrarlı telemetriyle kalıcı olarak şişirir, `catchUp`/`rebuild` performansını bozar.

**Karar:** `apps/desktop/src/`'deki istemci, `POST /context/desktop-signals`'ı YALNIZCA türetilmiş değer bir ÖNCEKİ gönderilen değerden FARKLI olduğunda çağırır. İstemci son-gönderilen-değeri yerel frontend state'inde (React state/ref) tutar, her poll sonucunu bu değerle karşılaştırır, yalnızca fark varsa HTTP çağrısı tetiklenir. **Bağlayıcı davranış sözleşimi (implementer/test-writer için):** testte "aynı değerin N kez algılanması TEK bir istek üretir" doğrulanmalı — `@tauri-apps/api/mocks`'un `mockIPC`'siyle `invoke()` N kez aynı değeri döndürecek şekilde sahtelenip, altta yatan HTTP client mock'unun TEK çağrı aldığı doğrulanır.

### (d) Bağlam grafiği şema genişletmesi — `person-topic`/`person-time` kenar türleri (KRİTİK, Seçenek A)

ADR-0017'nin `context_graph_edges` şeması her zaman `entity` (LuminaObject) köklü kenarlar varsaymıştı (`entity-entity`/`entity-person`/`entity-time`/`entity-topic`). Masaüstü sinyali hiçbir LuminaObject'e bağlı değil — KİŞİNİN kendisiyle ilgili.

**Karar:** `context_graph_edges`'in `edgeType` sözleşimi yeni değerlerle GENİŞLER: `person-topic` (kişi şu an X konusuyla ilgileniyor) ve `person-time` (kişinin bu zaman bucket'ındaki aktivitesi) — `fromNodeId`'si bir `person` düğümü olan, `entity` kökü OLMAYAN kenarlar. `context-graph-nodes.ts`/`context-graph-edges.ts`'in `fromNodeId`/`toNodeId` kolonları zaten herhangi bir `context_graph_nodes` satırına referans veriyor, `nodeType` kısıtı YOK — bu yüzden **şema migration'ı gerekmiyor**, yalnızca `ContextGraphProjection`'ın kod-seviyesi genişlemesi (Karar h).

**Reddedilen Seçenek B (sentetik "aktivite oturumu" entity'si):** `objects_view`'i şişirir, ADR-0003'ün Lumina Object modelinin amacıyla (kullanıcının gerçek iş nesneleri) gerilimli — bu ADR'de Alternatifler bölümünde ayrıca not edilir.

### (e) Yerinde işleme sınırı — kesin, test edilebilir kural (KRİTİK)

Ham veri (tam pencere başlığı string'i, tam takvim event detayı/başlığı/katılımcı listesi) Rust/frontend tarafında ASLA sunucuya gönderilmez. Security-reviewer'ın denetleyeceği somut, kod-seviyesi bir liste:

**Yasak (asla `invoke()` sonucundan HTTP isteğine ya da Rust tarafında hiç çağrılmamalı):**

1. `GetWindowTextW`/`GetWindowTextLengthW` (tam pencere başlığı metni) — `apps/desktop/src-tauri/`'nin hiçbir yerinde ÇAĞRILMAZ.
2. `calendar_events_cache`'in `title`/katılımcı/açıklama alanları — `GET /workspaces/:workspaceId/calendar/events`'in yanıtından okunan bu alanlar, `POST /context/desktop-signals`'ın `value`'suna asla konmaz.
3. Süreç komut satırı argümanları (dosya/doküman yolu içerebilir) — okunmaz; yalnızca süreç imaj/yürütülebilir adı okunur.

**İzinli (sunucuya giden `value`, yalnızca bunlardan biri):**

1. Aktif pencere için: süreç adından türetilmiş "uygulama adı" (ör. `Code.exe` → bir uygulama-adı etiketi) — `GetForegroundWindow` + `GetWindowThreadProcessId` + süreç adı sorgusu ile elde edilir (bkz. Karar f/g). Pencere başlığının kendisi hiçbir aşamada okunmaz.
2. Takvim için: yalnızca meşgul/müsait durumu (boolean/enum) — `calendar_events_cache`'teki zaman aralığı istemci tarafında "şu an" ile çakışıp çakışmadığı kontrol edilerek türetilir; `title`/katılımcı alanları asla `value`'ya konmaz.

### (f) Platform kapsamı — Windows-only

`windows` crate (Rust), `GetForegroundWindow` + `GetWindowThreadProcessId` + süreç adı sorgusu — `GetWindowTextW` DEĞİL (Karar e gereği tam başlık metni hiç okunmaz/taşınmaz, yalnızca süreç adı okunur). ADR-0019 Karar (e)'nin CI'sı (`desktop-build`, `windows-latest`) zaten Windows-only, tutarlı. macOS/Linux Faz 3'e ertelenir — bu ADR'nin kapsamında değil.

### (g) Tauri capability modeli — isimlendirilmiş, ayrı capability dosyası

Yeni komut (`get_active_window_app_name` — TAM başlık değil süreç/uygulama adı döndürdüğünü isminde netleştiriyor) için, `default.json`'a satır içi eklenmez. Yeni, isimlendirilmiş, ayrı bir capability dosyası: `apps/desktop/src-tauri/capabilities/desktop-signals.json`:

```json
{
  "identifier": "desktop-signals",
  "windows": ["main"],
  "permissions": ["desktop-signals:allow-get-active-window-app-name"]
}
```

ADR-0019 Karar (f)'nin sabitlediği `default.json` (`{"permissions": ["core:default"]}`) DEĞİŞMEZ. En az ayrıcalık ilkesi görünür kalır, gelecekteki komutlar (F2-T4/Faz 3) `default.json`'u şişirmez — her yeni sinyal komutu kendi isimlendirilmiş capability dosyasını alır.

### (h) `ContextGraphProjection` genişletmesi

`handles[]`'e `DesktopSignalCaptured` VE `DesktopSignalConsentRevoked` eklenir (`DesktopSignalConsentGranted` HÂLÂ yalnızca Karar (a)'nın ayrı `DesktopSignalConsentProjection`'ına gider — `ContextGraphProjection` bunu dinlemez, çünkü grant kendi başına hiçbir düğüm/kenar üretmez, yalnızca SONRAKİ bir `DesktopSignalCaptured`'ın kabul edilip edilmeyeceğini belirler). İki projeksiyon birbirinden bağımsız kalmaya devam ediyor — `ContextGraphProjection`, `DesktopSignalConsentRevoked`'ı işlerken `desktop_signal_consents` tablosunu OKUMAZ, yalnızca olayın kendi payload'ından (`{signalType}`) ve `actor.id`'den hareket eder — ADR-0017 Karar (c)'nin "her projeksiyon yalnızca ham olaydan türer, başka bir projeksiyonun materyalize tablosunu asla okumaz" disiplini korunur.

**Karar (h.0) — Rıza geri alındığında GERİYE DÖNÜK silme (kullanıcı bulgusu, plan incelemesinde yakalandı, koddan önce kapatıldı).** Karar (a)/(b) yalnızca GELECEKTEKİ ingestion'ı durdurmaktan bahsediyordu — `DesktopSignalConsentRevoked` işlendiğinde daha önce toplanmış `person-topic`/`person-time` kenarlarının ne olacağı ele alınmamıştı. Revoke sonrası geçmiş türetilmiş veri grafikte kalırsa, kullanıcının "rızamı geri aldım" beklentisiyle gerçek durum arasında bir gizlilik tutarsızlığı oluşur.

**Karar:** `DesktopSignalConsentRevoked` (payload `{signalType}`, `actor.id` = ilgili kullanıcı) işlendiğinde, `ContextGraphProjection`:

1. `personNodeId`'yi `findNode`/eşdeğer bir sorguyla `(workspaceId, 'person', actor.id)` üzerinden bulur (yoksa no-op — hiç sinyal gelmemiş demektir).
2. `context_graph_edges`'ten `(workspaceId, edgeType='person-topic', fromNodeId=personNodeId, sourceFieldKey=signalType)` eşleşen TÜM satırları siler.
3. `context_graph_edges`'ten `(workspaceId, edgeType='person-time', fromNodeId=personNodeId)` eşleşen kenarları — **YALNIZCA bu `signalType`'tan türeyenleri** siler. `person-time` kenarının kendisi `sourceFieldKey` taşımıyor (Karar h.5, full-refresh gerektirmediği için `sourceFieldKey=null` ile oluşturuluyordu) — bu, revoke'un YANLIŞLIKLA başka bir sinyal tipinden (ör. `calendar-status`) gelen `person-time` kenarlarını silmemesi için, `person-time` OLUŞTURULURKEN de (Karar h.5 güncellemesi) `sourceFieldKey=signalType` set edilmesini GEREKTİRİR — bu ADR bu tutarlılığı burada sabitliyor: `createEdgeIfAbsent(..., 'person-time', personNodeId, timeNodeId, signalType, null, event.occurredAt)` (Karar h.5'in `sourceFieldKey` argümanı `null` DEĞİL, `signalType` olacak şekilde güncellendi).
4. Yalnızca İLGİLİ kullanıcının İLGİLİ sinyal tipinden gelen kenarları siler — başka kullanıcıların veya aynı kullanıcının diğer sinyal tiplerinin (`calendar-status` revoke edilirse `active-window` kenarları ETKİLENMEZ) kenarlarına dokunmaz. `topic`/`time` düğümlerinin kendisi SİLİNMEZ (başka kenarlar/kullanıcılar tarafından hâlâ referans veriliyor olabilir) — yalnızca bu kullanıcı-sinyal çiftine ait kenarlar kaldırılır.

`DesktopSignalCaptured` işlenirken (mevcut `getOrCreateNode`/`createEdgeIfAbsent`/`toUtcDayKey` yardımcıları AYNEN yeniden kullanılır, hiçbiri `entity` köküne bağımlı değil):

1. `personNodeId = getOrCreateNode(dbTx, event.workspaceId, 'person', event.actor.id, null, event.occurredAt)` — `ObjectCreated` case'indeki person-node oluşturma çağrısıyla BİREBİR aynı imza/mekanizma.
2. `timeNodeId = getOrCreateNode(dbTx, event.workspaceId, 'time', toUtcDayKey(event.occurredAt), null, event.occurredAt)` — `entity-time` ile AYNI `time` düğüm türü/doğal-anahtar uzayı yeniden kullanılır (gün bucket'ları paylaşılır, kişi ve entity aynı gün için aynı `time` düğümüne bağlanabilir).
3. `topicNodeId = getOrCreateNode(dbTx, event.workspaceId, 'topic', payload.value, null, event.occurredAt)` — `entity-topic`'in alan-değeri-bazlı konularıyla AYNI `topic` doğal-anahtar uzayı; bir masaüstü sinyalinin değeri (ör. `"VS Code"`) bir alan değeriyle string-eşleşirse aynı `topic` düğümüne birleşir — bu KASITLI kabul edilmiş bir davranış (bir "konu" kaynağından bağımsız aynı kavramı temsil eder), hata değil.
4. **Full-refresh (KRİTİK, ADR-0017 Karar d'nin aynısı):** yeni değer eklenmeden ÖNCE, `context_graph_edges`'ten `(workspaceId, edgeType='person-topic', fromNodeId=personNodeId, sourceFieldKey=signalType)` eşleşen TÜM satırlar silinir — `sourceFieldKey` kolonu bu amaçla yeniden kullanılır (`sourceFieldKey = signalType`), yeni bir kolon GEREKMEZ. Sonra `createEdgeIfAbsent(dbTx, workspaceId, 'person-topic', personNodeId, topicNodeId, signalType, null, event.occurredAt)`.
5. `createEdgeIfAbsent(dbTx, workspaceId, 'person-time', personNodeId, timeNodeId, signalType, null, event.occurredAt)` — `sourceFieldKey` burada `null` DEĞİL, `signalType` (Karar h.0'ın revoke-zamanı seçici silme işlemi bunu gerektiriyor — aksi halde bir sinyal tipinin revoke'u başka bir sinyal tipinin `person-time` kenarını da silerdi, çünkü `sourceFieldKey` olmadan iki sinyal tipinin kenarları ayırt edilemez). Full-refresh (Karar h.4'teki gibi) yine GEREKMEZ (`entity-time`'ın kendisi de full-refresh edilmiyor; her gün doğal olarak farklı bir `naturalKey`, birikimli) — `sourceFieldKey` eklemek yalnızca revoke-zamanı seçiciliği sağlıyor, full-refresh semantiğini değiştirmiyor.

Full-refresh olmadan, kişi bir uygulamadan diğerine geçtiğinde eski `person-topic` kenarı kalıcı kalırdı — tam olarak F2-T1'in ADR-0017 Karar (d)'de düzelttiği "eski konu asla silinmez" hatasının bu bağlamdaki tekrarı.

### (i) Test stratejisi

- **(a) Frontend `invoke()` çağrıları** `@tauri-apps/api/mocks`'un `mockIPC`'siyle test edilir — gerçek OS çağrısı yok, Karar (c)'nin debounce-on-change sözleşimi dahil.
- **(b) Sunucu-taraflı `DesktopSignalCaptured`/rıza akışı** gerçek Postgres entegrasyon testleriyle (F2-T1/F2-T2'nin Testcontainers deseni, `context-graph.projection.integration.test.ts`'in yapısı) test edilir: rıza-olmadan-red (403, event YAZILMADI doğrulaması), debounce-on-change davranışı (Karar c), full-refresh (Karar h.4), **revoke sonrası geriye dönük silme (Karar h.0 — yalnızca ilgili kullanıcı/sinyal-tipinin kenarları silinir, başka kullanıcı/sinyal-tipi etkilenmez)**, rebuild-determinizm (F0-T6 kabul kriteri — `person-topic`/`person-time` dahil sıfırdan aynı grafiği üretir).
- **(c) Rust `get_active_window_app_name` komutunun KENDİSİ** (gerçek Windows API çağrısı) CI'de test EDİLEMEZ (gerçek pencere yok) — manuel/smoke-test kabul edilir, bu sınır burada AÇIKÇA not edilir; F2-T1/F2-T2/ADR-0019'da kurulan "dürüstçe kabul edilmiş sınır" geleneğiyle tutarlı.

## Alt-PR ayrıştırması

Mimari-kritik görev — CLAUDE.md'nin ±400 satır rehberliğine tabi. Parçalar bağımsız merge edilebilir sırayla (her biri kendi test setiyle):

- **PR1 — Rıza mekanizması (sunucu):** `apps/server/src/db/schema/desktop-signal-consents.ts` (migration dahil), `apps/server/src/context/desktop-signal-consent.projection.ts`, `apps/server/src/context/desktop-signal-consents.service.ts`, `apps/server/src/context/desktop-signal-consents.controller.ts`, entegrasyon testleri (grant/revoke, self-service kısıtı, rebuild-determinizm).
- **PR2 — Sinyal ingestion + bağlam grafiği genişletmesi (sunucu):** `apps/server/src/context/desktop-signals.service.ts`/`.controller.ts` (Karar b), `apps/server/src/context/context-graph.projection.ts`'in Karar (h) genişletmesi, entegrasyon testleri (rıza-olmadan-red, full-refresh, `person-topic`/`person-time` rebuild-determinizm). PR1'e bağımlı (consent tablosunu okur).
- **PR3 — Masaüstü Tauri komutu + capability (Rust):** `apps/desktop/src-tauri/Cargo.toml` (`windows` crate), yeni bir Rust modülü (`get_active_window_app_name` komutu, Karar e/f), `apps/desktop/src-tauri/capabilities/desktop-signals.json` (Karar g), `lib.rs` kablolaması, `default.json` DEĞİŞMEZ. PR1/PR2'den bağımsız, paralel geliştirilebilir.
- **PR4 — Frontend entegrasyonu:** rıza ekranı/ayarı (aç/kapat, sinyal-tipi bazında), `@tauri-apps/api/core`'un `invoke()`'u ile komut çağrısı, takvim için doğrudan HTTP istemcisiyle `GET .../calendar/events` çağrısı + client-side meşgul/müsait türetimi (Karar e), debounce-on-change state (Karar c). `@tauri-apps/api/mocks` testleri. PR1/PR2/PR3'ün tamamına bağımlı.

F2-T4 (ilgililik skorlama + zaman aşımıyla sönümleme), F2-E2/Memory Passport, macOS/Linux desteği, genel bir "üçüncü taraf istemciden event ingestion" API'si KAPSAM DIŞI (spec'in kendi "Kapsam DIŞI"sı korunuyor).

## Alternatifler ve Reddedilme Gerekçeleri

- **Seçenek B — yalnızca masaüstü-yerel rıza (sunucuya hiç gitmeyen).** Reddedildi — Karar (a)'ya göre; denetlenemez, cihaz değiştiğinde sıfırlanır, "rıza verildi" durumu event log'a (tek doğruluk kaynağı) hiç yansımaz, CLAUDE.md'nin event-sourcing değişmeziyle gerilim yaratır.
- **Ayrı, event-log dışı bir "signals" tablosuna doğrudan yazma + arka-plan job'uyla senkron.** Reddedildi — Karar (b)'ye göre; event-sourcing değişmezini deler (`packages/shared`'in tek doğruluk kaynağı ilkesi), F2-T1'in kurduğu tek-okuma-modeli disiplinini çiğner.
- **Sabit-aralıklı her poll'da (değer değişmese bile) sinyal göndermek.** Reddedildi — Karar (c)'ye göre; ortak event log'u tekrarlı telemetriyle kalıcı şişirir, F0-T6'nın `rebuild` performans garantisini bozar.
- **Sentetik "aktivite oturumu" entity'si (Seçenek B, Karar 3'ün reddedilen alternatifi).** Reddedildi — `objects_view`'i şişirir, ADR-0003'ün Lumina Object modelinin amacıyla (kullanıcının gerçek iş nesneleri) gerilimli; kişi-kökü kenar türleri (`person-topic`/`person-time`) çok daha dar, mevcut şemayı bozmayan bir genişleme.
- **Ham pencere başlığı/takvim detayının sunucuya gönderilip orada filtrelenmesi.** Reddedildi — Karar (e)'ye göre; CLAUDE.md'nin "hassas veri sınıfları buluta ham gönderilmez" değişmezini doğrudan ihlal eder — türetme MUTLAKA masaüstü tarafında (Rust/frontend) yapılmalı, sunucu ham veriyi hiç görmemeli.
- **Cross-platform bir aktif-pencere soyutlaması (ör. `active-win` benzeri bir crate) baştan.** Reddedildi — Karar (f)'ye göre; ADR-0019'un Windows-only CI kapsamıyla tutarsız, ek bağımlılık/test yüzeyi getirir; macOS/Linux desteği Faz 3'e ertelendi.
- **Yeni komutu `capabilities/default.json`'a satır içi eklemek.** Reddedildi — Karar (g)'ye göre; ADR-0019 Karar (f)'nin sabitlediği sıfır-komut `default.json`'u değiştirir, en az ayrıcalık ilkesini görünmez kılar.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- CLAUDE.md'nin "hassas veri sınıfları buluta ham gönderilmez" değişmezi, ilk kez somut, test edilebilir, security-reviewer'ın denetleyebileceği bir kod-seviyesi listeye (Karar e) dökülüyor.
- "Dış masaüstü istemci → yeni domain event → event store" ingestion deseni ilk kez kuruluyor — F2-T4 ve Faz 3'ün Agent Runtime/Ambient Intelligence görevleri kendi ingestion yollarını icat etmek yerine bu emsali devralabilir.
- `ContextGraphSyncWorker` (ADR-0018) sayesinde `DesktopSignalCaptured` hiçbir ek kablolama olmadan en geç 5 saniye içinde bağlam grafiğine yansıyor — yeni bir tazelik mekanizması icat edilmedi.
- Event log şişmesi riski (Karar c) koddan önce, plan incelemesinde yakalanıp bağlayıcı bir test sözleşimine bağlandı.
- Rıza kendisi bir olay olarak modellendiği için (Karar a), "kim ne zaman rıza verdi/geri aldı" sorusu event log'dan (tek doğruluk kaynağı) denetlenebilir kalıyor.
- Rıza geri alındığında (Karar h.0), yalnızca gelecekteki toplama durmuyor — o kullanıcının o sinyal tipinden daha önce türetilmiş `person-topic`/`person-time` kenarları da GERİYE DÖNÜK siliniyor, başka kullanıcı/sinyal-tipine dokunmadan. Bu, "rızamı geri aldım" kullanıcı beklentisiyle grafiğin gerçek durumu arasındaki gizlilik tutarsızlığını koddan önce, plan incelemesinde kapatıyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- `DesktopSignalCaptured` yalnızca `ContextGraphSyncWorker`'ın 5 saniyelik döngüsüyle bağlam grafiğine yansıyor — read-your-writes garantisi YOK (ADR-0018'in zaten kabul ettiği sınırın doğal uzantısı).
- `topic` düğümlerinin doğal-anahtar uzayı masaüstü sinyalleriyle alan-değeri-bazlı konular arasında paylaşılıyor (Karar h.3) — string-eşleşme durumunda birleşme KASITLI kabul edildi, ayrı bir ad alanı icat edilmedi.
- macOS/Linux için aktif pencere desteği yok — Faz 3'e ertelendi, bilinçli kabul edilmiş bir sınır.
- Rust `get_active_window_app_name` komutunun kendisi CI'de otomatik test edilemiyor (gerçek Windows penceresi yok) — manuel/smoke-test'e dayanıyor, F2-T1/F2-T2/ADR-0019'un aynı türde dürüstçe kabul ettiği sınırla tutarlı.
- Genel bir "üçüncü taraf istemciden event ingestion" platformu kurulmuyor — bu ADR yalnızca iki dar sinyal tipi (`calendar-status`, `active-window`) için bir yol açıyor; F3-T12'nin (hibrit-AI/hassas-veri sınıflandırıcısı) genel motoru bu ADR'nin kapsamında değil, ayrı bir kararla ele alınacak.
