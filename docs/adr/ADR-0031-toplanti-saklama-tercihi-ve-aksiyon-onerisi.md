# ADR-0031: Toplantı Saklama Tercihi (Workspace-Kapsamlı Süpürücü) + ADR-0015'in Aksiyon-Önerisi Sözleşmesinin `createTaskFromMeeting`'e Genişletilmesi

**Durum:** Kabul edildi (Plan Mode oturumunda insan onayı zaten alındı — bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-01
**İlgili görev:** [F2-T14 — Saklama Tercihleri + Otomatik Aksiyon Çıkarımı → Onaylı Görev Üretimi](../specs/F2-E4/F2-T14-saklama-tercihleri-aksiyon-cikarimi.md)
**İlgili plan referansı:** [ADR-0015](./ADR-0015-konusma-komutlari-ajan-aksiyon-sozlesmesi.md) (F1-T16, öner→onayla sözleşmesi — bu ADR onu genişletir), [ADR-0030](./ADR-0030-notetaker-botu-mimarisi.md) §"Bilinen Sınırlamalar (b)" (F2-T13, saklama/silme politikasını AÇIKÇA bu göreve bırakan madde), [ADR-0029](./ADR-0029-hibrit-ai-veri-siniflandirmasi.md) (veri sınıflandırması — bu ADR onu YENİDEN TARTIŞMAZ, yalnızca saklama süresini ekler).

> Bu ADR **YENİ bir dosya** olarak açılıyor, ADR-0015'e bir ek/bölüm olarak DEĞİL — gerekçe bu dokümanın "ADR mi, ek mi?" bölümünde ayrıntılandırılıyor. Kısaca: bu görevin iki ana kararından yalnızca biri (aksiyon çıkarımı) ADR-0015'in sözleşmesini genişletiyor; diğeri (saklama tercihi) ADR-0015 ile hiçbir ilişkisi olmayan, ADR-0030'un punt ettiği tamamen ayrı bir karar. Tek bir görevin (F2-T14) birden fazla mimari kararı tek bir yeni ADR'de topladığı emsal zaten var: ADR-0030 tek başına (a)'dan (j)'ye kadar hem bot-mimarisi hem RBAC hem sağlayıcı-tespiti kararlarını tek dosyada barındırıyor.
>
> Bu ADR'nin (a)/(b) maddeleri spec'in kendi "Kapsam" bölümüne ve Plan Mode'da verilen insan kararına **AYNEN kayıt** geçiriyor (ADR-0030'un aynı kural için kullandığı format). Bu ADR'nin KENDİ katkısı: **(c)** `meeting_details`'e denormalize `workspaceId` kolonu + migration şekli, **(d)** `MeetingRetentionSweeperService`'in tam davranışı (mod-başına alan temizleme semantiği dahil), **(e)** `ProposedAction` birliğinin nerede yaşayacağı ve `createTaskFromMeeting`'in tam şekli, **(f)** `command_proposals.command` kolonunun toplantı-kaynaklı bir öneri için ne taşıyacağı, **(g)** `CommandsModule`'ün `CommandsService`'i export etmesi gerekliliği (bugün ETMİYOR — somut, gerekli bir kod değişikliği).

## Bağlam

Bir `explorer`/`architect` turuyla doğrulanan mevcut durum:

1. **`meeting_details`'in bugünkü tam şeması** (`apps/server/src/db/schema/meeting-details.ts`, ADR-0030 §d) `workspaceId` TAŞIMIYOR — yalnızca `objectId` (FK'siz `varchar(26)`, `objects_view`'a düz referans), `meetingUrl`, `provider`, `status`, `providerMeetingRef` (unique), `providerRecordingUrl`, `transcriptText`, `createdAt`. Bir sweeper'ın "bu satır hangi workspace'e ait, dolayısıyla hangi saklama tercihi geçerli?" sorusunu `objects_view`'a JOIN yapmadan yanıtlayabilmesi için bu kolon eksik.
2. **Denormalize `workspaceId` kolonu için GÜÇLÜ, doğrudan emsal var** — `apps/server/src/db/schema/calendar-events-cache.ts` (satır 29-31) `calendarAccountId`'ye ek olarak AYRICA `workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, {onDelete:'cascade'})` taşıyor; `apps/server/src/db/schema/command-proposals.ts` (satır 24-26) da aynı deseni tekrarlıyor. Her ikisi de GERÇEK bir FK (`workspaces.id`'ye) — `objects_view`'a referans veren `objectId` gibi FK'siz DEĞİL, çünkü `workspaces` tablosu bir projeksiyon değil, fiziksel bir tablo.
3. **`CalendarSyncPollerService`'in tam şekli** (`apps/server/src/calendar/calendar-sync-poller.service.ts`) doğrulandı: `OnModuleInit`/`OnModuleDestroy` ile `setInterval`/`clearInterval`, `pollOnce()`'ün her hesap için AYRI bir `try/catch` içinde çalışması (bir hesabın hatası diğerini durdurmaz), sabit modül-seviyesi `POLL_INTERVAL_MS` sabiti. `MeetingRetentionSweeperService` bu şekli birebir izleyecek.
4. **`ProposedAction`/`proposedActionSchema`'nın bugünkü tam konumu ve tüketicileri** (`apps/server/src/ai/parse-command.ts`, satır 26-34/53-62) doğrulandı: SEKİZ dosya bu tipi/şemayı import ediyor (`commands.service.ts`, `commands.controller.integration.test.ts`, `commands.service.decide.integration.test.ts`, `action-proposal.projection.integration.test.ts`, `commands.service.integration.test.ts`, `parse-command.test.ts`, `commands.eval.test.ts`, ve `parse-command.ts`'in kendisi). Bunu paylaşılan bir pakete (`packages/shared` gibi) taşımak sekiz dosyanın import yolunu değiştirmeyi gerektirir — sıfır mimari fayda karşılığında (bu tip zaten `apps/server/src/ai/` dışına, `commands.service.ts`'e "sunucu-içi" olarak export ediliyor; hiçbir `packages/*` paketi bugün bu tipi tüketmiyor ya da tüketmesi gerekmiyor).
5. **`CommandsService.parse()`'ün (satır 157-213) `ActionsProposed` yazma mantığı** doğrulandı: `proposalId` (`newObjectId()`) + `streamId` (`randomUUID()`) üretimi, `event: NewDomainEvent` inşası (`COMMAND_PARSER_ACTOR` sabit aktörüyle), `eventStore.append(streamId, 0, [event])`, `projectionRunner.catchUp(...)`, dönüş şekli (`{proposalId, actions, parseError, message?}`) — bu, `recordProposal` olarak çıkarılacak parça, satır satır.
6. **`command_proposals` şeması** (`apps/server/src/db/schema/command-proposals.ts`) zaten `sourceObjectId: varchar('source_object_id', {length: 26})` (opsiyonel) taşıyor — `proposeFromMeeting` için YENİ bir kolon GEREKMİYOR, `meetingObjectId` bu ALANA yazılır (mevcut `parse()`'un `sourceObjectId`'yi kullanma şekliyle BİREBİR aynı).
7. **`command` kolonu `text().notNull()`** — kullanıcının yazdığı doğal-dil komutunun ta kendisi. Toplantı-kaynaklı bir öneri için burada YAZILACAK bir "komut" yok; bu ADR'nin (f) kararı bu boşluğu somut olarak dolduruyor (transkriptin TAMAMINI bu kolona YAZMAMAK — `meeting_details.transcriptText` zaten ham veriyi taşıyor, ikinci bir kopya gereksiz depolama + saklama-politikası kaçağı olurdu: sweeper `meeting_details.transcriptText`'i temizlese bile `command_proposals.command`'a kopyalanmış bir nüsha kalıcı kalırdı).
8. **`MeetingsService.applyWebhookUpdate`** (`apps/server/src/notetaker/meetings.service.ts`, satır 154-189) doğrulandı: `transcriptText` yalnızca `update` nesnesinde `'transcriptText' in update` ise güncellenir (omit ≠ null ayrımı zaten var) — bu ADR'nin "yalnızca BU çağrıyla YENİ dolduruldu" tetikleme koşulunu doğru okumak için tam olarak bu satırların ÜZERİNE inşa edilecek (aşağıda Karar (h)).
9. **`CommandsModule` bugün `CommandsService`'i EXPORT ETMİYOR** (`apps/server/src/commands/commands.module.ts`, satır 24-37 — `providers` listesinde var, `exports` alanı hiç yok). `NotetakerModule`'ün `CommandsModule`'ü import edip `CommandsService`'i enjekte edebilmesi için bu, somut ve gerekli bir kod değişikliği (bu ADR'nin (g) kararı).
10. **Döngüsel bağımlılık YOK** — `CommandsModule`'ün import listesi (`DbModule`, `AuthModule`, `EventStoreModule`, `AIProviderModule`, `AIUsageModule`, `ObjectsModule`, `RelationsModule`) `NotetakerModule`'e hiçbir referans içermiyor; `NotetakerModule`'ün bugünkü import listesi de (`DbModule`, `AuthModule`, `ObjectsModule`) `CommandsModule`'e dokunmuyor. `NotetakerModule`'e `CommandsModule` eklemek yapısal olarak güvenli.
11. **`meeting_retention_preferences` için mevcut bir tercih-tablosu deseni YOK** (spec'in kendi "Mevcut Durum" bulgusu, F2-T14 spec satır 18) — en yakın emsaller (`desktop_signal_consents`, `memory_access_policies`) per-(workspace, user, category) grant/revoke boole'u, bu görevin ihtiyacı olan "isimlendirilmiş seçenekler arası TEK seçim" değil. İnsan kararı (Plan Mode) bunun için küçük, YENİ bir tablo açılmasını zaten onayladı (Karar a).

## Karar

### (a) Saklama tercihi — `meeting_retention_preferences`, workspace-başına TEK satır (insan kararı, aynen kayıt)

Per-meeting veya per-user override YOK; v0 yalnızca workspace-geneli tek bir tercih taşır.

```ts
// apps/server/src/db/schema/meeting-retention-preferences.ts
import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

export const meetingRetentionModeEnum = pgEnum('meeting_retention_mode', [
  'recording-reference',
  'transcript-only',
  'summary-only',
]);

export const meetingRetentionPreferences = pgTable(
  'meeting_retention_preferences',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mode: meetingRetentionModeEnum('mode').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Workspace başına EN FAZLA bir satır -- "bir upsert değil, gerçek bir
    // benzersizlik" invariant'ını DB seviyesinde de garanti eder (aynı
    // `meeting_details_object_id_idx`'in ADR-0030 §d'de kurduğu gerekçe).
    uniqueIndex('meeting_retention_preferences_workspace_id_idx').on(table.workspaceId),
  ],
);
```

Satır YOKSA kod-seviyesi varsayılan devreye girer (Karar b) — bir "tercih henüz seçilmedi" durumunu satırın YOKLUĞUYLA temsil etmek, `command_proposals.decidedAt IS NULL`'ın "henüz karar verilmedi" temsiliyle AYNI disiplin (satırın varlığı = karar verildi, yokluğu = henüz verilmedi).

### (b) Satır yoksa kod-seviyesi varsayılan: `transcript-only`, 30 gün TTL (insan kararı, aynen kayıt)

**`summary-only` DEĞİL** — bu kod tabanında HİÇBİR özetleme (summarization) yeteneği yok (bir `explorer` grep'iyle doğrulandı: `packages/ai-gateway` yalnızca `complete()` taşıyor, "summary"/"summarize" için tek bir üretim kod yolu yok). Varsayılanı `summary-only` yapmak, hiçbir zaman üretilmeyecek bir özete "dayanan" bir saklama politikası anlamına gelirdi — pratikte bu, hiçbir şeyin asla temizlenmediği bir varsayılana denk gelirdi (aşağıdaki Karar d'nin per-mode semantiği çözülmeden). `transcript-only` + 30 gün, ADR-0029'un "sıkı opt-in" ruhuyla tutarlı EN KISITLAYICI varsayılan: açıkça bir tercih seçilmediyse ham transkript sınırlı bir süre sonra otomatik silinir.

### (c) [ARCHITECT KARARI] `meeting_details`'e denormalize `workspaceId` — gerçek FK, migration + backfill + down script

```ts
// apps/server/src/db/schema/meeting-details.ts -- EKLENEN kolon
workspaceId: uuid('workspace_id')
  .notNull()
  .references(() => workspaces.id, { onDelete: 'cascade' }),
```

`calendar_events_cache.workspaceId`/`command_proposals.workspaceId`'nin (Bağlam madde 2) BİREBİR aynı deseni: gerçek bir FK, `objectId`'nin FK'siz `objects_view` referansından farklı olarak (`workspaces` fiziksel bir tablo, `objects_view` bir projeksiyon). Mevcut satırlar için `NOT NULL` eklemek bir backfill adımı gerektirir — migration üç adımda:

1. Kolonu NULL'a izin verecek şekilde ekle.
2. `UPDATE meeting_details SET workspace_id = (SELECT workspace_id FROM objects_view WHERE objects_view.id = meeting_details.object_id)` ile geriye dönük doldur (objects_view'da HER `meeting` nesnesi zaten bir workspace'e bağlı olduğundan bu her satır için deterministik tek bir sonuç verir).
3. `ALTER COLUMN workspace_id SET NOT NULL`.

Down script'i (CLAUDE.md zorunluluğu) kolonu düşürür. **`inviteBot`/`applyWebhookUpdate`'in her ikisi de bundan sonra `meeting_details` insert'ine `workspaceId` eklemeli** — `inviteBot` zaten `workspaceId` parametresini elinde tutuyor (`object.id`'yi ürettiği aynı çağrının parametresi), bu yalnızca insert satırına bir alan eklemek kadar mekanik.

### (d) [ARCHITECT KARARI] `MeetingRetentionSweeperService` — `CalendarSyncPollerService`'in şekli, mod-başına alan temizleme semantiği

```ts
// apps/server/src/notetaker/meeting-retention-sweeper.service.ts
@Injectable()
export class MeetingRetentionSweeperService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.sweepOnce();
    }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) clearInterval(this.intervalHandle);
  }

  async sweepOnce(): Promise<void> {
    const rows = await this.db
      .select(/* id, workspaceId, createdAt, transcriptText, providerRecordingUrl */)
      .from(meetingDetails);
    // (Öneri: `WHERE transcript_text IS NOT NULL OR provider_recording_url IS NOT NULL`
    // ile aday satırları önceden daraltan bir kısmi index -- implementer'a bırakılan
    // bir performans detayı, bu ADR'nin kilitlediği bir karar değil.)

    for (const row of rows) {
      try {
        const mode = await this.resolvePreference(row.workspaceId); // satır yoksa 'transcript-only' (Karar b)
        const ageMs = Date.now() - row.createdAt.getTime();
        const patch = this.computePatch(mode, ageMs, row);
        if (patch) {
          await this.db.update(meetingDetails).set(patch).where(eq(meetingDetails.id, row.id));
        }
      } catch {
        // Bir satırın hatası (ör. tercih okuma hatası, DB geçici arızası)
        // süpürmenin geri kalanını ASLA durdurmaz -- calendar-sync-poller'ın
        // per-account try/catch disiplini birebir.
      }
    }
  }
}
```

**Mod-başına alan temizleme semantiği** (spec'in/insan kararının "sweeper `transcriptText`/`providerRecordingUrl`'i temizler" genel ifadesinin bu ADR'nin somutlaştırdığı hâli — **aşağıda Açık Sorular'da insan re-onayı için işaretlendi**):

| `mode`                | `transcriptText`                                    | `providerRecordingUrl`                                                                                                              |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `transcript-only`     | `createdAt + 30 gün`'e kadar tutulur, sonra `null`  | HER sweep'te hemen `null` (bu modda hiç tutulmuyor)                                                                                 |
| `recording-reference` | HER sweep'te hemen `null` (bu modda hiç tutulmuyor) | süresiz tutulur (zaten yalnızca vendöre bir REFERANS, ADR-0030'un Kademe-0 "yalnızca referans" değişmeziyle tutarlı — TTL'siz)      |
| `summary-only`        | HER sweep'te hemen `null`                           | HER sweep'te hemen `null` (bugün üretilebilecek bir özet YOK, dolayısıyla bu mod PRATİKTE "hiçbir ham veri tutma" anlamına geliyor) |

Bu tablo, Karar (b)'nin "varsayılan neden `summary-only` değil" gerekçesini somutlaştırıyor: `summary-only` seçildiğinde bugün elde hiçbir özet YOKKEN her iki ham alan da hemen temizlenir — bu, kullanıcının "sadece özeti tut" niyetiyle "hiçbir şeyi tutma" sonucu arasındaki farkı ÖRTBAS ETMEMELİ; UI/API bu modu seçen kullanıcıya bunun bugün fiilen "hiçbir ham veri saklanmaz" anlamına geldiğini AÇIKÇA belirtmeli (implementer notu, bu ADR'nin kapsamındaki bir kod değişikliği değil).

### (e) [ARCHITECT KARARI] `ProposedAction` birliği YERİNDE KALIR, `createTaskFromMeeting` oraya eklenir

`ProposedAction`/`proposedActionSchema` **`apps/server/src/ai/parse-command.ts`'te KALIR** — paylaşılan bir pakete TAŞINMAZ (Bağlam madde 4'ün sekiz-tüketicili bulgusu: taşımak yalnızca import yollarını değiştirir, hiçbir mimari fayda getirmez; bu tip bugün `packages/*`'in HİÇBİRİ tarafından tüketilmiyor). Genişletme mekanik:

```ts
// apps/server/src/ai/parse-command.ts
export interface ProposedAction {
  actionId: string;
  type: 'createTask' | 'generateSubtasks' | 'assignPeople' | 'createTaskFromMeeting';
  // ... değişmeyen alanlar
}

export const proposedActionSchema = z
  .object({
    type: z.enum(['createTask', 'generateSubtasks', 'assignPeople', 'createTaskFromMeeting']),
    // ... değişmeyen alanlar
  })
  .array();
```

`renderCommandPrompt` (kullanıcı-komutu ayrıştırma) **DEĞİŞMEZ** — modele hâlâ yalnızca ilk üç tipi öneriyor, `createTaskFromMeeting` yalnızca YENİ `extract-meeting-actions.ts`'in KENDİ prompt'unda istenir. Bu, aynı zod şemasının iki farklı üretim kod yolu tarafından paylaşılmasının (parse-time doğrulama için) hiçbir çapraz-kirlenme riski taşımadığını gösterir: bir kullanıcı komutu asla `createTaskFromMeeting` ÜRETMEZ (prompt'u hiç istemiyor), ama şema onu KABUL EDER — bu zararsız bir fazlalık, spec'in "yeni bir gateway yeteneği eklemeden" kısıtına dokunmuyor.

`decidableActionSchema` (`commands.service.ts`, satır 41-43, `proposedActionSchema.element.extend(...)`) OTOMATIK olarak yeni tipi miras alır — ayrı bir değişiklik gerekmez.

### (f) [ARCHITECT KARARI] `command_proposals.command` toplantı-kaynaklı önerilerde ne taşır

`proposeFromMeeting`, `command` kolonuna transkriptin TAMAMINI YAZMAZ (Bağlam madde 7'nin depolama-ikilenmesi/saklama-kaçağı riski). Bunun yerine sabit, kısa, insan-okunur bir sentetik dize yazılır:

```ts
const command = `[meeting-action-extraction] meetingObjectId=${meetingObjectId}`;
```

Gerçek transkript metni yalnızca AI çağrısına PROMPT olarak girer (`extractMeetingActions`'ın kendi input'u), hiçbir yerde ikinci bir kalıcı kopyası açılmaz — `meeting_details.transcriptText` TEK doğruluk kaynağı olarak kalır, sweeper'ın (Karar d) o satırı temizlemesi `command_proposals`'ta "unutulmuş" bir nüsha bırakmaz.

### (g) [ARCHITECT KARARI] `CommandsModule`, `CommandsService`'i export etmeli

```ts
// apps/server/src/commands/commands.module.ts
@Module({
  imports: [/* değişmez */],
  controllers: [CommandsController],
  providers: [CommandsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  exports: [CommandsService], // YENİ -- bugün yok
})
export class CommandsModule {}
```

Bu olmadan `NotetakerModule`, `CommandsModule`'ü import etse bile `CommandsService`'i enjekte edemez (Nest'in DI kapsamı kuralı). Küçük, mekanik, tek satırlık bir değişiklik — ayrı bir mimari risk taşımıyor.

### (h) `CommandsService`: `recordProposal` çıkarımı, `MEETING_ACTION_EXTRACTOR_ACTOR`, `proposeFromMeeting`, `executeCreateTaskFromMeeting`

`recordProposal` (Bağlam madde 5'in `parse()` satır 185-213'ünden ÇIKARILAN özel yardımcı), imza `(workspaceId, actor, actions, sourceObjectId, command)`, dönüş `CommandsServiceParseResult` (`{proposalId, actions, parseError, message?}`'ın tamamını değil — `parseError`/`message` çağıranın kendi AI-çağrı sonucundan geldiği için, `recordProposal`'a AYRICA parametre olarak geçirilir, bu yardımcı yalnızca event-yazma+dönüş-şekli mekaniğini kapsüller). `parse()` VE yeni `proposeFromMeeting()` bu TEK yardımcıyı çağırır — event yazma mantığı iki yerde KOPYALANMAZ.

```ts
const MEETING_ACTION_EXTRACTOR_ACTOR = { type: 'agent', id: 'meeting-action-extractor' } as const;

async proposeFromMeeting(
  workspaceId: string,
  meetingObjectId: string,
  transcriptText: string,
): Promise<CommandsServiceParseResult> {
  const { actions, parseError, message } = await this.aiUsageService.withWorkspaceAILock(
    workspaceId,
    async () => {
      await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
      await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);
      const model = selectAIModel({ outputType: 'command' });
      return extractMeetingActions({
        provider: this.aiProvider,
        transcriptText,
        model,
        recordUsage: (usage) =>
          this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
      });
    },
  );

  return this.recordProposal(
    workspaceId,
    MEETING_ACTION_EXTRACTOR_ACTOR,
    actions,
    meetingObjectId,
    `[meeting-action-extraction] meetingObjectId=${meetingObjectId}`,
  ); // parseError/message recordProposal'a da geçirilir -- imza yukarıdaki gibi genişletilir
}
```

`MEETING_ACTION_EXTRACTOR_ACTOR`, `COMMAND_PARSER_ACTOR`'dan BİLEREK ayrı bir sabit (aynı `{type:'agent', id}` şekli, farklı `id`) — bir denetim sorgusu ("bu `ActionsProposed` kullanıcı-komutundan mı yoksa otomatik toplantı-tetiklemesinden mi geldi?") event log'un `actor.id` alanından DOĞRUDAN yanıtlanabilir, iki kaynağı KARIŞTIRMADAN (ADR-0015 §d'nin "aktör atfı denetlenebilirliği" ruhunun doğal devamı).

`executeCreateTaskFromMeeting`, `executeDecidedAction`'ın switch'ine YENİ, İZOLE bir dal olarak eklenir — `executeCreateTask`'a HİÇ dokunmaz:

```ts
private async executeCreateTaskFromMeeting(
  workspaceId: string,
  action: DecidableAction,
  approverActor: Actor,
  callerRole: Role,
  causationEventId: string,
): Promise<DecideActionResult> {
  const { actionId } = action;
  try {
    const title = requireStringParam(action.params, 'title');
    const created = await this.objectsService.create(
      workspaceId,
      approverActor,
      { objectType: 'task', title, causationEventId },
      callerRole,
    );

    // assigneeHint/dueDateHint: EN-İYİ-ÇABA (best-effort) çözümleme --
    // çözülemezlerse görev YİNE DE oluşturulur, alan uygulanmadan atlanır.
    // Tam çözümleme mantığı bu ADR'nin KİLİTLEDİĞİ bir karar DEĞİL --
    // aşağıdaki Açık Sorular'da insan re-onayı için işaretlendi.
    await this.applyMeetingHints(workspaceId, created.id, action.params, approverActor, callerRole);

    return { actionId, status: 'executed' };
  } catch (error) {
    return { actionId, status: 'failed', error: toErrorMessage(error) };
  }
}
```

### (i) Webhook tetikleme noktası — `MeetingsService.applyWebhookUpdate`, fire-and-forget + zorunlu catch

Tetikleme koşulu Bağlam madde 8'in `'transcriptText' in update` ayrımının üzerine inşa edilir: yalnızca `update`'te `transcriptText` anahtarı VARSA VE değeri non-null/non-empty İSE VE satırın ÖNCEKİ (güncelleme öncesi) `transcriptText`'i null/boş İDİYSE tetiklenir (yalnızca "az önce bu çağrıyla dolduruldu", her webhook çağrısında değil, transkript dokunulmadan bırakıldığında/açıkça null'a temizlendiğinde asla).

```ts
async applyWebhookUpdate(providerMeetingRef: string, update: {...}): Promise<void> {
  const [row] = await this.db.select().from(meetingDetails)
    .where(eq(meetingDetails.providerMeetingRef, providerMeetingRef)).limit(1);
  if (!row) throw new NotFoundError('Meeting not found for the given webhook reference');

  const wasEmpty = row.transcriptText === null || row.transcriptText === '';
  const newlyPopulated =
    'transcriptText' in update &&
    update.transcriptText !== null &&
    update.transcriptText !== undefined &&
    update.transcriptText !== '' &&
    wasEmpty;

  // ... mevcut update mantığı değişmeden ...
  await this.db.update(meetingDetails).set(values).where(eq(meetingDetails.id, row.id));

  if (newlyPopulated) {
    this.commandsService
      .proposeFromMeeting(row.workspaceId, row.objectId, update.transcriptText as string)
      .catch((error: unknown) => {
        // AI kota/bütçe aşımı DAHİL her hata burada YUTULUR -- bu tetikleyici,
        // kullanıcı-başlatmalı parse()'ın aksine OTOMATİK ve toplantı-başına
        // (calendar-sync-poller'ın per-account catch disipliniyle AYNI ruhta,
        // ADR-0030 §a Kademe-0 hiçbir kullanıcı verisi/API anahtarı LOG'A YAZILMAZ).
        this.logger?.warn('meeting action extraction failed', { meetingObjectId: row.objectId });
      });
  }
}
```

**Fire-and-forget gerekçesi:** webhook çağrısının kendi yanıtı (sağlayıcıya 200 dönmek) aksiyon-çıkarımının bitmesini BEKLEMEMELİ — sağlayıcı vendörünün webhook-yeniden-deneme mantığı (varsa) yavaş bir AI çağrısı yüzünden gereksiz yere tetiklenmemeli. `.catch()` ZORUNLU (CLAUDE.md'nin "asla çıplak throw" değil ama burada asıl risk: unhandled promise rejection sürecin kendisini etkilememeli).

### (j) Minimum keşfedilebilirlik — `GET .../meetings/:meetingId` yanıtı, AYNI rol-kapısı altında

`MeetingsService.getMeetingDetails` (Bağlam madde — `hasAtLeastRole(callerRole, 'member')`, ADR-0030 §h), `transcriptText` gösterilen AYNI koşulda, bekleyen bir öneriyi de ekler:

```ts
return {
  meeting: {
    // ... değişmeyen alanlar ...
    ...(canViewTranscript ? { transcriptText: row.transcriptText } : {}),
    ...(canViewTranscript && pendingProposal
      ? { pendingProposal: { proposalId: pendingProposal.id, actions: pendingProposal.actions } }
      : {}),
  },
};
```

`pendingProposal` sorgusu: `command_proposals`'ta `sourceObjectId = meetingId AND decidedAt IS NULL` (en son/tek satır — bir toplantı için birden fazla AÇIK öneri v0'da beklenmez, ama sorgu en yeni `createdAt`'e göre TEK satır döner, defensif). Yeni bir uç nokta/ekran AÇILMAZ (F2-T16'ya ertelendi) — yalnızca mevcut GET yanıtı genişler.

## Alternatifler ve Reddedilme Gerekçeleri

- **`meeting_details.workspaceId` yerine her sweep'te `objects_view`'a JOIN yapmak.** Reddedildi (Karar c) — `timeblock_external_pushes`/`calendar_events_cache`'in zaten kurduğu "özellik-özel yan-tablo kendi işleyişi için gereken alanları denormalize eder" deseninden sapardı; periyodik bir süpürücü için her satırda bir JOIN, tek bir denormalize kolondan daha pahalı ve daha kırılgan (projeksiyon şeması değişirse JOIN de değişir).
- **`ProposedAction`'ı paylaşılan bir pakete (`packages/shared`) taşımak.** Reddedildi (Karar e) — sekiz mevcut tüketicinin import yolunu değiştirmek, hiçbir `packages/*` paketinin bugün ihtiyaç duymadığı bir taşınma için gereksiz churn; mekanik union-genişletmesi yeterli.
- **Aksiyon-çıkarımı için AYRI bir öneri akışı açmak (ADR-0015'in şemasını genişletmek yerine).** Reddedildi (spec'in Açık Soru 2'sinin kendi önerisi, bu ADR'de onaylandı) — F2-T15/F2-T16'nın TEK bir "öneri" kavramı üzerine inşa edebilmesi, iki paralel onay/denetim modelinden daha basit VE ADR-0015'in zaten kanıtlanmış idempotency/aktör-atfı disiplinini bedavaya kazanıyor.
- **Transkript metnini `command_proposals.command`'a AYNEN kopyalamak.** Reddedildi (Karar f) — depolama ikilemesi + saklama-politikası kaçağı (sweeper `meeting_details`'i temizlese bile `command_proposals`'ta unutulmuş bir kopya kalırdı); sentetik, kısa bir `command` dizesi yeterli ve denetlenebilir (`sourceObjectId` zaten hangi toplantıya ait olduğunu gösteriyor).
- **`summary-only` modunu kod-seviyesi varsayılan yapmak.** Reddedildi (Karar b, insan kararı) — bu kod tabanında hiçbir özetleme yeteneği yok; böyle bir varsayılan, üretilemeyecek bir veriye "dayanan" ve pratikte hiçbir zaman tetiklenmeyen bir temizleme politikasına denk gelirdi.
- **Saklama tercihini per-meeting override ile başlatmak.** Reddedildi (insan kararı, v0 kapsamı) — workspace-geneli tek satır yeterli karmaşıklık/değer dengesini v0 için sağlıyor; per-meeting override gelecekte ayrı bir karar.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** Bu ADR'nin ele aldığı HİÇBİR veri (`meeting_details.transcriptText`/`providerRecordingUrl`, `meeting_retention_preferences.mode`) bir OLAY-günlüğü projeksiyonu DEĞİL — ADR-0030'un zaten kurduğu ayrımın (Karar c: "toplantı alanları potansiyel olarak büyük, `objects_view`'a gömülü DEĞİL") bir devamı: bunlar HAM, üçüncü-taraf kaynaklı veri VE kullanıcı tercihi, ikisi de olay-kaynaklı değil. Sweeper'ın bu verileri SESSİZCE silebilmesi (Karar d), spec'in Açık Soru 5'inin işaret ettiği inceliği doğruluyor: silinen bir transkriptten ÖNCE üretilmiş, ONAYLANMIŞ bir `task` nesnesi bağımsız bir `LuminaObject`'tir (kendi olay-günlüğü kaydı VAR, `ObjectCreated`/`FieldValueChanged` event'leri asla silinmez) — yalnızca KAYNAK, ham transkript projeksiyon-dışı olduğu için silinebiliyor. Bu ADR o ayrımı DEĞİŞTİRMİYOR, yalnızca teyit ediyor.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** `createTaskFromMeeting`, `ProposedAction`'ın VAR OLAN `intent`/`rationale`/`resources`/`rollbackNote` alanlarını AYNEN kullanır — yeni bir alan-şekli İCAT EDİLMİYOR, ADR-0015'in zaten kurduğu payload-seviyesi sözleşme üçüncü bir aksiyon-tipine genişliyor.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR hiçbir export uç noktasına dokunmuyor.
- **"Hassas veri sınıfları buluta ham gönderilmez."** `extractMeetingActions`, transkript metnini `AIProvider.complete()`'e (ADR-0029'un Kademe-1 kategorisine giren, zaten buluta gönderilmesi ONAYLANMIŞ bir veri sınıfı) gönderir — YENİ bir veri sınıfı/yeni bir bulut-çıkışı AÇMIYOR, `parseCommand`'ın zaten yaptığı AYNI türde bir çağrı.

## İnsan Onayı (Plan Mode sonrası, implementasyondan önce)

Aşağıdaki Açık Sorular 1 ve 2, insan tarafından AÇIKÇA onaylandı (architect'in önerisiyle aynen):

- **Açık Soru 1 (assigneeHint/dueDateHint çözümleme):** ONAYLANDI — yalnızca KESİN eşleşme (tam e-posta/görünen-ad; `dueDateHint` yalnızca `Date.parse` ile ayrıştırılabilir ISO-benzeri string). Bulanık/olası eşleşme YOK.
- **Açık Soru 2 (sweeper'ın mod-başına alan temizleme tablosu):** ONAYLANDI — `recording-reference` modunda `providerRecordingUrl` SÜRESİZ tutulur (TTL'siz), tablo aynen yukarıdaki şekliyle uygulanır.
- Açık Soru 3 (TTL başlangıç noktası `createdAt`) ve Açık Soru 4 (yutulan hata görünmez kalır, F2-T16'ya ertelenir) — architect'in önerisi aynen kabul edildi, ek bir kapsam genişlemesi yapılmadı.

## Bilinen Sınırlamalar / Açık Sorular (implementasyondan ÖNCE insan re-onayı gerekli)

1. **[KRİTİK] `assigneeHint`/`dueDateHint` çözümleme mantığı YETERİNCE SPESİFİK DEĞİL.** Onaylanmış plan bu iki alanın "çözülürlerse" `setFieldValues` ile uygulanacağını söylüyor ama BİR hint-string'in gerçek bir `userId`/tarih değerine NASIL eşleneceğini (tam ad eşleşmesi mi, e-posta mi, bulanık/fuzzy arama mı; `dueDateHint`'in hangi formatları kabul edeceği — yalnızca ISO 8601 mi, "yarın"/"gelecek hafta" gibi göreli ifadeler mi) tanımlamıyor. Bu, kendi başına küçük bir tasarım kararı gerektiriyor (muhtemelen `implementer`'a bırakılamayacak kadar belirsiz — yanlış bir kullanıcıya YANLIŞLIKLA görev atama riski taşıyor). **Öneri:** v0 KESİN eşleşmeyle sınırlansın (`assigneeHint` tam olarak bir workspace üyesinin e-postasına/görünen-adına eşleşmezse SESSİZCE atlanır, asla bulanık/olası bir eşleşmeye güvenmez; `dueDateHint` yalnızca `Date.parse` ile ayrıştırılabilir ISO-benzeri bir string ise uygulanır, aksi halde atlanır) — ama bu, insanın AÇIKÇA onaylaması gereken bir öneri, `architect`'in tek başına kilitleyebileceği bir karar değil.
2. **Sweeper'ın mod-başına alan temizleme tablosu (Karar d) insan tarafından AÇIKÇA doğrulanmadı.** Onaylanmış plan yalnızca "sweeper `transcriptText`/`providerRecordingUrl`'i süresi dolunca nullar" dedi, hangi alanın hangi modda TTL'li/TTL'siz/hemen-temizlenen olduğunu belirtmedi — bu ADR'nin yukarıdaki tablosu `architect`'in SOMUTLAŞTIRMASI, insanın önceden onayladığı bir tablo DEĞİL. Özellikle `recording-reference` modunun `providerRecordingUrl`'ü SÜRESİZ tutması (TTL'siz) insanın niyetiyle uyuşuyor mu, yoksa o alan için de bir üst TTL mi olmalı — netleştirilmeli.
3. **Sweeper döngü aralığı (`SWEEP_INTERVAL_MS`) ve TTL'in başlangıç noktası (`createdAt` mi, transkriptin webhook'la DOLDURULDUĞU an mı) belirtilmedi.** Bu ADR `createdAt`'ten ölçmeyi öneriyor (basitlik, `calendar-sync-poller`'ın da tek bir zaman damgasından ölçtüğü emsal) ama bir toplantı davet edildikten GÜNLER sonra transkript dolabilir (bot gecikmesi/uzun toplantı) — bu durumda `createdAt`'ten 30 gün, transkriptin fiilen var olduğu süreden daha kısa bir "gerçek saklama süresi" anlamına gelebilir. Küçük ama kullanıcı beklentisini etkileyebilecek bir fark.
4. **Otomatik-tetiklemeli `proposeFromMeeting`'in yutulan hatası (Karar i) HİÇBİR kalıcı iz bırakmıyor.** F2-T16'nın (otomasyon geçmişi/denetim ekranı) bu görevin kapsamı DIŞINDA olduğu doğru, ama bu şu anlama geliyor: bir workspace'in AI bütçesi tükendiğinde ya da AI sağlayıcısı hata verdiğinde, o toplantının aksiyon-önerisi SESSİZCE hiç oluşmaz VE bunun olduğuna dair hiçbir kullanıcı-görünür sinyal yok (yalnızca sunucu logu, ki CLAUDE.md kullanıcı verisi/API anahtarı loglamayı zaten yasaklıyor — meetingObjectId gibi opak bir kimlik loglamak sorun değil ama kullanıcı bunu GÖRMEZ). **Öneri:** bu v0 için kabul edilebilir kabul ediliyor (F2-T16'nın işi) ama insan bunu AÇIKÇA onaylamalı — alternatif olarak `meeting_details`'e minimal bir `actionExtractionFailedAt` gibi bir bayrak eklemek (F2-T16'dan ÖNCE bile en azından `GET .../meetings/:id` yanıtında "çıkarım denendi ama başarısız oldu" gösterebilmek) bu görevin ufak bir kapsam genişlemesi olur — şu an ÖNERİLMİYOR, yalnızca bir alternatif olarak not ediliyor.
5. **`meeting_details.workspaceId` migration'ının backfill adımı (Karar c) gerçek veride test edilmedi.** `objects_view`'ın HER `meeting` nesnesi için gerçekten tam bir `workspace_id` sağladığı (silinmiş/bozuk bir nesne durumunda NULL dönmeyeceği) `test-writer`'ın migration testinde AÇIKÇA doğrulanmalı — bu ADR bunu VARSAYIYOR (ADR-0030'un kendi `objectId`→workspace çözümleme mantığından, Karar g), ama gerçek bir entegrasyon testiyle KANITLANMADI.

---

**Sıradaki adım:** Bu ADR insan onayına sunulur — özellikle Açık Soru 1 (`assigneeHint`/`dueDateHint` çözümleme kesinliği) ve Açık Soru 2 (mod-başına alan temizleme tablosu) üzerinde AÇIK bir "evet, bu şekilde ilerle" onayı gerekli, çünkü bunlar onaylanmış planın kendisinde bu netlikte YOKTU. Onaylanırsa `test-writer` → `implementer` → `security-reviewer` ritüeline, aşağıdaki gibi bir alt-PR bölünmesiyle geçilebilir:

- **PR1** — `apps/server/src/db/schema`: `meeting_retention_preferences` (yeni tablo) + `meeting_details.workspaceId` (migration + backfill + down script).
- **PR2** — `apps/server/src/notetaker`: `MeetingRetentionSweeperService` + tercih okuma/yazma uç noktası (CRUD'u bu görevin kapsamına dahilse) + `NotetakerModule` wiring.
- **PR3** — `apps/server/src/ai`: `ProposedAction`/`proposedActionSchema`'ya `createTaskFromMeeting` eklenmesi + `extract-meeting-actions.ts` (yeni, `parseCommand`'ın kardeşi).
- **PR4** — `apps/server/src/commands`: `recordProposal` çıkarımı + `proposeFromMeeting` + `executeCreateTaskFromMeeting` + `MEETING_ACTION_EXTRACTOR_ACTOR` + `CommandsModule` export.
- **PR5** — `apps/server/src/notetaker`: `MeetingsService.applyWebhookUpdate`'in tetikleme noktası (`CommandsModule` importu) + `getMeetingDetails`'in `pendingProposal` genişlemesi.
