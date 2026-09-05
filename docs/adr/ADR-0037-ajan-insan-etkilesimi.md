# ADR-0037: Ajan-İnsan Etkileşimi — @mention, Yorum, DM ile Ajan Yeniden Yapılandırma (Epik F3-E1 Kapanışı)

**Durum:** Kabul edildi (Plan Mode oturumunda insan onayı zaten alındı — bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-05
**İlgili görev:** F3-T3 — Ajan-insan etkileşimi: @mention, görev atama, DM ile ajan yeniden yapılandırma. Spec dosyası: `docs/specs/F3-E1/F3-T3-ajan-insan-etkilesimi.md` (bu ADR ile paralel olarak `docs-writer` tarafından yazılır) — `docs/PLAN.md` §"Epik F3-E1: Agent Runtime + Skill SDK (Kapsam J)" satırı bu ADR'nin tek plan kaynağı.
**İlgili plan referansı:** `docs/PLAN.md`, FAZ 3, Epik F3-E1'in ÜÇÜNCÜ VE SON görevi (F3-T1/F3-T2/**F3-T3**'ten yalnızca F3-T3'ü kapsar) — bu görevin tamamlanmasıyla Epik F3-E1 kapanır. CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin her iki fıkrasını da tetikliyor: (i) yeni bir doğal-dil yetkilendirme ön-yüzü, "Mimari Değişmezler"in "Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar" maddesiyle ve mevcut öner→onayla disipliniyle (ADR-0015 soyu) doğrudan etkileşiyor; (ii) bu görevin Agent varlığı kalıcılık şekli ve senkron/asenkron sınırı, Epik F3-E2'nin (Cam Kutu Otonomi) doğrudan üzerine kuracağı bir kontrat.

> Bu ADR, ADR-0035'in (F3-T1, Ajan Çalışma Zamanı) ve ADR-0036'nın (F3-T2, Skill SDK v1) doğrudan mimari devamıdır. ADR-0035 §(e) ve ADR-0036 §(g), ikisi de bu görevi AÇIKÇA "ilk gerçek çağıran" olarak önceden işaret etmişti: `AgentPermissionManifestsService.checkPermission`/`AgentResourceLimitsService.executeAgentAction` (ADR-0035) ve `SkillExecutionService.executeSkill` (ADR-0036) bugüne kadar kendi modül testleri DIŞINDA sıfır gerçek çağırana sahipti — bilinçli, kabul edilmiş bir YAGNI riskiydi. Bu ADR o vaadi kapatır: bu üç fonksiyon artık gerçek, canlı bir tüketiciye sahip. **Bu ADR, ADR-0035'in sandbox/izin-manifestosu tasarımını ya da ADR-0036'nın imzalama/kayıt-defteri/`executeSkill`-sıralaması tasarımını yeniden AÇMAZ — ikisini de OLDUĞU GİBİ TÜKETİR.**
>
> Aşağıdaki (a)-(g) maddelerinden hiçbiri insana yeniden sorulmadı — Plan Mode oturumunda alınan 4 insan kararı (DM kapsamı, @mention yüzeyi, mention→aksiyon anlamı, Agent varlığının var olup olmayacağı) zaten aynen kayıt altına alınıyor; (b)-(g)'nin somut şekli bu ADR'nin kendi sorumluluğu olan architect-seviyesi tasarım detaylarıdır, onaylanan sınırlar içinde ADR adımında sonuçlandırılıyor (CLAUDE.md "Çalışma Ritüeli").

## Bağlam

Keşif, kod tabanında bu görevi doğrudan besleyen dört emsal ile bir açık soru ortaya koydu (tam dosya:satır referanslarıyla doğrulandı):

1. **`AgentActionType` hâlâ çıplak bir `string`** (`packages/agent-runtime/agent-permission-manifest.ts:16`) — ADR-0036 kapalı bir sözlük getirmedi, her beceri kendi id'sini `actionType` olarak kullanıyor. Bu görev aynı açık-string konvansiyonunu miras alır.
2. **`SkillExecutionService.executeSkill(workspaceId, agentIdentifier, skillId, input, objectType?)`** — grep ile doğrulandı: `apps/server/src/skills/`'in kendi modül bağlama/testleri DIŞINDA sıfır çağıranı var, hiçbir HTTP route yok. Bu görev bu servisin ilk gerçek çağıranı olacak.
3. **`CommandsService`'in olgun öner→onayla hattı** (`parse`/`proposeFromMeeting`/`proposeFromTrigger` → `recordProposal` → `decide` → `executeDecidedAction`'ın switch'i, F1-T16 temel + F2-T14 + F2-T15 ile 3 kez genişletilmiş) — `ProposedAction.type` birleşimi (`apps/server/src/ai/parse-command.ts:28-33`) ve `proposedActionSchema`'nın `z.enum([...])`'ı (satır 60-66) EŞ ZAMANLI genişletilmesi gereken TEK kaynak. `renderCommandPrompt`'un (satır 79) paylaşılan prompt metni yalnızca ilk 3 tipi listeler — `createTaskFromMeeting`/`createTaskFromTrigger` bu prompta HİÇ eklenmedi, her biri kendi özel extractor'ını (`extract-meeting-actions.ts`) kullandı.
4. **`AgentPermissionManifestsService.grant`/`.revoke`** (satır 95-160) — ikisi de `hasAtLeastRole(callerRole,'admin')`'ı KENDİ İÇİNDE kontrol eder (`ForbiddenError` fırlatır); yeni bir çağıran bu RBAC'ı bedava miras alır. `input.timeWindow.startsAt`/`expiresAt` gerçek `Date | null` — AI'dan gelen ISO string'lerin execute-anında `Date`'e parse edilmesi gerekir.
5. **`env.agentSandboxTimeoutMs` varsayılanı 30 saniye** (`apps/server/src/config/env.ts`) — `executeSkill`'in tam zinciri (rate-limit advisory-lock + concurrency-guard + sandbox + best-effort denetim) tek bir AI çağrısından ÇOK daha ağır. Bu, mention→beceri-çalıştırma akışının senkron OLAMAYACAĞININ somut sayısal gerekçesi.
6. **Kod tabanında sıfır mevcut altyapı** (kapsamlı grep ile doğrulandı): @mention ayrıştırma/render yok; Lumina Object'lerde yorum özelliği yok; bildirim/push/email teslimat kanalı yok; chat/DM şeması yok; kalıcı/adlandırılabilir bir Agent varlığı yok (bugün `agentIdentifier` yalnızca admin grant formuna elle yazılan çıplak string). Yjs işbirlikli doküman sistemi olgun ama mention-node taşımıyor — bu görev o sisteme dokunmaz.
7. 4-5 sabit sistem-actor'ü (`COMMAND_PARSER_ACTOR`, `TRIGGER_ENGINE_ACTOR`, `TRIGGER_SUGGESTION_ACTOR`, `MEETING_ACTION_EXTRACTOR_ACTOR`, `AI_GATEWAY_ACTOR`) ADR-0035 §(f)'nin kararıyla izin-manifestosu sistemine bilerek bağlanmadı — bu görevin konusu değil.

**İnsan kararları (Plan Mode oturumunda alındı, bu ADR onları icat etmiyor, aynen kayıt altına alıyor):**

1. DM kapsamı: her `(kullanıcı, ajan)` çifti için minimal, kalıcı, yalnızca uygulama-içi 1:1 mesaj dizisi (push/email/websocket teslimat YOK). Genel bir chat platformu değil.
2. @mention yüzeyi: Lumina Object'ler üzerinde amaca özel yeni bir yorum varlığı — mevcut Yjs zengin-metin doküman hattına hiç dokunulmaz.
3. Mention → aksiyon: bir nesnede bir ajanı @mention etmek `SkillExecutionService.executeSkill`'i o nesneye karşı tetikler. İnsan görev atama mekanizması (`people`-alanı/`executeAssignPeople`, `commands.service.ts:974-997`) tamamen ayrı ve etkilenmeden kalır.
4. Ajan kimliği: evet, minimal bir Agent varlığı eklenir — `{id, workspaceId, name, agentIdentifier, createdAt}`, avatar/zengin-yapılandırma UI'ı gerekmez.

Çözülmesi gereken merkezi soru (bu ADR'nin görevi): Agent varlığının kalıcılık şekli (b), yorum/@mention şemasının somut şekli ve mention-çözümleme zamanlaması (c), mention→beceri-çalıştırma akışının senkron mu asenkron mu olacağı ve somut kuyruk tasarımı (d), DM şemasının kalıcılık şekli ve senkron/asenkron sınırı (e), DM-tabanlı yeniden-yapılandırmanın mevcut öner→onayla hattıyla tam olarak nasıl kablolanacağı (f), ve bu görevin bilerek dışında bıraktığı kapsam (g).

## Karar

### (a) Çalışma zamanı tüketim modeli — F3-T1/F3-T2'nin ilk gerçek çağıranı, İKİSİNİN DE tasarımı yeniden açılmıyor

Bu görev, `AgentPermissionManifestsService.checkPermission`/`AgentResourceLimitsService.executeAgentAction`'ın (ADR-0035 §(e)'nin önceden işaret ettiği) VE `SkillExecutionService.executeSkill`'in (ADR-0036 §(g)'nin önceden işaret ettiği) ilk gerçek çağıranıdır. **Bu ADR, ADR-0035'in hafif sandbox/izin-manifestosu tasarımını ya da ADR-0036'nın Ed25519 imzalama/kanonikleştirme/`executeSkill` sıralama tasarımını yeniden AÇMAZ, TARTIŞMAZ, DEĞİŞTİRMEZ — ikisini de OLDUĞU GİBİ tüketir.** `executeSkill`'in kendi sabit sırası (kayıt-defteri araması → `checkPermission` → `executeAgentAction`) bu görevin her iki çağırma noktasında (mention-worker ve — dolaylı olarak, `grant`/`revoke` üzerinden — DM yeniden-yapılandırma) değiştirilmeden korunur.

**Gerekçe:** ADR-0035/ADR-0036'nın ikisi de kendi risklerini bilinçli olarak bu göreve ERTELEDİ, kendi tasarım sorularını ise KAPATTI. Bu görevin sorumluluğu o riski kapatmak (gerçek tüketici sağlamak), önceki iki ADR'nin zaten kararlaştırdığı mekanizma sorularını yeniden yargılamak değil.

### (b) Agent varlığı — düz event-sourced CRUD, `AutomationTriggersService`'i yansıtır, Lumina Object DEĞİL

Yeni tablo `agents`: `{id (ULID), workspaceId, name, agentIdentifier, lifecycle: 'active'|'deactivated', createdAt}`.

- `name`: handle-karakter kümesiyle SINIRLI, `^[A-Za-z0-9_-]{2,32}$`, workspace içinde case-insensitive benzersiz. `agentIdentifier`: workspace içinde benzersiz.
- Olaylar: `STREAM_TYPE='agent'`, her yeni ajan için TAZE `randomUUID()` stream — `AgentPermissionManifest`'in `(workspaceId, agentIdentifier)` kompozit-anahtarlı DETERMİNİSTİK stream'inin AKSİNE, Agent tekil, taze-basılan bir kimlik, bir toggle DEĞİL. `AgentRegistered{agentId, workspaceId, name, agentIdentifier}`, `AgentDeactivated{agentId}`.
- `AgentDirectoryService` (`apps/server/src/agent-runtime/agent-directory.service.ts`): `register` (admin+, isim/identifier çakışmasında `ConflictError`), `deactivate` (admin+), `list` (member+, yalnızca `active`), `resolveByName` (RBAC'sız, dahili — `checkPermission`'ın "dahili okuma noktası" konvansiyonunu yansıtır).

**Gerekçe (neden Lumina Object değil):** Agent bir dizin/yapılandırma varlığı — `AutomationTriggers`/`WebhookSubscriptions`'ın kategorisinde. `ObjectsService.create`'in alan-tanımı-kayıt-defteri/başlık-zorunluluğu/arama-indeksleme makinesini 4 alanlık bir yapılandırma satırı için sürüklemek gereksiz kapsam olurdu — kullanıcı İÇERİĞİ değil, bir dizin girişi.

**Kayıt ve yetki verme BİLEREK AYRI admin+ adımlardır — atomik birleşik bir işlem YOKTUR.** Gerekçe: bu kod tabanında cross-aggregate transaction primitifi yok (`CommandsService.decide` bile `partially_executed` durumunu kabul ediyor); bir Agent kaydı manifestosuz da ZARARSIZDIR — `checkPermission` `false` döner, `executeSkill` 403 ile reddeder. Frontend (PR7) UX kolaylığı için ardışık iki çağrı yapabilir ama backend'de tek bir atomik "kaydet+yetkilendir" adımı İCAT EDİLMEZ.

### (c) Yorum/@mention şeması — yorum-başına TAZE stream, mention çözümlemesi yaratma-anı SNAPSHOT'ı

Yeni tablo `object_comments`: `{id, workspaceId, objectId, authorActor, body, mentionedAgentIds (string[]), createdAt}`, indeks `(workspaceId, objectId, createdAt)`.

- Olaylar: `STREAM_TYPE='object-comment'`, YORUM-BAŞINA taze stream (nesnenin KENDİ stream'ine EKLENMEZ) — `CommentAdded{commentId, workspaceId, objectId, body, mentionedAgentIds}`.

**Gerekçe (neden nesnenin kendi stream'i değil):** Yorumlar yüksek-hacimli, append-only ve nesne alan-durumunu yeniden inşa etmek için asla field-value event'leriyle BİRLİKTE replay edilmesi gerekmez. Yorumu nesnenin kendi stream'ine eklemek, meşgul bir nesnede yorum-ekleme ile ilgisiz alan-değeri düzenlemeleri arasında SAHTE optimistic-concurrency versiyon çakışmaları yaratırdı — iki bağımsız yazma yolu aynı stream versiyonu için yarışırdı.

Mention çözümlemesi SABİT bir regex, `/@([A-Za-z0-9_-]{2,32})\b/g`, `body` üzerinde YORUM-YARATMA ANINDA çalıştırılır ve her aday handle `AgentDirectoryService.resolveByName`'e karşı çözülür. **Çözülen `mentionedAgentIds` olay payload'ına gömülen bir SNAPSHOT'tır — CANLI/dinamik bir referans DEĞİL.** Gerekçe: denetim-doğruluğu — bir Agent'ın SONRADAN yeniden adlandırılması veya devre dışı bırakılması, geçmiş bir yorumun "neyi mention ettiğini" söylediği şeyi GERİYE DÖNÜK değiştiremez. Eşleşmeyen `@handle`'lar SESSİZCE yok sayılır (`applyAssigneeHint`'in "en-iyi-çaba, ana aksiyonu asla durdurma" emsalini yansıtır) — bir yorum bir yazım hatası içeren handle yüzünden ASLA reddedilmez.

### (d) Mention → beceri çalıştırma — ASENKRON, claim-tabanlı bir kuyruk worker'ı ile, satır-içi/senkron DEĞİL

**Somut gerekçe:** `env.agentSandboxTimeoutMs` varsayılanı 30 saniye — `executeSkill`→`executeAgentAction`'ın tam zinciri (hız-sınırı advisory-lock + eşzamanlılık-muhafızı + sandbox + best-effort denetim) tek bir AI çağrısından NİTELİKSEL olarak daha ağır. Yorum-oluşturma HTTP yanıtını buna bloke etmek — N mention edilen ajan için ÇARPILMIŞ — bununla yapısal olarak ilgisiz bir şey (yorum yazma) için UX'i bozardı.

Tasarım, `WebhookDeliveryWorker`'ı BİREBİR yansıtır:

- Yeni kuyruk tablosu `mention_actions` — yorum satırından AYRI (`webhook_deliveries`'in `webhook_subscriptions`'tan ayrı olmasının aynı gerekçesi: bir yorum birden fazla ajanı mention edebilir, HER BİRİ bağımsız retry/backoff durumu gerektirir): `{id, workspaceId, commentId, objectId, objectType, agentIdentifier, status, attempts, nextAttemptAt, claimedUntil, lastError, replyCommentId}`.
- `MentionActionWorker`, `WebhookDeliveryWorker`'ın lease-UPDATE `claimRow` desenini BİREBİR kullanır — çakışan worker tick'lerinde ÇİFT-İŞLEME'yi önlemek için. Her claim edilen satır KENDİ `try/catch`'i içinde işlenir — bir satırın hatası taramayı durdurmaz.
- Başarı yolu: `question = "Regarding \"${object.title}\": ${comment.body}"` kurulur, `SkillExecutionService.executeSkill(workspaceId, agentIdentifier, 'answer-question', {question}, objectType)` çağrılır → `outcome:'success'` → `actor={type:'agent',id:agentIdentifier}` ile YENİ bir `ObjectComment` (ajanın yanıtı) oluşturulur, satır `done` işaretlenir.
- Hata dalları AYRI: `outcome:'timeout'|'failure'` → backoff ile retry (max-attempts tavanına kadar). **`ForbiddenError` (ajanın manifestosu yok/devre dışı) DOĞRUDAN `failed`'e gider, RETRY EDİLMEZ** — bir izin reddi retry ile ASLA düzelmez, geçici bir timeout/hata ise düzelebilir; bu ikisi kasıtlı olarak farklı hata-işleme dalları.

**Hangi beceri çağrılır: v0'da SABİT `answer-question`.** `parse-command`'a yönlendirilmez — bu ikinci bir `decide()` adımı gerektirirdi, "mention beceri çalıştırmayı doğrudan tetikler" insan kararıyla çelişirdi. `answer-question`, 20 beceri içinde doğrudan insan-okunur bir metin yanıtı üretmek için tasarlanmış TEK beceridir — diğer beceriler (`parse-command` dahil) ya durum mutasyonu yapar ya da insanın `decide()` adımına ertelenir, "mention → doğrudan yanıt" şekline uymaz. Mention edilen nesnenin başlığı/tipı SORU METNİNE kompoze edilir (ayrı bir `ContextService.getContext` çağrısı EKLENMEZ). `objectType` HER ZAMAN `executeSkill`'e geçirilir — manifestonun `dataScope.objectTypes` boyutunun GERÇEKTEN uygulanması için.

### (e) DM mesaj şeması — deterministik-anahtarlı tek stream, `send` UÇTAN UCA SENKRON

Yeni tablo `dm_messages`: `{id, workspaceId, userId, agentIdentifier, sender:'user'|'agent', body, proposalId (nullable), createdAt}`, `STREAM_TYPE='direct-message'`. `MemoryAccessPolicyService`'in `streamIdFor`/ADR-0024'ün 3-parçalı `(workspaceId, userId, agentIdentifier)` deterministik anahtar emsalini yansıtan TEK stream per üçlü — ama MemoryAccessPolicy'nin 2-durumlu toggle'ının AKSİNE, bu stream ÇOK sayıda sıralı mesaj biriktirir (`AutomationTriggersService`'in tek-stream-çok-olay şekline daha yakın, yalnızca deterministik anahtarlanmış).

`DirectMessagesService.send(workspaceId, actor, callerRole, agentIdentifier, body)` (member+) UÇTAN UCA SENKRONDUR — Karar (d)'nin aksine. **Gerekçe:** DM yanıt yolu `AIUsageService.withWorkspaceAILock` altında TEK bir AI-sağlayıcı çağrısı yapar (bugün zaten senkron çalışan `CommandsService.parse()` HTTP rotasıyla AYNI şekil) — `executeAgentAction`'ın sandbox/hız-sınırı/eşzamanlılık katmanlarına HİÇ dokunmaz. Karar (d)'nin asenkron-ayrıştırma gerekçesi (30sn zaman-aşımı + ağır zincir + N-çarpımı) burada UYGULANMAZ.

`.list(workspaceId, userId, agentIdentifier, callerRole)` (member+, YALNIZCA `req.user.id === userId`; admin+ herhangi bir kullanıcının dizisini okuyabilir — denetim amaçlı).

### (f) DM/yorum, MEVCUT öner→onayla hattı üzerine bir doğal-dil ön-yüzdür — YENİ bir yetkilendirme yolu DEĞİL (bu ADR'nin en yük taşıyan değişmezi)

`CommandsService.ProposedAction`'ın tip birleşimine TEK yeni üye eklenir: `'reconfigureAgentPermissions'` (params: `{agentIdentifier, operation:'grant'|'revoke', dataScope?, actionTypes?, timeWindow?}`) — `proposedActionSchema`'nın `z.enum([...])`'ıyla EŞ ZAMANLI genişletilir. Bu iki liste (`apps/server/src/ai/parse-command.ts` içindeki TS union ve zod enum) AYNI dosyada yaşayan iki BAĞIMSIZ literal liste — daha önce doğrulanmış, gerçek bir ayak tuzağı: biri genişletilip diğeri unutulursa runtime doğrulama derleme-zamanı tipiyle SESSİZCE ıraksar. Bu ADR bu iki listenin HER ZAMAN birlikte genişletileceğini bir değişmez olarak kaydeder.

Bu yeni tip için PAYLAŞILAN `parseCommand`'ın prompt metni (`renderCommandPrompt`) GENİŞLETİLMEZ/DOKUNULMAZ — bunun yerine YENİ, özel bir extractor (`extractDirectMessageReconfiguration.ts`) yazılır, `extract-meeting-actions.ts`'i BİREBİR yansıtır. **Bu icat edilen bir desen değil, kod tabanının ZATEN kurulu konvansiyonudur:** `createTaskFromMeeting`/`createTaskFromTrigger` de HİÇBİR ZAMAN paylaşılan prompta eklenmedi, ikisi de kendi özel extractor'ını kullandı — doğrudan dosya okunarak doğrulandı (`renderCommandPrompt` yalnızca ilk 3 tipi listeliyor).

`CommandsService.proposeFromDirectMessage(workspaceId, actor, callerRole, agentIdentifier, dmMessageText)`, AI çağrısından/olay yazmadan ÖNCE `hasAtLeastRole(callerRole, 'admin')` kontrolü yapar — admin değilse, AI extractor'a HİÇ gidilmeden, KANITLANMIŞ bir ret metniyle kısa devre yapılır (SIFIR AI-sağlayıcı çağrısı, SIFIR proposal olayı yazılır). **Gerekçe:** AI kotasını onaylanamayacak isteklere harcamamak, ve bir member'ın "ajana kendine daha fazla erişim ver desem ne olur" şeklinde prob yapmasını engellemek.

`decide()`-anında, `executeDecidedAction`'ın switch'ine YENİ bir `case 'reconfigureAgentPermissions'` (→ `executeReconfigureAgentPermissions`) eklenir — `AgentPermissionManifestsService.grant`/`.revoke`'u GERÇEK KARAR VEREN ADMİNİN GERÇEK `actor`/`callerRole`'üyle çağırır, ASLA sabit bir sistem/ajan actor'üyle değil. `grant`/`revoke` KENDİ İÇİNDE zaten admin+ kontrolü yaptığından, yeni execute metodunda YİNELENEN bir RBAC kontrolü YAZILMAZ (gereksiz).

**Bu, ADR-0034'ün (F2-T17) zaten kurduğu iki-katmanlı savunma desenin BİREBİR TEKRARIDIR — burada YENİDEN İCAT EDİLMİYOR:** AI-yazımı bir öneri TEK BAŞINA yeterli yetki olarak ASLA güvenilmez; gerçek üretim servisi (`grant`/`revoke`), gerçek insanın kimliğiyle çağrılarak aksiyonu gerçekten yürütür (ADR-0034 §(f)'nin "yanıt zod şeması iş-kuralı doğrulamasının YERİNE GEÇMEZ" / §(g)'nin "actor HER ZAMAN gerçek insan, ASLA AI" ilkelerinin doğrudan devamı).

**Açıkça karara bağlanan ek nokta: gerçek `decide()`/onay adımı MEVCUT Command Proposals listesi/decide UI'ı (F2-T16) üzerinden olur — v1'de DM-yanıtından "evet"/"onayla" ayrıştıran bir decide-kısayolu KASITLI OLARAK YOK.** Gerekçe: bu, governance-hassas bir aksiyona İKİNCİ, daha az görünür bir onay yüzeyi eklemekten kaçınır — tek onay noktası, tek denetlenebilir UI kalır.

### (g) Kapsam dışı (açık, ileriye dönük yanlış varsayımları önlemek için)

- **Hiçbir bildirim kanalı yok:** push, e-posta, websocket teslimatının hiçbiri yok — DM/yorumlar yalnızca UI açılarak okunur.
- **Yjs işbirlikli zengin-metin doküman hattı TAMAMEN dokunulmadan kalır** — mention'lar SADECE yeni yorum özelliğinde yaşar, mevcut doküman sistemine mention-node eklenmez.
- **İnsan görev atama (`executeAssignPeople`/`people`-alanı) TAMAMEN DEĞİŞMEDEN kalır** — bir ajanı @mention etmek görevi ONA ASLA ATAMAZ, yalnızca harekete geçmesini tetikler.
- **4-5 mevcut sabit sistem-actor'ü (`COMMAND_PARSER_ACTOR` vb.) bunlardan HİÇBİRİNE retrofit EDİLMEZ** — ADR-0035 §(f)'nin AYNI non-goal'üyle tutarlı: bugün prodüksiyonda çalışan orkestratörler bu görevin konusu değil.
- **Mention'lar için `answer-question` dışında beceri-ayırt-etme/yönlendirme mantığı YOK** — v0'da mention her zaman TEK sabit beceriye gider.

## Somut Şekiller

```ts
// packages/agent-runtime (veya apps/server/src/agent-runtime) — Agent varlığı
export interface Agent {
  id: string;
  workspaceId: string;
  name: string; // ^[A-Za-z0-9_-]{2,32}$, workspace içinde case-insensitive benzersiz
  agentIdentifier: string; // workspace içinde benzersiz
  lifecycle: 'active' | 'deactivated';
  createdAt: Date;
}

// object_comments
export interface ObjectComment {
  id: string;
  workspaceId: string;
  objectId: string;
  authorActor: Actor;
  body: string;
  mentionedAgentIds: string[]; // yaratma-anı SNAPSHOT, canlı referans DEĞİL
  createdAt: Date;
}

// mention_actions — webhook_deliveries'in claim-tabanlı kuyruk şeklini yansıtır
export interface MentionAction {
  id: string;
  workspaceId: string;
  commentId: string;
  objectId: string;
  objectType: string;
  agentIdentifier: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  nextAttemptAt: Date | null;
  claimedUntil: Date | null;
  lastError: string | null;
  replyCommentId: string | null;
}

// dm_messages — deterministik stream anahtarı: streamIdFor(workspaceId, userId, agentIdentifier)
export interface DirectMessage {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  sender: 'user' | 'agent';
  body: string;
  proposalId: string | null;
  createdAt: Date;
}
```

**RBAC özeti:** Agent kayıt/devre-dışı = admin+; Agent listele = member+; Yorum oluştur/listele = member+; Mention→beceri çalıştırma yetkisi = ajanın KENDİ manifestosu (yorumlayan insanın rolü DEĞİL, sistem-güdümlü); DM gönder/kendi dizisini oku = member+ (yalnızca `req.user.id === userId`); DM başkasının dizisini oku (denetim) = admin+; DM yeniden-yapılandırma ÖNERME = admin+ (AI çağrısından ÖNCE kontrol edilir); DM yeniden-yapılandırma KARAR VERME = admin+ (zaten `grant`/`revoke` içinde uygulanır).

## Gelecek Görevlere İleriye Dönük İlişki

Bu ADR, Epik F3-E1'i (Agent Runtime + Skill SDK) KAPATIR. Burada kurulan iki somut şekil, Epik F3-E2'nin (Cam Kutu Otonomi: F3-T4 gerekçe kaydı/denetim izi, F3-T5 otonomi kadranı, F3-T6 tek-tık geri alma) doğrudan üzerine kuracağı temeldir: (1) Agent varlığının kalıcılık şekli (Karar b) — F3-T4/F3-T6'nın "hangi ajan aksiyonu, hangi kimlik altında" sorusunun cevaplandığı yer; (2) senkron (DM/AI-tekli-çağrı) ile asenkron (mention/sandbox-zincirleri) çalıştırma arasındaki sınır (Karar d/e) — F3-T4/T6'nın "bir aksiyon ne zaman kalıcı/geri-alınabilir hale gelir" sorusu TAM OLARAK bu sınıra bağlıdır. En önemlisi, F3-T5'in otonomi kadranı MUHTEMELEN `decide()`'ı BYPASS ETMEYİ değil, NE ZAMAN gerekli olduğunu (ör. düşük-riskli aksiyonlarda otomatik onay) DEĞİŞTİRMEYİ isteyecektir — bu, ancak `decide()` TEK boğaz noktası olarak ŞİMDİ (Karar f) sabitlenmişse temiz çalışır. Karar (f) bu yüzden yalnızca bu görevin değil, gelecek Epik'in de mimari ön koşuludur.

## Alternatifler ve Reddedilme Gerekçeleri

- **ADR-0035/ADR-0036'nın sandbox/imzalama/`executeSkill`-sıralama tasarımını bu görevde yeniden gözden geçirmek.** Reddedildi (Karar a) — ikisi de kendi tasarım sorularını ZATEN kapattı; bu görevin sorumluluğu tüketmek, yeniden tasarlamak değil.
- **Agent'ı bir Lumina Object olarak inşa etmek.** Reddedildi (Karar b) — bir dizin/yapılandırma varlığı için `ObjectsService`'in alan-tanımı-kayıt-defteri/arama-indeksleme makinesi gereksiz kapsam; `AutomationTriggers`/`WebhookSubscriptions` kategorisiyle aynı.
- **Agent kaydı + yetki verme'yi tek atomik admin adımı yapmak.** Reddedildi (Karar b) — kod tabanında cross-aggregate transaction primitifi yok; manifestosuz bir Agent zaten zararsız, atomiklik gerçek bir güvenlik ihtiyacı değil.
- **Yorumu, üzerinde olduğu nesnenin kendi event stream'ine eklemek.** Reddedildi (Karar c) — yüksek-hacimli append-only yorum yazmaları ile ilgisiz alan-değeri düzenlemeleri arasında sahte optimistic-concurrency versiyon çakışmaları yaratırdı.
- **Mention'ları CANLI/dinamik olarak (yorum okunduğunda) yeniden çözmek.** Reddedildi (Karar c) — denetim-doğruluğunu bozardı: bir Agent'ın sonradan yeniden adlandırılması/devre dışı bırakılması geçmiş bir yorumun anlamını geriye dönük değiştirirdi.
- **Mention→beceri çalıştırmayı yorum-oluşturma isteğinde SATIR-İÇİ/senkron yapmak.** Reddedildi (Karar d) — 30 saniyelik sandbox zaman-aşımı + ağır izin/hız-sınırı zinciri, N-mention ile çarpılınca yorum-oluşturma UX'ini AI gecikmesi altında bozardı.
- **Kuyruk durumunu yorum satırına sütun olarak eklemek (ayrı `mention_actions` tablosu yerine).** Reddedildi (Karar d) — bir yorum birden fazla ajanı mention edebilir, her biri BAĞIMSIZ retry/backoff durumu gerektirir; `webhook_deliveries`'in `webhook_subscriptions`'tan ayrı olmasının aynı gerekçesi.
- **Mention'ı `parse-command`'a yönlendirmek.** Reddedildi (Karar d) — bu ikinci bir `decide()` adımı gerektirirdi, "mention beceri çalıştırmayı DOĞRUDAN tetikler" insan kararıyla çelişirdi.
- **İzin-reddi (`ForbiddenError`) hatalarını retry etmek.** Reddedildi (Karar d) — bir izin reddi retry ile ASLA düzelmez; geçici hata/timeout'tan yapısal olarak farklı bir dal gerektirir.
- **DM yanıt yolunu da (mention gibi) asenkron kuyruğa almak.** Reddedildi (Karar e) — DM yalnızca TEK bir AI-sağlayıcı çağrısı yapar, `executeAgentAction`'ın ağır sandbox/hız-sınırı zincirine hiç girmez; asenkron-ayrıştırmanın gerekçesi burada uygulanmaz.
- **`reconfigureAgentPermissions` için paylaşılan `parseCommand` prompt'unu genişletmek.** Reddedildi (Karar f) — kod tabanının kurulu konvansiyonu (her yeni aksiyon-üreten yüzey kendi özel extractor'ını alır: `extract-meeting-actions.ts` emsali) ihlal edilirdi.
- **DM yanıtından "evet"/"onayla" ayrıştıran bir decide-kısayolu eklemek.** Reddedildi (Karar f) — governance-hassas bir aksiyona ikinci, daha az görünür bir onay yüzeyi eklerdi; mevcut Command Proposals UI'ı (F2-T16) tek onay noktası olarak kalmalı.
- **`executeReconfigureAgentPermissions`'a yinelenen bir admin RBAC kontrolü eklemek.** Reddedildi (Karar f) — `grant`/`revoke` KENDİ İÇİNDE zaten admin+ zorunlu kılıyor; yinelemek gereksiz kod ve iki bağımsız RBAC-kontrol noktasının ıraksama riski yaratırdı.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** `agents`, `object_comments`, `dm_messages` hepsi kendi olay akışlarının (`AgentRegistered`/`AgentDeactivated`, `CommentAdded`, DM mesaj olayları) salt projeksiyonlarıdır. `mention_actions` bunun İSTİSNASI DEĞİL ama farklı bir kategoridedir — `webhook_deliveries`'in AYNI şekilde, o da olay-kaynaklı bir projeksiyon değil, OPERASYONEL işleme/retry durumu tutan bir kuyruk tablosudur; mention'ın GERÇEK domain sonucu (ajanın yanıt yorumu) yine `CommentAdded` olayı üzerinden olay-kaynaklıdır.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu ADR bu sözleşmeyi DEĞİŞTİRMEZ — mention→beceri çalıştırma `executeSkill`'in izin-kontrolü→kaynak-sınırlı-çalıştırma sırasını (ADR-0036 §f) değiştirmeden kullanır; niyet/gerekçe/kaynak/geri-alma-planı alanlarının somut kaydı F3-T4'ün (Cam Kutu Otonomi) kapsamıdır.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR hiçbir export uç noktasına dokunmuyor.
- **Hassas veri sınıflarının buluta ham gönderilmemesi.** DM/yorum gövdelerinin AI-sağlayıcıya gönderilmesi, MEVCUT `answerQuestion`/`parse()` çağrı yollarıyla AYNI ai-gateway rotasını izler — bu ADR yeni bir ham-bulut-gönderim yolu İCAT ETMEZ; sınıflandırma/yönlendirme mantığına dokunmak F3-T12'nin (Hibrit AI) kapsamıdır.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- ADR-0035 §(e) ve ADR-0036 §(g)'nin önceden işaret ettiği "ilk gerçek çağıran" vaadi ÜÇ fonksiyon için de (checkPermission/executeAgentAction/executeSkill) kapandı.
- Agent, `ObjectsService`'in tüm makinesini sürüklemeden @mention UX'i için adreslenebilir bir kimlik kazandı.
- ADR-0034'ün (F2-T17) iki-katmanlı savunma deseni, ÜÇÜNCÜ bir governance-hassas alana (doğal-dilden ajan izin yeniden-yapılandırması) YENİDEN İCAT EDİLMEDEN genişletildi — `decide()` tek boğaz noktası olarak korundu.
- Senkron/asenkron sınır (Karar d/e) için ikinci somut, kanıtlanmış bir emsal daha eklendi (`WebhookDeliveryWorker`'ın claim-tabanlı kuyruğu + `AIUsageService`'in senkron-tekli-çağrı şekli) — Epik F3-E2 bu ikiden hangisinin ne zaman uygulanacağını devralır.

**Neyi erteliyoruz / kabul ediyoruz:**

- Hiçbir bildirim kanalı yok (Karar g) — insan mention/DM yanıtını görmek için UI'ı açmalı; gerçek bir bildirim ihtiyacı doğarsa ayrı bir gelecek görev/ADR gerektirir.
- Agent kayıt+yetki-verme iki ayrı admin adımı kalır (Karar b) — atomik bir "tek tık" UX'i frontend'in (PR7) ardışık çağrılarla köprülemesi gereken bir sınırlama, backend'de icat edilmedi.
- `mention_actions`'ın retry/backoff/max-attempts sabitleri bu ADR'nin kapsamı DIŞINDA, implementer-seviyesi ayrıntıdır — `webhook-delivery-worker.service.ts`'nin mevcut sabitlerinden ilham alınır, burada yeniden tartışılmaz.
- DM-üzerinden-decide kısayolunun v1'de olmaması (Karar f) kasıtlı bir kapsam sınırlamasıdır — gerçek bir kullanıcı-deneyimi ihtiyacı doğarsa, İKİNCİ bir onay yüzeyinin denetlenebilirlik ödünleşimini AÇIKÇA tartışan ayrı bir ADR gerektirecektir.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E1/F3-T3-ajan-insan-etkilesimi.md`) `docs-writer` ile paralel yazılıyor. Bu ADR'nin onayı üzerine PR1'e (`agents` dizini, backend) `test-writer` ile başlanır:

```
docs/adr/ADR-0037-ajan-insan-etkilesimi.md'deki Karar (a)-(g)'yi ve
docs/specs/F3-E1/F3-T3-ajan-insan-etkilesimi.md'nin Kabul Kriterleri'ni temel alarak, F3-T3
PR1 (Agent dizini varlığı: agents tablosu+migration, AgentDirectoryService
register/deactivate/list/resolveByName, projeksiyon, controller) için test-writer ile
başarısız testleri yaz.
```
