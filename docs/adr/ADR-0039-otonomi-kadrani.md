# ADR-0039: Otonomi Kadranı — Öner / Onayla-Yap / Yap-Bildir (Görev Tipi Başına Kullanıcı Ayarı, Epik F3-E2 Devamı)

**Durum:** Kabul edildi (karma-kademe geri düşüşü [Karar g] ve yap-bildir'in `decide()`'ı TAMAMEN atladığı [Karar e] insan tarafından açıkça onaylandı; `reconfigureAgentPermissions`'ın kadrana tabi olmaması [Karar c] mimarinin KENDİ çıkarımı — aşağıda ayrıca işaretlendi, insan tarafından dikte edilmedi.)
**Tarih:** 2026-09-08
**İlgili görev:** F3-T5 — Otonomi kadranı: öner / onayla-yap / yap-bildir, görev tipi başına kullanıcı ayarı. `docs/PLAN.md` FAZ 3, Epik F3-E2 (Cam Kutu Otonomi, Kapsam K), F3-T4'ten (ADR-0038) sonraki görev.
**İlgili plan referansı:** `docs/PLAN.md` satır 282. CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin her iki fıkrasını da tetikliyor: (1) `decide()`'ın ADR-0037'de sabitlenen "tek boğaz noktası" Kararı ile doğrudan gerilim yaratıyor (ne zaman/nasıl bypass edilebileceğini tanımlıyor), (2) birden fazla `CommandsService` çağıranına (`parse`/`proposeFromMeeting`/`proposeFromTrigger`/`proposeFromDirectMessage`) dayatılan yeni bir yönlendirme sözleşmesi tanımlıyor.

> Bu ADR, ADR-0037'nin (F3-T3) ve ADR-0038'in (F3-T4) doğrudan mimari devamıdır. ADR-0038'in Bağlam bölümü bu görevi zaten işaret etmişti: "F3-T5'in gelecekteki otonomi kadranı muhtemelen `decide()`'ı BYPASS ETMEYİ değil, NE ZAMAN gerekli olduğunu DEĞİŞTİRMEYİ isteyecektir." **Bu ADR o tahmini KISMEN doğrular, kısmen keskinleştirir: `onayla-yap` kademesi gerçekten "ne zaman" sorusuna cevap verir (decide() hâlâ çalışır, yalnızca otomatik tetiklenir); ama `yap-bildir` kademesi BİLİNÇLİ OLARAK `decide()`'ı TAMAMEN ATLAR — bu, iki kademe arasındaki AYIRT EDİCİ özelliğin ta kendisidir (insan tarafından açıkça onaylandı, aşağıda Karar e/g).** `decide()`'ın kendisi bu ADR'de TEK SATIR DEĞİŞTİRİLMEZ.

## Bağlam

`docs/PLAN.md` satır 282 üç kademe tanımlıyor: **öner** (mevcut davranış — bir insan `decide()` çağırana kadar bekler), **onayla-yap** (sistem otomatik onaylar, `decide()` üzerinden, sonra yürütür), **yap-bildir** (önce yürütür, `decide()`'a hiç uğramadan, sonra bildirir). Kademe, `ProposedAction.type`'a (`apps/server/src/ai/parse-command.ts:28-34`: `createTask|generateSubtasks|assignPeople|createTaskFromMeeting|createTaskFromTrigger|reconfigureAgentPermissions`) göre, workspace başına ayarlanır.

Bugünkü akış (doğrudan kod okunarak doğrulandı):

1. Dört `propose*` metodu (`CommandsService.parse` satır 342, `.proposeFromMeeting` satır 395, `.proposeFromTrigger` satır 452, `.proposeFromDirectMessage` satır 489) hepsi PAYLAŞILAN `recordProposal` (satır 564) üzerinden TEK bir `ActionsProposed` olayı yazar — `parse()`'ın kendi doc-yorumu bunu "ALWAYS appends exactly one `ActionsProposed` event per call" olarak sabitliyor.
2. `decide()` (satır 634) bir `proposalId` üzerinde YALNIZCA BİR KEZ çağrılabilir — `command_proposals.decidedAt` (satır 660-662: `if (row.decidedAt !== null) throw ConflictError`) bunu zorluyor. Kritik gözlem: `decide()`'a verilen `decisions: DecisionInput[]` dizisinin proposal'ın TÜM `actionId`'lerini kapsaması ZORUNLU DEĞİL — hangi alt-küme gönderilirse gönderilsin, `ActionsDecided` olayı yazılır yazılmaz `decidedAt` TÜM SATIR için kalıcı olarak set edilir, ve HİÇBİR gelecekteki `decide()` çağrısı aynı `proposalId` için asla mümkün olmaz. Yani **bu kod tabanında "bir proposal'ın parçasını şimdi, parçasını sonra karara bağlama" diye bir şey zaten YOK** — `decide()` doğası gereği "tüm-ya-da-hiç, tek atış" bir tasarım.
3. `parse()`'ın `_actor` parametresi (satır 344) bugün ALT ÇİZGİLİ (kullanılmıyor) — kendi doc-yorumu "used only for future authorization concerns" diyor; bu ADR onu YİNE kullanmaz (Karar h'de gerekçesi var), yani bu ADR'den SONRA da açık kalan bir gelecekteki genişletme noktası olarak işaretlenir.
4. ADR-0037 §f, `decide()`'ın "governance-hassas/geri-alınabilir-izin-veren aksiyonlar için TEK boğaz noktası" kalması gerektiğini AÇIKÇA sabitledi — özellikle `reconfigureAgentPermissions` (`executeReconfigureAgentPermissions`, `AgentPermissionManifestsService.grant`/`.revoke`'u çağırır) için.
5. `AgentActionRecordsService.record` (ADR-0038, `apps/server/src/agent-runtime/agent-action-records.service.ts:97`) ZATEN `provenance:'autonomous'` + `causationEventId: null` şeklini destekliyor — bugünkü TEK çağıranı `MentionActionWorker` (ADR-0038 §d), ama şekil KENDİSİ genel: "bu yolda böyle bir `ActionsDecided` olayı YOK" ifadesi zaten herhangi bir "ikinci insan onayı adımı olmayan, `decide()`'ı hiç görmeyen" yürütme için geçerli, sadece mention-tetiklemesine özgü değil. **Bu ADR'nin yap-bildir yolu tam olarak bu şekli, ikinci bir çağıran olarak, DEĞİŞTİRMEDEN kullanır.**
6. `MentionActionWorker.runOnce()` başarı yolunda `this.commentsService.create(workspaceId, {type:'agent',id:agentIdentifier}, 'member', {objectId, body})` (satır 174-179) ile bir yorum-yanıtı YAZARAK insana "bildirim" veriyor — bu kod tabanında AYRI bir bildirim/notification alt sistemi YOK, tek emsal budur.

**Çözülmesi gereken merkezi soru:** üç kademenin nerede yaşayacağı (a), somut ayar-varlığının şekli (b), `reconfigureAgentPermissions` için sabit bir yönetişim tabanı gerekip gerekmediği (c), üç kademenin `parse()`'ın çıktısını NASIL yönlendireceği (d), yap-bildir'in NASIL yürütüleceği — `decide()`'a HİÇ uğramadan (e), onayla-yap'ın NASIL yürütüleceği — `decide()` üzerinden, otomatik tetiklenerek (f), **AYNI `parse()` çağrısından gelen karma kademeli bir grubun NASIL ele alınacağı (g, insan tarafından ÖNCEDEN karara bağlandı, bu ADR yalnızca biçimlendirir)**, "bildir" adımının somut mekanizması (h), okuma/yazma RBAC'ı (i).

## Karar

### (a) Yerleşim — ADR-0038'in AYNI ikili bölünmesi genişletilir, yeni paket YOK

Saf tipler `packages/agent-runtime/src/autonomy-tier.ts` (+ olay şeması `autonomy-tier-events.ts`, `index.ts`'ten dışa aktarım); servis-katmanı `apps/server/src/agent-runtime/autonomy-tier-settings.service.ts` — `AgentPermissionManifestsService`/`AgentActionRecordsService` ile AYNI dizin/bölünme deseni (ADR-0038 §a'nın DOĞRUDAN devamı, üçüncü kez tekrarı gerekçeli: "ajan çalışma zamanı davranışı" kategorisinin bir parçası, ÜÇÜNCÜ kez bağımsız bir paket açmak yerine).

### (b) `AutonomyTier` + `TaskAutonomySetting` — event-kaynaklı, deterministik-anahtarlı, varsayılan `'propose'`

```ts
export type AutonomyTier = 'propose' | 'approve_and_act' | 'act_and_notify';

/** Yalnızca "bu kademe insan onayını ATLAR mı" karşılaştırması için — bir iş
 * kuralı hiyerarşisi değil, `propose`'un TEK ayrık durum olduğunu ifade
 * etmenin bir yolu. */
export const AUTONOMY_TIER_RANK: Record<AutonomyTier, number> = {
  propose: 0,
  approve_and_act: 1,
  act_and_notify: 2,
};

export function isAutoDecidable(tier: AutonomyTier): boolean {
  return tier !== 'propose';
}

export interface TaskAutonomySetting {
  id: string;
  workspaceId: string;
  actionType: string; // ProposedAction['type']
  tier: AutonomyTier;
  updatedBy: Actor;
  updatedAt: Date;
}
```

Depolama `AgentPermissionManifestsService`'in `(workspaceId, agentIdentifier)` deterministik-streamId desenini AYNEN yansıtır (`apps/server/src/agent-runtime/agent-permission-manifests.service.ts:24-34`) — burada anahtar `(workspaceId, actionType)`. Ayar bir grant/revoke geçmişi DEĞİL, TEK bir "şu an ne" değeridir — event `TaskAutonomyTierSet {workspaceId, actionType, tier}`, projeksiyon en son olayı `task_autonomy_settings` satırına yazar (upsert-benzeri, `agentPermissionManifests`'in projeksiyon deseniyle aynı).

**Ayar HİÇ YOKSA varsayılan `'propose'`** (fail-safe, en muhafazakâr) — `AutonomyTierSettingsService.resolveTier(workspaceId, actionType)` satır bulunamazsa `'propose'` döner; hiçbir yeni action type'ın örtük olarak otonom davranmayacağı garanti edilir.

### (c) Yönetişim tabanı — `reconfigureAgentPermissions` SABİT `'propose'`, kadrana tabi DEĞİL (mimarinin KENDİ çıkarımı, insan tarafından dikte edilmedi)

**Bu madde, ADR-0037 §f'in "`decide()` tek boğaz noktası" Kararından çıkarılan, bu ADR'yi yazan mimarinin KENDİ karar-önerisidir — insan tarafından bu ADR'nin taslak sürecinde açıkça istenmedi, ama ADR-0037'nin kendi gerekçesiyle doğrudan tutarlı olduğu için buraya sabitlendi. Bu, gelecekte bir insan bunu gözden geçirip gevşetmek isterse AYRI bir karar/ADR gerektiren bir "varsayılan tutuculuk" seçimi, tartışılmaz bir dogma değil.**

```ts
/** Bu listedeki action type'lar için `AutonomyTierSettingsService.set()`
 * `tier !== 'propose'` isteğini HER ZAMAN reddeder (ForbiddenError). Genişletilebilir
 * bir liste — gelecekte başka bir governance-hassas action type eklenirse
 * yalnızca bu diziye eklenir, kod başka yerde değişmez. */
export const AUTONOMY_GOVERNANCE_FLOOR: readonly string[] = ['reconfigureAgentPermissions'];
```

**Gerekçe:** ADR-0037 §f, `decide()`'ın izin-yeniden-yapılandırma için TEK boğaz noktası kalmasını AÇIKÇA sabitledi ("`decide()` tek boğaz noktası olarak korundu"); bu ADR'nin kadranı bunu SESSİZCE atlatan bir arka kapı OLAMAZ. `AutonomyTierSettingsService.set(workspaceId, 'reconfigureAgentPermissions', 'act_and_notify', ...)` gibi bir çağrı admin tarafından bile yapılamaz — `ForbiddenError` fırlatılır, spesifik gerekçe metniyle.

### (d) Yönlendirme — YENİ `routeProposedActions`, 4 `propose*` metodunun HER BİRİNİN `recordProposal`'ı DOĞRUDAN çağırmasının YERİNE geçer

```ts
private async routeProposedActions(
  workspaceId: string,
  actor: Actor,
  actions: ProposedAction[],
  sourceObjectId: string | undefined,
  command: string,
  parseError: boolean,
  message?: string,
): Promise<CommandsServiceParseResult> {
  const tiers = await Promise.all(
    actions.map((a) => this.autonomyTierSettingsService.resolveTier(workspaceId, a.type)),
  );

  const actAndNotify = actions.filter((_, i) => tiers[i] === 'act_and_notify');
  const remaining = actions.filter((_, i) => tiers[i] !== 'act_and_notify');
  const remainingTiers = tiers.filter((t) => t !== 'act_and_notify');

  // (e) yap-bildir: decide()/command_proposals/ActionsDecided'a HİÇ
  // uğramadan, tek tek doğrudan yürüt. `recordProposal`'a ULAŞMADAN ÖNCE
  // gruptan çıkarılır -- bu aksiyonlar command_proposals'a HİÇ YAZILMAZ.
  const autonomousResults = await Promise.all(
    actAndNotify.map((action) =>
      this.executeAutonomousAction(workspaceId, action, sourceObjectId),
    ),
  );

  // recordProposal HER ZAMAN çağrılır -- `remaining` boş bile olsa (parse()'ın
  // "her çağrıda tam olarak bir ActionsProposed" değişmezi korunur).
  const proposeResult = await this.recordProposal(
    workspaceId, actor, remaining, sourceObjectId, command, parseError, message,
  );

  // (g) Karma-kademe muhafazakâr geri düşüş: yalnızca `remaining` TAMAMEN
  // approve_and_act ise (içinde TEK BİR 'propose' bile yoksa) otomatik karar
  // verilir. `remaining` boşsa döngü zaten hiçbir şey yapmaz.
  if (remaining.length > 0 && remainingTiers.every((t) => t === 'approve_and_act')) {
    await this.decideAsSystem(
      workspaceId,
      proposeResult.proposalId,
      remaining.map((a) => ({ actionId: a.actionId, decision: 'approved' as const })),
    );
  }

  return { ...proposeResult, autonomousResults };
}
```

`parse()`/`proposeFromMeeting()`/`proposeFromTrigger()`/`proposeFromDirectMessage()`'ın HER BİRİ, bugün `this.recordProposal(...)` çağırdığı SON SATIRDA, bunun yerine `this.routeProposedActions(...)`'ı AYNI argümanlarla çağırır — imzaları/dış sözleşimleri DEĞİŞMEZ (`CommandsServiceParseResult`'a yalnızca opsiyonel `autonomousResults: DecideActionResult[]` alanı EKLENİR, mevcut alanlar aynen kalır).

`proposeFromDirectMessage`'ın TEK ürettiği action type (`reconfigureAgentPermissions`, ADR-0037 §f) Karar (c)'nin yönetişim tabanı yüzünden HER ZAMAN `'propose'` çözümlenir — bu yol pratikte hiçbir zaman `actAndNotify`/otomatik-karar dalına girmez, yalnızca `recordProposal`'ın davranışını AYNEN tekrarlar.

### (e) `executeAutonomousAction` — yap-bildir'in yürütme mekaniği: `decide()`/`command_proposals`/`ActionsDecided` TAMAMEN ATLANIR

**İnsan tarafından açıkça onaylandı ve bu ADR'nin en yük taşıyan Kararı:** yap-bildir kademesindeki bir aksiyon `command_proposals`'a HİÇ YAZILMAZ, `decide()` HİÇ ÇAĞRILMAZ, `ActionsDecided` olayı HİÇ ÜRETİLMEZ. `decide()`'ın atlanması, `onayla-yap`'tan (Karar f, `decide()`'ı hâlâ kullanan) ayırt edici TEK özelliktir.

`executeDecidedAction`'ın (satır 849) 6 durumlu switch'i özel bir `dispatchExecute(workspaceId, action, actor, callerRole, causationEventId)` private metoduna ÇIKARILIR — hem `executeDecidedAction` (actor=gerçek onaylayan insan, causationEventId=`ActionsDecided` olayının id'si) hem `executeAutonomousAction` (actor=sabit `AUTONOMY_DIAL_ACTOR`, causationEventId=`null`, çünkü bu yolda böyle bir olay hiç YOK) bunu ÇAĞIRIR; switch'in KENDİSİ bu ADR'de tek satır değişmez, yalnızca çağıran sayısı ikiye çıkar.

```ts
// `type:'system'` (NOT `'agent'`) — every `type:'agent'` actor elsewhere in this
// codebase (`AgentDirectoryService.register`, `AgentPermissionManifestsService`,
// `MentionActionWorker`) corresponds to a REAL, registered `agentIdentifier` row;
// the autonomy dial is a workspace POLICY TRIGGER, not an actual agent. `actorSchema`
// (`packages/shared/src/events/domain-event.ts`) already supports `'system'` for
// exactly this case. This also makes these rows trivially distinguishable in
// `FlightRecorderPanel`/the ledger from a real agent's own `provenance:'autonomous'`
// rows (F3-T3/F3-T4), which always carry a genuine `agentIdentifier`.
const AUTONOMY_DIAL_ACTOR = { type: 'system', id: 'autonomy-dial' } as const;

private async executeAutonomousAction(
  workspaceId: string,
  action: ProposedAction,
  sourceObjectId: string | undefined,
): Promise<DecideActionResult> {
  // reconfigureAgentPermissions Karar (c) yüzünden buraya HİÇBİR ZAMAN
  // gelmez (her zaman 'propose' çözümlenir) — yine de savunmacı bir
  // assert burada (invariant ihlali = programlama hatası, kullanıcı hatası
  // değil) bırakılır.
  const result = await this.dispatchExecute(
    workspaceId, action, AUTONOMY_DIAL_ACTOR, 'admin', null,
  );

  // Ledger yazımı ADR-0038 §d'nin AYNI 'autonomous' provenance şeklini
  // kullanır (causationEventId zaten null — bu yolda hiç ActionsDecided
  // olayı yok, ADR-0038 §b'nin ZATEN öngördüğü şekil, ikinci bir çağıran).
  await this.recordAutonomousLedgerEntry(workspaceId, action, result);

  // (h) Bildirim — best-effort, ledger'ı/gerçek mutasyonu ASLA etkilemez.
  await this.notifyAutonomousAction(workspaceId, action, sourceObjectId);

  return result;
}
```

### (f) `decideAsSystem` — onayla-yap'ın yürütme mekaniği: `decide()`'ın İNCE bir sarmalayıcısı, `decide()`'IN KENDİSİ DEĞİŞMEZ

```ts
private async decideAsSystem(
  workspaceId: string,
  proposalId: string,
  decisions: DecisionInput[],
): Promise<{ results: DecideActionResult[] }> {
  return this.decide(workspaceId, proposalId, AUTONOMY_DIAL_ACTOR, 'admin', decisions);
}
```

**Bilinçli olarak bu kadar ince:** `decide()`'ın kendi mantığı (bir-kez-decidedAt kontrolü, workspace-eşleşme kontrolü, `rejected`/`failed`/`executed` dallanması, `ActionsDecided` olayı, ledger-yazımı) HİÇ TEKRARLANMAZ/YENİDEN AÇILMAZ — `decideAsSystem` yalnızca "gerçek onaylayan insan yerine `AUTONOMY_DIAL_ACTOR`'ı kullan" farkını taşır. Bu, ADR-0037'nin "`decide()` tek boğaz noktası" Kararına dokunmaz — `decide()`'a giden TEK yol hâlâ `decide()`'ın kendisi, `decideAsSystem` yalnızca onun bir ÇAĞIRANI. **Onayla-yap'ın yap-bildir'den farkı tam olarak burada:** onayla-yap bir `ActionsDecided` olayı ÜRETİR (yalnızca otomatik tetiklenir), yap-bildir hiç üretmez.

### (g) Karma-kademe grup — MUHAFAZAKÂR geri düşüş (insan kararı, bu ADR onu icat etmiyor, aynen kayıt altına alıyor)

**Tek bir `parse()` (veya `proposeFromMeeting`/`proposeFromTrigger`) çağrısından gelen, `'propose'` ile `'approve_and_act'` karışık bir grup TAMAMEN pending kalır — kısmi otomatik-karar YOK.** Yalnızca gruptaki HER `'act_and_notify'`-olmayan aksiyon `'approve_and_act'` ise (yani içinde TEK BİR `'propose'` bile yoksa) `decideAsSystem` çağrılır; aksi halde `remaining` (hâlâ `command_proposals`'a `recordProposal` ile yazılmış olan) hiç dokunulmadan, tamamen bir insanın `decide()` çağırmasını bekler durumda bırakılır.

**Gerekçe (Bağlam #2'nin doğrudan sonucu):** `decide()` doğası gereği "tek atış, tüm-ya-da-hiç" — bir proposal'ın YALNIZCA bir alt-kümesi için `decide()`/`decideAsSystem` çağrılırsa, `decidedAt` TÜM SATIR için kalıcı olarak set edilir ve proposal'ın GERİ KALAN `actionId`'leri (insanın hâlâ karar vermesi gereken `'propose'`-kademeli olanlar) ASLA karara bağlanamaz hale gelir — sessizce terk edilmiş kalırlar. Bunu önlemenin TEK yolu ya (1) `decide()`'ın kendisini "kısmi karar" kavramına genişletmek (ADR-0037'nin sabitlediği tek-boğaz-noktası/tek-atış davranışını YENİDEN AÇAR — bu ADR'nin kapsamı DIŞINDA bırakılan bir karar), ya da (2) tek `ActionsProposed` olayını İKİ ayrı `command_proposals` satırına BÖLMEK (parse()'ın "tam olarak bir `ActionsProposed` olayı" değişmezini BOZAR). **İkisi de reddedildi (insan onayı)** — bunun yerine muhafazakâr geri düşüş seçildi: karma bir grup hiçbir kademe avantajı KAZANMAZ, tamamen insan onayına döner. Karma kademeli gruplar TEK bir `parse()` çağrısından gelen bir kenar durumdur (yaygın durum değil) — bu basitlik/güvenilirlik takası v0 için kabul edilebilir.

`'act_and_notify'`-kademeli aksiyonlar bu sorunun TAMAMEN DIŞINDA kalır çünkü Karar (d)'de `recordProposal`'a ULAŞMADAN ÖNCE gruptan çıkarılır — `command_proposals`'a hiç girmedikleri için `decide()`'ın tek-atış kısıtlamasıyla hiçbir zaman çakışmazlar (Bağlam #5'in zaten kurduğu, ikinci bir insan onayı adımı olmayan `provenance:'autonomous'` yolunun doğal bir genişlemesi).

### (h) Bildirim mekanizması — `sourceObjectId`-kapsamlı yorum, best-effort, YENİ bir bildirim alt sistemi İCAT EDİLMEDEN

`notifyAutonomousAction`, Bağlam #6'nın `MentionActionWorker`'ın reply-comment desenini BİREBİR yansıtır: `sourceObjectId` TANIMLIYSA, `this.commentsService.create(workspaceId, AUTONOMY_DIAL_ACTOR, 'member', { objectId: sourceObjectId, body: <sabit şablon> })` çağrılır — sabit şablon `'Bu aksiyon otonomi kadranınızda "yap-bildir" olarak ayarlı olduğu için otomatik yürütüldü: ' + action.intent` (ADR-0038 §d'nin "ham metin gömülmez, sabit şablon" disiplinini izler — yalnızca ZATEN görüntüleme-amaçlı olan `action.intent` gömülür, ham AI-çıktısı/kullanıcı-girdisi DEĞİL). `sourceObjectId` TANIMSIZSA (ör. `parse()`'ın kaynak-nesnesiz çağrıları, SCHEDULED tetikleyici ateşlemeleri) bildirim ATLANIR — bu AÇIKÇA kaydedilen bir v0 sınırlaması, hata DEĞİL; ledger (`agent_action_records`, ADR-0038) o durumda TEK denetim izi olarak kalır.

`parse()`'ın bugün kullanılmayan `_actor` parametresi (gerçek çağıran insan) bu ADR'de DE kullanılmaz — bir DM-tabanlı "size bildiriyorum" kanalı yerine tek, tüm 4 `propose*` kaynağı için TEK TİP çalışan `sourceObjectId`-tabanlı mekanizma tercih edildi (kaynak-nesnesiz durumlar için asimetrik özel-durum kodu yazmaktan kaçınma). `_actor`'ı gerçekten tüketmek AYRI bir gelecekteki karar/PR'dır.

### (i) RBAC — ayar YAZMA admin+, ayar OKUMA member+

`AutonomyTierSettingsService.set` admin+ (`AgentPermissionManifestsService.grant`/`.revoke`'un AYNI admin-gate desenini izler — bir kadran ayarı, bir izin-yeniden-yapılandırmasıyla AYNI yönetişim hassasiyetinde). `.get`/`.list` member+ (ADR-0038 §e'nin "Cam Kutu" şeffaflık ilkesinin AYNI tekrarı — bir member hangi görev tipinin hangi kademede olduğunu GÖREBİLMELİ, yalnızca admin DEĞİŞTİREBİLMELİ). Yazma için HTTP: yalnızca `PUT`; okuma: `GET` — `agent-permission-manifests.controller.ts`'in RBAC-guard desenini birebir izler.

## Somut Şekiller

```ts
// packages/agent-runtime/src/autonomy-tier.ts
export type AutonomyTier = 'propose' | 'approve_and_act' | 'act_and_notify';

export const AUTONOMY_TIER_RANK: Record<AutonomyTier, number> = {
  propose: 0,
  approve_and_act: 1,
  act_and_notify: 2,
};

export function isAutoDecidable(tier: AutonomyTier): boolean {
  return tier !== 'propose';
}

export const AUTONOMY_GOVERNANCE_FLOOR: readonly string[] = ['reconfigureAgentPermissions'];

export interface TaskAutonomySetting {
  id: string;
  workspaceId: string;
  actionType: string;
  tier: AutonomyTier;
  updatedBy: Actor;
  updatedAt: Date;
}
```

```ts
// apps/server/src/db/schema/task-autonomy-settings.ts
export const taskAutonomySettings = pgTable(
  'task_autonomy_settings',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    streamId: uuid('stream_id').notNull().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actionType: varchar('action_type', { length: 100 }).notNull(),
    tier: varchar('tier', { length: 20 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('task_autonomy_settings_workspace_action_type_idx').on(
      table.workspaceId,
      table.actionType,
    ),
  ],
);
```

Migration: `00XX_*.sql`, en yeni migration'ın devamı, down script'iyle birlikte (CLAUDE.md: "Migration'ı down script'i olmadan yazma").

Servisler: `AutonomyTierSettingsService` (`set`/`get`/`list`/`resolveTier`, deterministik `streamId = deriveDeterministicUuid(NAMESPACE, workspaceId + ':' + actionType)`), event tipi `TaskAutonomyTierSet`, stream tipi `'task-autonomy-setting'`.

`CommandsService` değişiklikleri: `dispatchExecute` (switch çıkarımı), `executeAutonomousAction`, `decideAsSystem`, `routeProposedActions` (yeni private metodlar); `recordAutonomousLedgerEntry`/`notifyAutonomousAction` (yeni private yardımcılar); `CommandsServiceParseResult`'a opsiyonel `autonomousResults?: DecideActionResult[]` alanı eklenir; constructor'a `AutonomyTierSettingsService` enjekte edilir.

**RBAC özeti:** Ayar okuma (`get`/`list`) = member+; ayar yazma (`set`) = admin+ (governance-floor action type'lar için admin bile reddedilir); `routeProposedActions`/`executeAutonomousAction`/`decideAsSystem` hiçbirinin kendi HTTP uç noktası YOK — yalnızca `parse()`/`proposeFromMeeting()`/`proposeFromTrigger()`/`proposeFromDirectMessage()` üzerinden dolaylı tetiklenir.

## Alternatifler ve Reddedilme Gerekçeleri

- **Karma `propose`+`approve_and_act` grubunu İKİ ayrı `command_proposals` satırına bölmek (row-splitting), yalnızca `approve_and_act` alt-kümesini hemen otomatik karara bağlamak.** Reddedildi (Karar g, insan tarafından açıkça talimatla) — `parse()`'ın "tam olarak bir `ActionsProposed` olayı" değişmezini bozar, ek karmaşıklık/insan-gözden-geçirme yükü getirir; karma-kademeli gruplar nadir bir kenar durum, muhafazakâr tam-pending geri düşüşü v0 için yeterli.
- **`decide()`'ın kendisini "kısmi karar" (bazı `actionId`'ler kararlı, bazıları hâlâ bekliyor) kavramına genişletmek.** Reddedildi (Karar g) — ADR-0037'nin sabitlediği "tek atış, tüm-ya-da-hiç" tek-boğaz-noktası davranışını YENİDEN AÇAR; bu ADR'nin kapsamı dışında, ayrı bir gelecekteki karar gerektirir.
- **Yap-bildir'i de `decideAsSystem`/`decide()` üzerinden yürütmek, "bildirim"i yalnızca bir son-adım yan-etkisi yapmak.** Reddedildi (Karar e, insan tarafından açıkça talimatla) — yap-bildir'in `onayla-yap`'tan AYIRT EDİCİ özelliği `decide()`'ı hiç görmemesidir; bunu `decideAsSystem` üzerinden yürütmek iki kademeyi mekanik olarak birbirinden ayırt edilemez kılardı.
- **`reconfigureAgentPermissions`'ı da kadrana tabi kılmak (governance tabanı olmadan).** Reddedildi (Karar c, mimarinin kendi çıkarımı) — ADR-0037 §f'nin "`decide()` tek boğaz noktası" Kararını sessizce atlatan bir arka kapı olurdu.
- **Yeni, genel bir "Notification" alt sistemi inşa etmek.** Reddedildi (Karar h) — `MentionActionWorker`'ın ZATEN kurduğu `CommentsService.create` reply-comment deseni tek gerçek ihtiyacı karşılıyor; ikinci bir gerçek tüketici olmadan önden mühendislik olurdu.
- **`parse()`'ın `_actor`'ını tüketip bir DM-tabanlı "size bildiriyorum" kanalı kurmak.** Ertelendi (Karar h) — yalnızca `parse()` kaynağına özgü asimetrik bir mekanizma olurdu (`proposeFromMeeting`/`proposeFromTrigger`'ın gerçek bir çağıran insanı yok); tüm 4 kaynak için TEK TİP çalışan `sourceObjectId`-tabanlı mekanizma tercih edildi.
- **Otomatik-kararlı (`approve_and_act`/`act_and_notify`) aksiyonlar için ledger'da YENİ bir alan/provenance değeri eklemek.** Reddedildi — ADR-0038 §b'nin ZATEN öngördüğü `provenance:'autonomous'` + `causationEventId:null` şekli hiçbir değişiklik gerektirmeden bu ADR'nin ikinci çağıranını (yap-bildir yolu) karşılıyor; `approve_and_act` ise ZATEN var olan `provenance:'decided'` yolunu (yalnızca actor `AUTONOMY_DIAL_ACTOR`) kullanır.

## Mimari Değişmezlerle İlişki

- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Hem yap-bildir (ledger, ADR-0038'in AYNI `AgentActionRecord` şekli, ikinci bir çağıran) hem onayla-yap (mevcut `recordDecidedLedgerEntry`, `decide()`'ın kendi yolunda değişmeden) yolu bu sözleşmeyi hiçbir yeni şekil icat etmeden karşılar.
- **`decide()` tek boğaz noktası (ADR-0037).** Bu ADR `decide()`'ın KENDİSİNİ tek satır değiştirmez — `decideAsSystem` onun ince bir çağıranı (onayla-yap); yap-bildir ise KASITLI OLARAK bu boğaz noktasını hiç görmez, ama YALNIZCA bir admin'in workspace başına AÇIKÇA seçtiği, `reconfigureAgentPermissions` için ASLA seçilemeyen action type'lar için. `reconfigureAgentPermissions` için governance-floor bu boğaz noktasının hiçbir kadran ayarıyla atlatılamayacağını garanti eder.
- **"Tek doğruluk kaynağı olay günlüğüdür."** `task_autonomy_settings` `TaskAutonomyTierSet` olaylarının salt bir projeksiyonu — `agent_permission_manifests`'in AYNI kategorisinde.
- **Veri dışa aktarma / hassas veri sınıfları.** Bu ADR hiçbir export uç noktasına veya AI-sağlayıcı çağrısına dokunmuyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin F3-T5 vaadi (görev tipi başına otonomi kadranı, üç GERÇEKTEN farklı davranışlı kademe) `decide()`/ADR-0037/ADR-0038'in ZATEN kurduğu mekanizmaların (tek boğaz noktası, birleşik ledger, best-effort yazım, reply-comment deseni) YENİDEN İCAT EDİLMEDEN üzerine kurulur; onayla-yap ile yap-bildir arasındaki fark mekanik olarak (biri `ActionsDecided` üretir, diğeri asla üretmez) net bir şekilde ayırt edilebilir kalır.

**Neyi erteliyoruz / kabul ediyoruz:**

- Karma-kademeli gruplar için kısmi otomatik-karar YOK (Karar g) — tek bir `parse()` çağrısında `propose` ile `approve_and_act` karışmışsa, TÜM grup insan onayına döner; bu bir kenar-durum takası, gelecekte gerçek bir ihtiyaç doğarsa `decide()`'ın kendisinin kısmi-karar semantiğine genişletilmesi AYRI bir ADR gerektirir.
- Bildirim yalnızca `sourceObjectId` varsa gönderilir (Karar h) — kaynak-nesnesiz `act_and_notify` aksiyonları için sessiz kalır, ledger tek denetim izi olur.
- `parse()`'ın `_actor`'ı hâlâ kullanılmıyor — F1-T16'dan beri açık kalan genişletme noktası, bu ADR'de de kapanmıyor.
- `reconfigureAgentPermissions` kadrana HİÇBİR ZAMAN tabi değil (Karar c, mimarinin kendi çıkarımı) — kasıtlı, kalıcı bir yönetişim tabanı; gelecekte bir insan bunu gevşetmek isterse AYRI bir karar/ADR gerektirir, bu ADR'nin kendisi bunu kapatmaz.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E2/F3-T5-otonomi-kadrani.md`) `docs-writer` ile yazılır. Bu ADR'nin onayı üzerine PR1'e (`packages/agent-runtime` saf domain: `AutonomyTier`/`TaskAutonomySetting`/`AUTONOMY_GOVERNANCE_FLOOR` + olay şeması + `task_autonomy_settings` şeması/migration + `AutonomyTierSettingsService`) `test-writer` ile başlanır:

```
docs/adr/ADR-0039-otonomi-kadrani.md'deki Karar (a)-(i)'yi ve
docs/specs/F3-E2/F3-T5-otonomi-kadrani.md'nin Kabul Kriterleri'ni temel alarak, F3-T5
PR1 (packages/agent-runtime saf domain: AutonomyTier/TaskAutonomySetting tipleri,
TaskAutonomyTierSet olay şeması, task_autonomy_settings tablosu + migration,
AutonomyTierSettingsService set/get/list/resolveTier) için test-writer ile başarısız
testleri yaz.
```
