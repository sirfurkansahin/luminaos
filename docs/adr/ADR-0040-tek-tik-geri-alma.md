# ADR-0040: Tek Tık Geri Alma — Ters Olay Üretimiyle Atomik Geri Sarma (Epik F3-E2'nin Son Görevi)

**Durum:** Kabul edildi (kapsamın yalnızca `kind:'delete'` aksiyon türleriyle sınırlı olması [Karar a] ve emniyet/zaman-penceresi kontrolü olmaması [Karar b] insan tarafından açıkça onaylandı; ters kayıt temsili [Karar c], yürütme yerleşimi [Karar d], RBAC [Karar e], çifte-geri-alma önleme [Karar f] ve HTTP yüzeyi [Karar g] mimarinin KENDİ çıkarımı — aşağıda ayrıca işaretlendi, insan tarafından dikte edilmedi.)
**Tarih:** 2026-09-11
**İlgili görev:** F3-T6 — Tek tık geri alma: ters olay üretimiyle (event sourcing sayesinde) atomik geri sarma. `docs/PLAN.md` satır 283, FAZ 3, Epik F3-E2 (Cam Kutu Otonomi, Kapsam K)'nin SON görevi — F3-T3 (ADR-0037), F3-T4 (ADR-0038), F3-T5 (ADR-0039)'un doğrudan devamı.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin ilk fıkrasını doğrudan tetikliyor: karar "Mimari Değişmezler"den biriyle DOĞRUDAN geriliyor — "tek doğruluk kaynağı olay günlüğüdür" (bkz. Bağlam #5, mevcut kod tabanında BAŞTAN SONA hiçbir ters-olay/geri-alma mekanizması yok). Ayrıca ikinci fıkrayı da tetikliyor: `AgentActionRecord`/`RollbackPlan` tipleri (ADR-0038) birden fazla gelecekteki görev tarafından paylaşılan bir sözleşim — bu ADR o sözleşime YENİ bir alan (`undoesRecordId`) ekliyor.

> Bu ADR, ADR-0037/0038/0039'un doğrudan mimari devamıdır. `FlightRecorderPanel.tsx`'in KENDİ doc-yorumu (F3-T4 PR4) bu görevi zaten açıkça işaret etmişti: _"bekleyen/karara-bağlanan ayrımı ve onayla/reddet gibi hiçbir aksiyon butonu YOK (F3-T6'nın kapsamı, bu görev yalnızca kaydeder)."_ Bu ADR o vaadi yerine getirir — ama YALNIZCA `RollbackPlan.kind === 'delete'` yazan 4 aksiyon türü için (`createTask`, `createTaskFromTrigger`, `createTaskFromMeeting`, `generateSubtasks`); `revertFieldValue` (`assignPeople`) ve `revokePermission`/`manual` (`reconfigureAgentPermissions`) bu ADR'nin kapsamı DIŞINDA bırakılır (Karar a, insan kararı).

## Bağlam

Doğrudan koddan doğrulandı (bir `explorer` alt-ajanı tarafından):

1. **`RollbackPlan` bugün salt açıklayıcı/tek-yazımlık** (`packages/agent-runtime/src/agent-action-record.ts:42-46`): `{kind, targetResource?, description}`. Kod tabanında HİÇBİR YER `.rollbackPlan`'ı OKUYUP gerçek bir tersine çevirme YÜRÜTMÜYOR — yalnızca yazma noktaları (`commands.service.ts`, `mention-action-worker.service.ts`), bir pas-geçiş (`agent-action-records.service.ts`) ve salt-görüntüleme okuma (`FlightRecorderPanel.tsx:69`) var.
2. **Fiilen yazılan `rollbackPlan` şekilleri** (`commands.service.ts`): `executeCreateTask`/`executeCreateTaskFromTrigger`/`executeCreateTaskFromMeeting` (başarı) → `{kind:'delete', targetResource: objectResource(created.id), description:'Oluşturulan görevi sil.'}`. `executeGenerateSubtasks` (başarı/kısmi) → `{kind:'delete', description:'...alt görevleri sil.'}` — **`targetResource` YOK**, oluşturulan TÜM id'ler `resources: createdIds.map(objectResource)` içinde yaşıyor (tek "resources[]-targetResource-değil" deseni). `executeAssignPeople` → `{kind:'revertFieldValue', ...}` (yapısal `fieldKey` yok, yalnızca serbest metin). `executeReconfigureAgentPermissions`'ın `revoke` dalı → `{kind:'manual', ...}` (ZATEN açıkça YAGNI'lenmiş — "revoke-öncesi manifesto durumu snapshot'lanmadığı için yapısal bir tersi yok"); `grant` dalı → `{kind:'revokePermission', targetResource: agentResource(agentIdentifier), ...}` ama `AgentPermissionManifestsService.revoke` KABA (tüm mevcut manifestoyu iptal eder, yalnızca verilen deltayı değil). Tüm başarısız/reddedilen dallar → `{kind:'none', ...}`. `provenance` (`'decided'` vs `'autonomous'`), YAZILAN `rollbackPlan`'ı ETKİLEMİYOR — aynı kod yolu her ikisi için de geçerli.
3. **`kind:'delete'`'in tersine çevrilmesi için gereken ZATEN VAR**: `ObjectsService.softDelete(workspaceId, objectId, actor)` (`objects.service.ts:263-265`) → `applyCommand` → gerçek yaşam-döngüsü durum-makinesi geçişi (`packages/core-objects/src/lifecycle.ts`: `softDelete: active|archived -> deleted` (SADECE)) → gerçek `ObjectSoftDeleted` domain olayı — hem `eventStore.append(streamId, priorEvents.length, ...)`'ın kendi optimistic-concurrency versiyon kontrolüyle, hem `softDeleteObject(state)`'in kendi durum-makinesi korumasıyla (zaten-`deleted` bir nesnede ikinci bir `softDelete` çağrısı `InvalidObjectStateError` fırlatır). **Hiçbir yeni silme/tersine-çevirme ilkeli GEREKMİYOR** — `rollbackPlan.description`'ın kendi metni ("...sil.") zaten `softDelete`'i (`archive`'ı DEĞİL) işaret ediyor.
4. **`kind:'revertFieldValue'`/`'revokePermission'` için HİÇBİR ŞEY YOK**: alan-değeri geçmişinden "mutasyon X'ten HEMEN ÖNCEki dilim"i bulacak bir yardımcı yok (`replayFieldValues` yalnızca ordered bir dilimi foldluyor, `causationEventId`/`occurredAt`'a göre dilimleme yok); `AgentPermissionManifestsService.revoke` KABA, önceki-durum-snapshot/restore yeteneği yok. **Bu ikisi bu ADR'nin kapsamı DIŞINDA (Karar a).**
5. **Event-sourcing "tersine çevirme" mekaniği kod tabanında HİÇ YOK.** Hiçbir olay türü "başka bir olayın tersi" değil; `packages/shared/src/events/domain-event.ts`'in zarfında geriye-işaret-eden bir "bu, olay X'i geri alıyor" alanı yok (tek nedensellik-bağlantı alanı `causationEventId`, YALNIZCA ileri işaret ediyor: karar→mutasyon).
6. **Ledger bugün** (`agent_action_records`): `record()` (yazma, asla fırlatmaz, HTTP yok), `list()`, `get(workspaceId, recordId, callerRole)` (TEK-kayıt okuma — ZATEN VAR) — ikisi de `member`+ kapılı, HİÇBİR HTTP yazma rotası yok. `AgentActionRecordsController`'ın kendi doc-yorumu: _"the ledger has NO write route at all, only `list`/`get`. Any mutation happens exclusively via internal ... calls ... never through HTTP."_ DB şemasının (`db/schema/agent-action-records.ts`) kendi doc-yorumu: _"INSERT-ONLY ... never updated."_ — HİÇBİR "geri alındı" durum/bayrak kolonu yok.
7. **RBAC emsali: her yerde SALT rol-tabanlı, HİÇBİR YERDE actor-kimlik eşleşmesi yok.** `decide()` yeterli workspace roldeki HERHANGİ bir çağıranın, kim önerdiğine bakılmaksızın onaylamasına/reddetmesine izin verir; `AgentPermissionManifestsService.revoke` yalnızca `admin`+ kapılı, kim asıl verdiğine bakılmaksızın; ledger okuma yalnızca `member`+ kapılı. "Yalnızca asıl actor/onaylayan işlem yapabilir" kavramı HİÇBİR YERDE yok.
8. **Modül döngüsü emsali zaten var:** `CommandsModule` `AgentRuntimeModule`'ü import ediyor (`AgentPermissionManifestsService`/`AutonomyTierSettingsService` için); `CommandsModule`'ün kendi doc-yorumu ZATEN bir `forwardRef()` döngü-kırma deseni belgeliyor (`CommandsModule -> CommentsModule -> SkillsModule -> CommandsModule`, `SkillsModule`'ün kendi eşleşen `forwardRef()`'i ile). Bu ADR'nin HTTP yüzeyi kararı (Karar g) TAM OLARAK AYNI türden ikinci bir döngü açıyor — aşağıda somutlaştırılıyor.

**İnsan kararları (bu Plan Mode oturumunda alındı):**

1. **Kapsam DAR: yalnızca `kind:'delete'` yazan aksiyon türleri (`createTask`, `createTaskFromTrigger`, `createTaskFromMeeting`, `generateSubtasks`) F3-T6'da GERÇEK, yürütülebilir tek-tık geri alma kazanır.** `assignPeople` (`revertFieldValue`) ve `reconfigureAgentPermissions` (`revokePermission`/`manual`) bu görevde GERÇEK geri-alma mekanizması KAZANMAZ — ne alan-değeri-geçmişi-yeniden-kurma kodu, ne manifesto-snapshot kodu bu görevde yazılır. Bu ikisi için ledger'ın mevcut `rollbackPlan.kind` alanı AYNEN kalır (bugünkü gibi salt-görüntüleme), UI'daki herhangi bir "geri al" butonu ya YOK ya da "bu aksiyon otomatik geri alınamaz" mesajıyla açıkça devre dışı — bu, `executeReconfigureAgentPermissions`'ın KENDİ `revoke` dalının ZATEN kurduğu YAGNI emsalini yansıtır. Gerekçe: kod tabanında diğer iki tür için sıfır mevcut ilke var; onları inşa etmek önemli ölçüde daha büyük, daha riskli bir iştir, BİLİNÇLİ olarak ertelenir, sessizce unutulmaz değil.
2. **v0'da hiçbir eskime/bağımlılık emniyet kontrolü YOK.** Geri alma KOŞULSUZ yürütülür — hedef nesne orijinal aksiyondan SONRA yorum/alt-öğe/düzenleme kazanmış olsa bile — bu, kod tabanındaki HER MEVCUT yaşam-döngüsü-geçiş mekanizmasıyla (hiçbiri bunu bugün kontrol etmiyor) TUTARLI. Zaman-penceresi kısıtlaması da YOK ("yalnızca N dakika içinde geri alınabilir" AÇIKÇA inşa edilmiyor). Gerçek bir ihtiyaç ortaya çıkarsa, bu AYRI bir gelecekteki karar/ADR'dir.

**Çözülmesi gereken merkezi sorular:** "bu aksiyon geri alındı" nasıl temsil edilir, ledger'ın kendi insert-only/asla-güncellenmez değişmezini bozmadan (a→c)? Gerçek tersine-çevirme mantığı NEREDE yaşar (d)? Geri almayı tetiklemek için RBAC nedir (e)? Çifte geri alma nasıl engellenir (f)? HTTP yüzeyi nedir, `AgentActionRecordsController`'ın kendi salt-okunur-YALNIZCA konvansiyonuna karşı (g)?

## Karar

### (a) Kapsam — YALNIZCA `kind:'delete'`, insan kararı, mimarinin icadı DEĞİL

**Bu madde insan tarafından bu ADR'nin taslak sürecinde AÇIKÇA dikte edildi — mimarinin kendi çıkarımı değil.** `CommandsService.undoAction` (Karar d) bir kayıt üzerinde çağrıldığında `record.rollbackPlan.kind !== 'delete'` ise `ValidationError` fırlatır ("bu aksiyon türü otomatik geri alınamaz"), `assignPeople`/`reconfigureAgentPermissions` için HİÇBİR yeni tersine-çevirme kodu yazılmaz. `FlightRecorderPanel`'in gelecekteki "geri al" butonu (bu ADR'nin kapsamı dışında, ayrı bir frontend PR'ı) yalnızca `rollbackPlan.kind === 'delete'` kayıtlarında görünür/etkin olur; diğerlerinde ya HİÇ görünmez ya da devre dışı + "bu aksiyon otomatik geri alınamaz" metniyle gösterilir.

### (b) Emniyet kontrolü / zaman penceresi YOK — insan kararı, mimarinin icadı DEĞİL

**Bu madde de insan tarafından AÇIKÇA dikte edildi.** `undoAction` hedef nesnenin(nin) geri alma ANINDAKİ mevcut durumunu (yorumlar, alt-ilişkiler, sonraki düzenlemeler) HİÇ SORGULAMAZ — doğrudan `ObjectsService.softDelete`'i çağırır, tıpkı kod tabanındaki her diğer yaşam-döngüsü geçişi gibi. Zaman-penceresi kontrolü de yok.

### (c) Geri-alınmış temsili — YENİ, İKİNCİ bir `AgentActionRecord` satırı, orijinal satır ASLA güncellenmez

`AgentActionRecord`'a (ve onun altındaki DB kolonuna/olay şemasına) YENİ, nullable bir `undoesRecordId: string | null` alanı eklenir — HER normal aksiyon kaydında `null`, YALNIZCA bir geri-alma kaydında orijinal kaydın KENDİ `id`'sine (ULID) işaret eder. **Orijinal satır HİÇBİR ZAMAN UPDATE edilmez** — `undoAction` başarıyla tamamlandığında `AgentActionRecordsService.record()` ÇAĞRILIR (var olan, hiç değişmeyen "her çağrı kendi taze `randomUUID()` stream'i" sözleşimiyle), bu da tamamen YENİ, bağımsız bir `AgentActionRecorded` olayı/satırı üretir — `undoesRecordId` alanı ile orijinali işaret eden. Bu, `ActionsDecided`'ın ASLA `ActionsProposed`'u yeniden yazmaması ve reddedilen bir kararın KENDİ ledger satırını alması (`decide()`'ın rejected dalı, Bağlam) İLE AYNI deseni izler — geçmişi YERİNDE yeniden yazmak "tek doğruluk kaynağı olay günlüğüdür" değişmezini tam olarak bu şekilde ihlal ederdi.

Geri-alma kaydının KENDİSİ: `actionType: 'undoAction'` (ORİJİNALİN `actionType`'ından FARKLI, sabit bir literal — ledger'da "bu satır bir geri-almadır" okunabilirliği için), `intent: '"${original.actionType}" aksiyonunu geri al.'` (sabit şablon + orijinalin ZATEN görüntüleme-amaçlı, güvenli `actionType`'ı — ADR-0039 §h'nin "ham metin gömülmez" disiplini), `rationale`: sabit metin ("Kullanıcı Uçuş Kayıt Cihazı panelinden bu aksiyonu geri aldı."), `resources`: orijinalin KENDİ `resources[]`'i (şimdi silinmiş nesneler), `rollbackPlan: {kind:'none', description:'Bir geri alma aksiyonu kendisi geri alınamaz.'}` (geri-almanın-geri-alması YOK — kasıtlı, sonsuz zincir engeli), `outcome: 'succeeded'`, `resultRef: null`, `causationEventId: null` (bu yolda da `decide()`/`ActionsDecided` YOK — ADR-0039'un yap-bildir yoluyla AYNI kategori), `provenance: 'decided'` (aşağıda gerekçeli).

**`provenance` için YENİ bir değer EKLENMEDİ** — mevcut `'decided'` yeniden kullanılır. `ActionProvenance`'ın doc-yorumu şu şekilde GENİŞLETİLİR: _"'decided' — a human approved the action via `decide()`, OR triggered a structurally-equivalent explicit synchronous action (F3-T6 undo)."_ Gerekçe Alternatifler bölümünde.

### (d) Yürütme yeri — `CommandsService.undoAction`, YENİ servis/paket YOK

`CommandsService`'e (`decide()`/`dispatchExecute`/`recordDecidedLedgerEntry`'nin ZATEN yaşadığı yer) yeni bir `undoAction` metodu eklenir — YENİ bir servis veya paket AÇILMAZ, çünkü tersine-çevirme mantığı `dispatchExecute`'un ileri-yön mantığıyla AYNI bağımlılıkları (ledger yazımı, `ObjectsService`) paylaşır ve ADR-0039'un `executeAutonomousAction`/`decideAsSystem`'ı `dispatchExecute`'un YANINA eklediği desenin doğrudan devamıdır. `AgentActionRecordsService` bilinçli olarak salt okuma/yazma kalır (yürütme mantığı EKLENMEZ) — ADR-0038'in "ledger, aksiyonların KENDİSİNİ değil KAYDINI tutar" ayrımını korur.

```ts
async undoAction(
  workspaceId: string,
  recordId: string,
  actor: Actor,
  callerRole: MembershipRole,
): Promise<{ status: 'undone' }> {
  const original = await this.agentActionRecordsService.get(workspaceId, recordId, callerRole);
  if (!original) {
    throw new NotFoundError('Agent action record not found.');
  }

  if (original.rollbackPlan.kind !== 'delete') {
    throw new ValidationError(
      `This action's rollback plan ("${original.rollbackPlan.kind}") cannot be undone automatically yet.`,
    );
  }

  const alreadyUndone = await this.agentActionRecordsService.findUndoRecord(workspaceId, recordId);
  if (alreadyUndone) {
    throw new ConflictError('This action has already been undone.');
  }

  // `resources[]` -- NOT `rollbackPlan.targetResource` -- is the authoritative
  // list to reverse: single-create actions populate BOTH with the same
  // value, `generateSubtasks` populates ONLY `resources[]`. Reading from
  // `resources[]` uniformly avoids a two-path branch (Alternatifler).
  for (const target of original.resources) {
    if (target.kind !== 'object') {
      continue; // Defensive only -- `kind:'delete'` is only ever paired
      // with object-kind resources today (Bağlam #2); an invariant
      // violation here is a programming error, not a user error.
    }
    await this.objectsService.softDelete(workspaceId, target.objectId, actor);
  }

  await this.recordUndoLedgerEntry(workspaceId, original, actor);

  return { status: 'undone' };
}

private async recordUndoLedgerEntry(
  workspaceId: string,
  original: AgentActionRecord,
  actor: Actor,
): Promise<void> {
  try {
    await this.agentActionRecordsService.record(workspaceId, {
      provenance: 'decided',
      actor,
      actionType: 'undoAction',
      intent: `"${original.actionType}" aksiyonunu geri al.`,
      rationale: 'Kullanıcı Uçuş Kayıt Cihazı panelinden bu aksiyonu geri aldı.',
      resources: original.resources,
      rollbackPlan: { kind: 'none', description: 'Bir geri alma aksiyonu kendisi geri alınamaz.' },
      outcome: 'succeeded',
      resultRef: null,
      causationEventId: null,
      undoesRecordId: original.id,
    });
  } catch (error) {
    this.logger.error(
      `Undo ledger record write failed for workspace ${workspaceId}, original record ${original.id}; the already-completed reversal is unaffected.`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
```

**Yön seçimi (`softDelete`, `archive` DEĞİL):** orijinal `rollbackPlan.description`'ın kendi metni ZATEN "sil" diyor (`'Oluşturulan görevi sil.'`); `lifecycle.ts`'in `softDelete: active|archived -> deleted` geçişi tam olarak bunu ifade eder. `archive` (`active -> archived`, ayrı bir lifecycle konumu, hâlâ görünür) YANLIŞ yön olurdu — bir CREATE'in geri alınması, nesnenin kullanıcı gözünde "hiç var olmamış gibi" olmasını gerektirir, `deleted` durumu bunu `archived`'dan daha doğru ifade eder.

### (e) RBAC — `member`+, ledger'ın KENDİ okuma kapısıyla AYNI

`AgentActionRecordsService.get()`'in ZATEN uyguladığı `member`+ kontrolü (`undoAction`'ın İLK adımı, `get()`'i doğrudan çağırır) TEK kapı olarak yeterli — `admin`+ gibi daha katı bir taban EKLENMEZ. Gerekçe: `decide()`'ın KENDİSİ, governance-hassas OLMAYAN aksiyon türleri (`createTask`/`generateSubtasks` — bu ADR'nin TÜM kapsamı) için `WorkspaceMembershipGuard`'ın ötesinde HİÇBİR ek rol tabanı DAYATMIYOR (yalnızca `reconfigureAgentPermissions` gibi governance-hassas türler, DELEGE EDİLMİŞ servis katmanında -- `AgentPermissionManifestsService.grant`/`.revoke` -- kendi `admin`+ kontrolünü yapıyor). Bu ADR'nin kapsamı (Karar a) HİÇBİR ZAMAN governance-hassas türleri kapsamadığından, `member`+ hem ledger-okuma emsaliyle hem `decide()`'ın kendi (yokluğuyla tanımlı) tabanıyla TUTARLI — "yalnızca asıl actor/onaylayan geri alabilir" gibi bu kod tabanında HİÇBİR YERDE olmayan yeni bir actor-kimlik kısıtlaması İCAT EDİLMEDİ (Bağlam #7).

### (f) Çifte geri-alma önleme — ön-kontrol UX için, GERÇEK yarış-güvenliği `ObjectsService`'in KENDİ mekanizmasından miras alınır

İKİ katman: (1) **Ön-kontrol** (`findUndoRecord`, Karar d'de gösterildi) — `agent_action_records`'ta `undoesRecordId = recordId` olan bir satır zaten var mı diye bakar, varsa `ConflictError` (tam olarak `decide()`'ın `row.decidedAt !== null` → `ConflictError` desenini yansıtır) — bu, sıradan ardışık çifte-tıklama için TEMİZ bir hata mesajı verir. (2) **Asıl yarış-güvenliği YENİ bir ilkel GEREKTİRMİYOR**: iki eşzamanlı `undoAction` çağrısı AYNI kayıt için yarışırsa, ön-kontrol her ikisi için de `null` dönebilir (klasik TOCTOU penceresi) — ama bu ZARARSIZ, çünkü asıl reddiyeyi `ObjectsService.softDelete`'in KENDİ `applyCommand` boru hattı (`eventStore.append(streamId, priorEvents.length, ...)`'ın optimistic-concurrency versiyon kontrolü + `softDeleteObject(state)`'in KENDİ durum-makinesi koruması, `canTransition('softDelete')`: `active|archived` DIŞINDA bir durumdan çağrı `InvalidObjectStateError` fırlatır) veriyor: aynı nesne üzerinde iki eşzamanlı `softDelete`'ten biri MUTLAKA ya versiyon-çakışmasıyla ya "zaten `deleted`" durum hatasıyla başarısız olur. Kaybeden çağrının döngüsü o noktada fırlar, `recordUndoLedgerEntry`'e ASLA ulaşmaz — yani AYNI orijinal kayıt için İKİ geri-alma ledger satırının YAZILMASI yapısal olarak İMKANSIZ, `agent_action_records` tarafında YENİ bir eşzamanlılık ilkeli (kilit, DB-seviyesi unique constraint) İCAT EDİLMEDEN. Bu, "tek doğruluk kaynağı olay günlüğüdür" değişmezinin somut bir sonucu: yarış-güvenliği ledger'da DEĞİL, nesnenin KENDİ olay akışında yaşıyor (aşağıda Mimari Değişmezlerle İlişki'de tekrar ele alınıyor).

`undoesRecordId` kolonuna YİNE DE bir (unique OLMAYAN, salt sorgu-performansı) index eklenir (`findUndoRecord`'un `WHERE workspaceId AND undoesRecordId = ?` sorgusu için) — ama bu index bir eşzamanlılık GARANTİSİ DEĞİL, salt bir sorgu optimizasyonu.

### (g) HTTP yüzeyi — `AgentActionRecordsController`'a YENİ `POST .../:id/undo`, bilinçli, kapsamlı bir istisna

`POST /workspaces/:workspaceId/agent-action-records/:id/undo` — `AgentActionRecordsController`'ın KENDİ doc-yorumunun ("the ledger has NO write route at all") bu ADR'de AÇIKÇA delindiği, kapsam-genişlemesi DEĞİL, BİLİNÇLİ bir istisna olduğu NOT EDİLİR: geri alma doğal olarak ledger'ın KENDİ görünümünden (`FlightRecorderPanel`) tetiklenir, bu yüzden rota ledger'ın controller'ında yaşamalı — `CommandsController`'a EKLENMEZ (kavramsal olarak bir "komut kararı" değil, bir "ledger kaydı üzerinde işlem").

**Bunun somut bir modül-döngüsü sonucu var:** `AgentActionRecordsController.undo` gerçek yürütmeyi `CommandsService.undoAction`'a delege eder (Karar d) — ama `CommandsModule` ZATEN `AgentRuntimeModule`'ü import ediyor (`AgentPermissionManifestsService`/`AutonomyTierSettingsService` için). `AgentRuntimeModule`'ün KENDİSİNİN `CommandsService`'e ihtiyaç duyması `CommandsModule -> AgentRuntimeModule -> CommandsModule` döngüsünü açar — `CommandsModule`'ün KENDİ doc-yorumunun ZATEN belgelediği `CommandsModule -> CommentsModule -> SkillsModule -> CommandsModule` döngüsüyle AYNI TÜRDEN, AYNI çözümle: her iki taraf da `forwardRef()` kullanır.

```ts
// apps/server/src/agent-runtime/agent-runtime.module.ts
@Module({
  imports: [EventStoreModule, DbModule, AuthModule, forwardRef(() => CommandsModule)],
  // ... controllers/providers unchanged
})
export class AgentRuntimeModule {}
```

```ts
// apps/server/src/agent-runtime/agent-action-records.controller.ts
constructor(
  private readonly agentActionRecordsService: AgentActionRecordsService,
  @Inject(forwardRef(() => CommandsService))
  private readonly commandsService: CommandsService,
) {}

@Post(':id/undo')
@HttpCode(HttpStatus.OK)
async undo(
  @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  @Param('id') id: string,
  @Req() req: Request,
): Promise<{ status: 'undone' }> {
  const actor = this.requireActor(req); // YENİ private helper, ObjectsController'ınkiyle aynı desen
  const callerRole = this.requireRole(req);

  return this.commandsService.undoAction(workspaceId, id, actor, callerRole);
}
```

```ts
// apps/server/src/commands/commands.module.ts -- karşı taraf, zaten var olan desenin tekrarı
@Module({
  imports: [
    ,
    /* ... */ forwardRef(() => AgentRuntimeModule) /* was: AgentRuntimeModule (düz import) */,
  ],
  // ...
})
export class CommandsModule {}
```

## Somut Şekiller

```ts
// packages/agent-runtime/src/agent-action-record.ts
export interface AgentActionRecord {
  id: string;
  workspaceId: string;
  provenance: ActionProvenance;
  actor: Actor;
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: AgentActionOutcome;
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
  occurredAt: Date;
  /** NEW (F3-T6): null on every normal record; on an UNDO-shaped record
   * (`actionType === 'undoAction'`), the ORIGINAL record's own `id` (never
   * the reverse — the original row is never mutated, per ADR's Karar c). */
  undoesRecordId: string | null;
}
```

```ts
// packages/agent-runtime/src/agent-action-record-events.ts
export const agentActionRecordedPayloadSchema = z
  .object({
    provenance: z.enum(['decided', 'autonomous']),
    actionType: z.string().min(1).max(100),
    intent: z.string().min(1).max(500),
    rationale: z.string().min(1).max(2000),
    resources: z.array(actionResourceReferenceSchema),
    rollbackPlan: rollbackPlanSchema,
    outcome: z.enum(['succeeded', 'partially_succeeded', 'failed', 'rejected']),
    resultRef: actionResourceReferenceSchema.nullable(),
    causationEventId: z.uuid().nullable(),
    // NEW (F3-T6): the referenced id is another `AgentActionRecord`'s row
    // id (a ULID, `newObjectId()`, max 26 chars per the projection's own
    // `id` column width) -- NOT a UUID like `causationEventId` above.
    undoesRecordId: z.string().min(1).max(26).nullable(),
  })
  .strict();
```

```ts
// apps/server/src/db/schema/agent-action-records.ts
export const agentActionRecords = pgTable(
  'agent_action_records',
  {
    // ...existing columns unchanged...
    undoesRecordId: varchar('undoes_record_id', { length: 26 }),
  },
  (table) => [
    index('agent_action_records_workspace_occurred_at_idx').on(table.workspaceId, table.occurredAt),
    // Query-performance only (Karar f) -- NOT a concurrency guarantee.
    index('agent_action_records_undoes_record_id_idx').on(table.undoesRecordId),
  ],
);
```

Migration: `00XX_agent_action_records_undoes_record_id.sql` — `ALTER TABLE agent_action_records ADD COLUMN undoes_record_id VARCHAR(26); CREATE INDEX ... ON agent_action_records (undoes_record_id);`, down script `DROP INDEX ...; ALTER TABLE agent_action_records DROP COLUMN undoes_record_id;` (CLAUDE.md: "Migration'ı down script'i olmadan yazma").

```ts
// apps/server/src/agent-runtime/agent-action-records.projection.ts (apply(), diff)
const undoesRecordId = event.payload['undoesRecordId'];
await dbTx.insert(agentActionRecords).values({
  // ...existing fields unchanged...
  undoesRecordId:
    typeof undoesRecordId === 'string' && undoesRecordId.length > 0 ? undoesRecordId : null,
});
```

```ts
// apps/server/src/agent-runtime/agent-action-records.service.ts
export interface RecordAgentActionInput {
  // ...existing fields unchanged...
  undoesRecordId: string | null;
}

// toAgentActionRecord(row) += `undoesRecordId: row.undoesRecordId ?? null,`

/**
 * Internal-only (never HTTP-exposed directly, no `callerRole`) -- mirrors
 * `record()`'s own no-callerRole convention. Called by `CommandsService.
 * undoAction` BEFORE attempting a reversal, purely for the friendly
 * ConflictError UX path (Karar f) -- NOT the concurrency guarantee itself.
 */
async findUndoRecord(workspaceId: string, originalRecordId: string): Promise<AgentActionRecord | null> {
  const [row] = await this.db
    .select()
    .from(agentActionRecords)
    .where(
      and(
        eq(agentActionRecords.workspaceId, workspaceId),
        eq(agentActionRecords.undoesRecordId, originalRecordId),
      ),
    )
    .limit(1);

  return row ? toAgentActionRecord(row) : null;
}
```

`CommandsService` değişiklikleri: yeni `undoAction`/`recordUndoLedgerEntry` metodları (Karar d), constructor'a değişiklik YOK (`AgentActionRecordsService`/`ObjectsService` ZATEN enjekte edilmiş durumda).

`AgentActionRecordsController` değişiklikleri: yeni `POST :id/undo` rotası, yeni `requireActor` private helper (`ObjectsController`'ınkiyle aynı desen), constructor'a `@Inject(forwardRef(() => CommandsService)) commandsService: CommandsService` eklenir.

**RBAC özeti:** `undoAction` = `member`+ (Karar e, `get()`'in KENDİ kapısı üzerinden dolaylı uygulanır); `findUndoRecord` internal-only, kapısız (yalnızca `undoAction`'ın kendi `member`+ kontrolünden SONRA, o kontrolün ARKASINDA çağrılır).

## Alternatifler ve Reddedilme Gerekçeleri

- **Yalnızca `kind:'delete'` yerine TÜM `RollbackPlan.kind` değerlerini bu görevde kapsamak.** Reddedildi (Karar a, insan kararı) — `revertFieldValue`/`revokePermission` için kod tabanında sıfır mevcut ilke var; ikisini de bu görevde inşa etmek kapsamı önemli ölçüde büyütür, spec'te olmayan kapsamı "hazır olmuşken" eklemek olurdu (CLAUDE.md "Asla Yapma").
- **Emniyet/eskime kontrolü eklemek (hedef nesne o zamandan beri değişti mi?).** Reddedildi (Karar b, insan kararı) — kod tabanındaki HİÇBİR mevcut yaşam-döngüsü geçişi bunu yapmıyor; v0 için tutarlılık, gelecekte gerçek ihtiyaç doğarsa AYRI bir karar.
- **Orijinal `agent_action_records` satırını bir `undoneAt`/`undoneByRecordId` kolonuyla UPDATE etmek (Karar c'nin tersi).** Reddedildi — tablonun KENDİ doc-yorumunun sabitlediği "INSERT-ONLY ... never updated" değişmezini doğrudan bozar; bu da "tek doğruluk kaynağı olay günlüğüdür"ü ihlal ederdi (bir satırı yerinde değiştirmek, geçmişi yeniden yazmaktır). YENİ, ikinci bir satır + geriye-işaret-eden `undoesRecordId` seçildi — `ActionsDecided`'ın `ActionsProposed`'u ASLA yeniden yazmaması ile AYNI desen.
- **`ActionProvenance`'a YENİ bir `'undo'` değeri eklemek.** Reddedildi — `provenance` bugün `FlightRecorderPanel`'de HİÇ görüntülenmiyor (grep doğrulandı) ve hiçbir tüketici kodda üzerinde ayrımcı bir switch YOK; üçüncü bir değer eklemek her gelecekteki tüketicinin exhaustive-switch'ini genişletmeye zorlardı, somut bir fayda karşılığında olmadan. `'decided'`'ın "bir insan bu mutasyonu AÇIKÇA, senkron olarak yetkilendirdi" anlamı geri almaya da yapısal olarak uyuyor (`decide()`'a UĞRAMASA bile) — doc-yorumu bunu yansıtacak şekilde genişletildi, yeni bir birim EKLENMEDEN.
- **Gerçek tersine-çevirmeyi `AgentActionRecordsService`'e taşımak (servis salt okuma/yazma kalmak yerine yürütme de üstlensin).** Reddedildi (Karar d) — ADR-0038'in "ledger, aksiyonların KENDİSİNİ değil KAYDINI tutar" ayrımını bozardı; `CommandsService` zaten `ObjectsService`'e bağımlı ve `dispatchExecute`/`recordDecidedLedgerEntry`'nin yaşadığı yer, ikinci bir servise dağıtmak gereksiz dolaylama olurdu.
- **`archive` (tersine `restore`) kullanmak, `softDelete` yerine.** Reddedildi — orijinal `rollbackPlan.description`'ın KENDİ metni ("sil") `softDelete`'i işaret ediyor; `archive` farklı, hâlâ-görünür bir yaşam-döngüsü konumu, bir CREATE'in "hiç olmamış gibi" geri alınması semantiğine uymuyor.
- **Çifte geri-alma önlemek için ledger'da YENİ bir DB-seviyesi kilit/unique-constraint-tabanlı eşzamanlılık ilkeli inşa etmek.** Reddedildi (Karar f) — `ObjectsService.softDelete`'in KENDİ `eventStore.append` optimistic-concurrency + durum-makinesi korumasının ZATEN aynı nesne üzerindeki iki eşzamanlı geri-alma denemesinden birini yapısal olarak reddettiği gösterildi; ledger tarafında yeni bir ilkel İCAT ETMEK gereksiz mühendislik olurdu. `undoesRecordId` üzerindeki index salt sorgu-performansı için kalır, unique OLARAK işaretlenmedi (gereksiz katılık, gerçek garantiyi zaten ObjectsService veriyor).
- **Geri alma rotasını `CommandsController`'a eklemek, `AgentActionRecordsController`'a değil.** Reddedildi (Karar g) — geri alma kavramsal olarak bir "yeni komut kararı" değil, VAR OLAN bir ledger kaydı üzerinde bir işlem; doğal tetikleme yeri `FlightRecorderPanel`'in KENDİ görünümü. `AgentActionRecordsController`'ın salt-okunur doc-yorumu bu ADR'de AÇIKÇA, kapsamlı bir istisna olarak delinir.
- **"Yalnızca orijinal aksiyonu öneren/onaylayan kişi geri alabilir" (actor-kimlik kısıtlaması).** Reddedildi (Karar e) — kod tabanında BAŞKA HİÇBİR YERDE (decide, revoke, ledger okuma) böyle bir kısıtlama yok; bu ADR'nin icat ettiği ilk örnek olması, mevcut RBAC felsefesiyle tutarsız olurdu.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir." (EN YÜK TAŞIYAN İLİŞKİ, bu ADR'yi gerektiren madde.)** Geri alma YENİ bir "tersine çevirme" olay-türü veya geriye-işaret-eden bir zarf alanı İCAT ETMEZ (Bağlam #5'in doğruladığı boşluk KAPATILMAZ, genel olarak) — bunun yerine kod tabanında ZATEN var olan gerçek domain olayını (`ObjectSoftDeleted`) yeniden kullanır: geri alma, nesnenin KENDİ olay akışına YENİ bir olay EKLEMEKTİR, mevcut hiçbir olayı silmek/değiştirmek DEĞİL. Ledger tarafında da AYNI disiplin: orijinal `AgentActionRecord` satırı HİÇBİR ZAMAN güncellenmez (Karar c) — geri alma kendi YENİ, bağımsız olayını/satırını üretir, `undoesRecordId` ile geriye işaret ederek. Çifte-geri-alma yarış-güvenliği de (Karar f) ledger'da YENİ bir kilit ilkeli yerine nesnenin KENDİ olay akışının optimistic-concurrency korumasından miras alınır — yani bu ADR'nin EN kritik garantisi bile "tek doğruluk kaynağı olay günlüğü" ilkesinin DOĞRUDAN bir sonucu, ayrı bir mekanizma DEĞİL.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Geri alma kaydının KENDİSİ de bu sözleşmeye uyar (`intent`/`rationale`/`resources`/`rollbackPlan` hepsi dolu) — `rollbackPlan.kind:'none'` (bir geri-almanın kendisi geri alınamaz) ZATEN kod tabanında var olan bir değer, yeni bir kavram DEĞİL.
- **Veri dışa aktarma / hassas veri sınıfları.** Bu ADR hiçbir export uç noktasına veya AI-sağlayıcı çağrısına dokunmuyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin F3-T6 vaadi ("ters olay üretimiyle atomik geri sarma") `ObjectsService.softDelete`'in ZATEN var olan, event-sourced, optimistic-concurrency-korumalı lifecycle-geçiş mekanizmasının ÜZERİNE, hiçbir yeni tersine-çevirme ilkeli icat edilmeden kurulur; ledger'ın insert-only değişmezi bir ikinci-satır + geriye-işaret-eden-alan deseniyle korunur; `FlightRecorderPanel`'in F3-T4'ten beri açık bıraktığı "geri al butonu YOK" notu kapanır.

**Neyi erteliyoruz / kabul ediyoruz (ikisi de insan kararı, mimarinin kendi çıkarımı değil):**

- Yalnızca `kind:'delete'` gerçek geri alma kazanır (Karar a) — `assignPeople`/`reconfigureAgentPermissions` için gerçek geri-alma mekanizması AYRI, gelecekteki bir görev/ADR gerektirir; bu görev onları sessizce unutmuyor, açıkça erteliyor.
- Hiçbir eskime/zaman-penceresi emniyet kontrolü yok (Karar b) — geri alma koşulsuz yürütülür; gerçek bir ihtiyaç doğarsa AYRI bir karar/ADR gerektirir.
- `undoesRecordId` index'i salt sorgu-performansı, DB-seviyesi bir eşzamanlılık GARANTİSİ değil (Karar f) — bugünkü kapsamda (`kind:'delete'` → tek nesne akışı) bu yeterli; kapsam gelecekte bu özelliği kaybeden bir tersine-çevirme türüne genişlerse (ör. tek bir nesne akışına bağlı olmayan bir reversal), bu varsayım AYRICA gözden geçirilmeli.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E2/F3-T6-tek-tik-geri-alma.md`) `docs-writer` ile yazılır. Bu ADR'nin onayı üzerine PR1'e (`packages/agent-runtime`: `AgentActionRecord.undoesRecordId` + `agentActionRecordedPayloadSchema` güncellemesi + `agent_action_records` şeması/migration + projeksiyon + `AgentActionRecordsService.findUndoRecord`) `test-writer` ile başlanır:

```
docs/adr/ADR-0040-tek-tik-geri-alma.md'deki Karar (a)-(g)'yi ve
docs/specs/F3-E2/F3-T6-tek-tik-geri-alma.md'nin Kabul Kriterleri'ni temel alarak, F3-T6
PR1 (packages/agent-runtime: AgentActionRecord.undoesRecordId alanı,
agentActionRecordedPayloadSchema güncellemesi, agent_action_records tablosuna
undoes_record_id kolonu + migration, AgentActionRecordProjection güncellemesi,
AgentActionRecordsService.findUndoRecord) için test-writer ile başarısız testleri yaz.
```
