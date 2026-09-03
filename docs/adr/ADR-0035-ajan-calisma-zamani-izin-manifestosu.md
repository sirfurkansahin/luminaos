# ADR-0035: Ajan Çalışma Zamanı — İzin Manifestosu, Hafif Sandbox, Kaynak Sınırları (Faz 3 Açılışı)

**Durum:** Kabul edildi (Plan Mode oturumunda insan onayı zaten alındı — bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-03
**İlgili görev:** F3-T1 — Ajan çalışma zamanı: sandbox, kaynak sınırları, izin manifestosu (veri kapsamı × aksiyon × zaman penceresi). Spec dosyası: `docs/specs/F3-E1/F3-T1-ajan-calisma-zamani.md` (bu ADR ile paralel olarak `docs-writer` tarafından yazıldı) — `docs/PLAN.md` §"Epik F3-E1: Agent Runtime + Skill SDK (Kapsam J)" satırı bu ADR'nin tek plan kaynağı.
**İlgili plan referansı:** `docs/PLAN.md`, FAZ 3'ün açılış görevi (F3-T1) — Epik F3-E1'in ilk üç görevinden (F3-T1/F3-T2/F3-T3) yalnızca F3-T1'i kapsar. CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin her iki fıkrasını da tetikliyor: (i) yeni bir ajan-yetkilendirme kavramı, "Mimari Değişmezler"in "Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar" maddesiyle doğrudan etkileşiyor; (ii) bu görevin `checkPermission`/`executeAgentAction` sözleşmesi F3-T2 (Skill SDK) ve F3-T3'e (ajan-insan etkileşimi) dayatılan bir kontrat.

> Bu ADR, ADR-0024'ün (F2-T8, Bellek Kullanım Politikası) doğrudan mimari devamıdır — ADR-0024 kendi metninde şunu önceden not etmişti: "bu görevin tanımladığı `agentIdentifier` şeması, henüz kurulmamış F3-T1'e uzlaşması gereken bir sözleşim dayatıyor." Bu ADR o sözleşmeyi kapatıyor: F3-T1 gerçekten kuruluyor, ve `agentIdentifier`'ın ADR-0024 §(a)'da bilinçli olarak kısıtlanmamış string sözleşmesi burada da AYNEN korunuyor (Karar c).
>
> Aşağıdaki (a)-(j) maddelerinden (a)/(b)/(f)/(h) insan onaylı geldi — Plan Mode oturumunda doğrudan onaylandı, bu ADR onları icat etmiyor, aynen kayıt altına alıyor. (c)/(d)/(e)/(g)/(i)/(j) bu ADR'nin kendi sorumluluğu olan architect-seviyesi tasarım detaylarıdır — insana tekrar sorulmadan, onaylanan sınırlar içinde ADR adımında sonuçlandırılıyor (CLAUDE.md "Çalışma Ritüeli").

## Bağlam

Keşif üç doğrudan emsalı doğruladı:

1. **`packages/memory/src/memory-access-policy.ts` + `is-agent-allowed-to-access-memory.ts`** (ADR-0024, F2-T8) — grant/revoke şekli, fail-closed değerlendirme (`!policy → false`, `revokedAt !== null → false`), 3-parça doğal anahtar `(workspaceId, userId, agentIdentifier)`. Bu ADR'nin en yakın emsali, ama Karar (b)/(d)'de bilinçli olarak SAPILAN bir emsal — MemoryAccessPolicy kişisel bellek-erişim rızası soruyor, bu ADR'nin manifestosu workspace-seviyesi çalışma-zamanı yetkisi soruyor.
2. **`apps/server/src/ai/ai-usage.service.ts` (`AIUsageService`)** — `withWorkspaceAILock` (`pg_advisory_lock(hashtext($1)::bigint)` ile per-workspace serileştirme), `assertAITokenQuotaNotExceeded`/`assertAICostBudgetNotExceeded`'ın kota-aşımında `QuotaExceededError` fırlatması, `recordAIUsage`'ın best-effort-never-throws (kendi try/catch'i, kendi olay akışı) tasarımı, ve sabit `AI_GATEWAY_ACTOR = {type:'agent', id:'ai-gateway'}` aktör deseni ("otomatik bir tamamlama hâlâ gerçek bir ajan aksiyonudur"). Karar (g)/(i)'nin doğrudan kaynağı.
3. **`packages/automation`** (ADR-0032, F2-T15) — en yakın "yeni, bağımsız event-sourced domain paketi" emsali: `core-objects`'e bağımlılık YOK, yalnızca `@luminaos/shared` + saf TypeScript, kendi `trigger-commands.ts`/`trigger-replay.ts` çiftiyle olay-kaynaklı CRUD, workspace-genelinde admin+ RBAC deseni (`AutomationTriggersService`, ADR-0032 §h). Bu ADR'nin `packages/agent-runtime` paket yerleşimi ve `AgentPermissionManifestsService`'in RBAC/yapı deseni bunu birebir izler.
4. **`packages/shared/src/events/domain-event.ts`** — `Actor = {type: 'user'|'agent'|'system', id: string}` zarfı; bu ADR'nin olay aktörleri bu tipi genişletmeden kullanır.

Çözülmesi gereken merkezi soru (insan onaylı (a)/(b)/(f)/(h) hariç, bu ADR'nin görevi): sandbox'ın somut çalıştırma şekli (c), izin manifestosunun 3 boyutunun (veri kapsamı × aksiyon × zaman penceresi) v0 somut tipleri, ADR-0024'ün doğal-anahtar deseninden neden sapıldığı, ve kaynak-sınırı mekanizmasının hangi kısmının in-memory hangi kısmının DB-destekli olacağı.

## Karar

### (a) Sandbox modeli — hafif, süreç-içi çalıştırma sınırı (insan kararı, aynen kayıt)

Gerçek OS-seviyesi süreç/VM izolasyonu YOK — `worker_threads` yok, `child_process` yok, `vm2`/`isolated-vm` yok. Bunun yerine tek bir yardımcı fonksiyon:

```ts
export type AgentActionResult<T> =
  | { outcome: 'success'; value: T }
  | { outcome: 'timeout' }
  | { outcome: 'failure'; error: unknown };

export async function runInAgentSandbox<T>(
  fn: () => Promise<T>,
  options: { timeoutMs: number },
): Promise<AgentActionResult<T>>;
```

`runInAgentSandbox`, senkron `throw`'ları, reddedilen promise'leri VE hiç çözülmeyen (never-resolving) promise'leri aynı şekilde yakalar — bir `Promise.race` ile zaman-aşımı sinyali koşturarak — ve çağırana ASLA bir exception sızdırmaz, her zaman yapılandırılmış `AgentActionResult<T>` döndürür.

**Gerekçe:** Bugün koşturulacak hiçbir üçüncü-taraf/imzasız kod YOK (Skill SDK'nın kod-imzalama mekanizması F3-T2, ayrı ve gelecekteki bir görev). Bu nedenle bugün gerçek OS/VM izolasyonuna yatırım yapmak, henüz var olmayan bir tehdit modeline karşı erken (premature) bir yatırım olurdu. F3-T2'de gerçek beceri-kodu çalıştırma ihtiyacı doğduğunda bu karar yeniden gözden geçirilir.

### (b) İzin manifestosu kalıcılığı — olay-kaynaklı, grant/revoke, 3 boyutlu (insan kararı, aynen kayıt)

ADR-0024'ün `MemoryAccessPolicy` desenini doğrudan genişletir — ama 2 boyut yerine 3: veri kapsamı × aksiyon tipi × zaman penceresi (MemoryAccessPolicy'nin ikili allow/revoke'una karşı). Olay-kaynaklı: `AgentPermissionGranted`/`AgentPermissionRevoked` (geçmiş zaman, CLAUDE.md kuralı), projeksiyon `agent_permission_manifests` tablosuna upsert/revoke yazar — fiziksel `DELETE` YOK, ADR-0024 §(j)'nin AYNI tombstone ilkesi (revoke, `revokedAt`'ı doldurur, satırı silmez).

### (c) 3 boyutun v0 somut tipleri (architect kararı — minimallik gerekçeli)

```ts
/** Deliberately NOT a closed union/enum — mirrors ADR-0024 §(a)'nın
 * `agentIdentifier: string` gerekçesini: F3-T2 (Skill SDK) bu vokabüleri
 * ileride dolduracak; bugün bir union kilitlemek ADR-0024'ün kaçındığı AYNI
 * geriye-dönük-uyumsuzluk riskini taşırdı. */
export type AgentActionType = string;

/** `ObjectType[]` (@luminaos/core-objects) DEĞİL, düz `string[]` —
 * `packages/agent-runtime` diğer domain paketlerinden bağımsız kalmalı
 * (CLAUDE.md: "Domain paketleri framework import edemez"; `packages/automation`
 * ve `packages/memory`'nin ikisi de yalnızca `@luminaos/shared`'a bağımlı,
 * bu paket de aynı izolasyonu korur). */
export interface AgentDataScope {
  objectTypes: string[] | 'all';
}

/** Basit, sınırlı bir pencere — v0'da yineleyen/cron-benzeri bir zamanlama
 * YOK; somut bir yineleme ihtiyacı henüz yok, F3-T2/F3-T3'ün varsayımsal
 * gereksinimleri için önden mühendislik yapılmıyor. */
export interface AgentTimeWindow {
  startsAt: Date | null;
  expiresAt: Date | null;
}
```

Yeniden-grant (bir agent zaten aktif bir manifestoya sahipken tekrar grant edilirse) bir UPSERT'tir — manifesto satırının kapsam/aksiyon/pencere alanlarının YERİNE geçer, ayrı/bağımsız bir ek satır DEĞİL. Bu, "bu ajanın bu workspace'teki şu anki etkin izni ne" sorusunun her zaman TEK bir satırdan cevaplanabilir kalmasını garanti eder.

### (d) ADR-0024'ün doğal anahtarından sapma — 2 parçalı `(workspaceId, agentIdentifier)` (architect kararı, gerekçeli)

MemoryAccessPolicy'nin 3-parçalı `(workspaceId, userId, agentIdentifier)` anahtarının AKSİNE, bu ADR'nin manifestosu 2-parçalı `(workspaceId, agentIdentifier)` — `userId` YOK.

**Gerekçe:** Bir ajanın bir workspace'teki _çalışma-zamanı yetkisi_, bir insan admin'in verdiği workspace-seviyesi bir buyruktur — `AutomationTriggersService`'in düz, workspace-genelinde, admin+ RBAC desenine (ADR-0032 §h: "bir tetikleyici HER ZAMAN workspace-genelinde, asla kişisel değil") birebir benzer. Bu, MemoryAccessPolicy'nin sorduğu _kişisel_ rıza sorusundan ("bu ajan BENİM belleğime erişebilir mi") tamamen farklı bir soru. Bu ADR'nin manifestosu `MemoryAccessPolicy`'nin YERİNE geçmez veya onu değiştirmez — ikisi FARKLI sorulara cevap vererek BİRLİKTE var olur, ve yalnızca `agentIdentifier` string konvansiyonunu paylaşırlar.

### (e) F3-T2/F3-T3'e ileriye dönük ilişki (architect kararı)

`checkPermission`/`executeAgentAction` giriş noktalarının bu görevde HİÇBİR gerçek tüketicisi yok — F3-T2'nin beceri-çalıştırma akışı ve F3-T3'ün ajan-insan etkileşimi bu fonksiyonların ilk gerçek çağıranları olacak (gelecekteki görevler). Bu, ADR-0024'ün kendi `isAgentAllowedToAccessMemory`'sini yazıldığı anda tüketicisiz bırakma kabulüyle AYNI, bilinçli kabul edilmiş bir v0 riski.

### (f) Mevcut AI orkestratörleri RETROFIT EDİLMEZ (insan kararı, aynen kayıt)

`TRIGGER_ENGINE_ACTOR`, `TRIGGER_SUGGESTION_ACTOR` (`apps/server/src/trigger-suggestions/trigger-suggestions.service.ts`), `MEETING_ACTION_EXTRACTOR_ACTOR`, `COMMAND_PARSER_ACTOR` (`apps/server/src/commands/commands.service.ts`) mevcut RBAC-only (`hasAtLeastRole`) kapılamasını TAMAMEN DEĞİŞTİRMEDEN korur. Bu ADR'nin manifestosu GELECEKTEKİ otonom ajanlar için yeni altyapıdır — bugün prodüksiyonda zaten çalışan dört orkestratörün bir retrofit'i DEĞİLDİR.

### (g) Kaynak-sınırı mekanizması bölünmesi — eşzamanlılık in-memory, hız-sınırı DB-destekli (architect kararı, gerekçeli)

**Eşzamanlılık tavanı** ("bu ajanın şu an kaç aksiyonu koşuyor") — süreç-yerel, `Map<string, number>`-destekli basit bir acquire/release muhafızı. Gerekçe: bugün cross-process koordinasyon altyapısı YOK (Redis vb. yok) ve bunu bugünden inşa etmeyi gerektirecek gerçek bir dağıtık ajan iş yükü yok; bu zaten Karar (a)'nın hafif süreç-içi sandbox'ı için yaşayan, per-process bir gerçek.

**Hız sınırı** ("son N dakikada kaç aksiyon") — DB-destekli, `AIUsageService`'in TAM AYNI şeklini izler: `withWorkspaceAILock` → sayım-sorgusu → aşımda `QuotaExceededError` → best-effort kayıt — yeni, analog bir `AgentResourceLimitsService` üzerinden (`AIUsageService`'in kendisi TOKEN/MALİYET'e özel olduğundan doğrudan yeniden kullanılmaz, yalnızca ŞEKLİ kopyalanır). Gerekçe: bir hız sınırı süreç yeniden başlatmalarına dayanmalı ve denetlenebilir olmalı — bunlar in-memory bir sayaçla sağlanamayan iki özellik.

### (h) v0'da UI YOK (insan kararı, aynen kayıt)

Yalnızca backend — API + testler. Manifesto yönetimi için bir admin panel bu görevin kapsamında DEĞİL.

### (i) Aktör konvansiyonları

- `AgentPermissionGranted`/`AgentPermissionRevoked` → `{type:'user', id: <yetkiyi veren admin'in id'si>}` — bir insan yetkiyi veriyor/geri alıyor, MemoryAccessPolicy'nin `userId = actor.id` konvansiyonunun aynısı.
- Aksiyon-çalıştırma defteri olayları (`AgentActionExecutionRecorded` veya benzeri) → `{type:'agent', id: agentIdentifier}` — `AI_GATEWAY_ACTOR`'ın AYNI gerekçesi: "otomatik bir tamamlama hâlâ gerçek bir ajan aksiyonudur", bir sistem-yazarlı defter kaydı DEĞİL.

### (j) Olay payload'larında tarih işleme

Tarihler olay payload'ı (jsonb) içinde ISO-8601 string olarak saklanır — payload şemaları `z.string()` datetime doğrulaması kullanır, çıplak `z.date()` DEĞİL — ve yalnızca servis/projeksiyon sınırında gerçek `Date`'e dönüştürülür/geri dönüştürülür. Gerekçe: olay payload'ları jsonb'dir (native `Date` desteği yok), payload'a ham `Date` karıştırmak kod tabanında tutarsız (de)serileştirme riski taşır.

## Somut Şekiller

```ts
// packages/agent-runtime/src/agent-permission-manifest.ts
export interface AgentPermissionManifest {
  id: string;
  workspaceId: string;
  agentIdentifier: string;
  dataScope: AgentDataScope;
  actionTypes: AgentActionType[];
  timeWindow: AgentTimeWindow;
  grantedAt: Date;
  revokedAt: Date | null;
}
```

```ts
// apps/server/src/db/schema/agent-permission-manifests.ts
export const agentPermissionManifests = pgTable(
  'agent_permission_manifests',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
    dataScope: jsonb('data_scope').notNull(),
    actionTypes: jsonb('action_types').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agent_permission_manifests_workspace_agent_key').on(
      table.workspaceId,
      table.agentIdentifier,
    ),
  ],
);

// apps/server/src/db/schema/agent-action-executions.ts — insert-only ledger
export const agentActionExecutions = pgTable('agent_action_executions', {
  id: varchar('id', { length: 26 }).primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentIdentifier: varchar('agent_identifier', { length: 100 }).notNull(),
  actionType: varchar('action_type', { length: 100 }).notNull(),
  outcome: varchar('outcome', { length: 20 }).notNull(), // 'success' | 'timeout' | 'failure'
  executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Migration'lar: `0037_*.sql` (`agent_permission_manifests`), `0038_*.sql` (`agent_action_executions`) — `apps/server/src/db/migrations/0036_zippy_ghost_rider.sql`'den sonraki ilk boş numaralar, her ikisi de down script'iyle (CLAUDE.md: "Migration'ı down script'i olmadan yazma").

Servisler: `AgentPermissionManifestsService` (grant/revoke/get, `AutomationTriggersService`'in CRUD+RBAC deseni), `AgentResourceLimitsService` (Karar g). Paket: `packages/agent-runtime/` — yeni, bağımsız, `packages/automation`'ın izlediği desen (yalnızca `@luminaos/shared` + saf TypeScript, `core-objects`'e bağımlılık YOK).

## Alternatifler ve Reddedilme Gerekçeleri

- **Gerçek OS/VM sandbox'ı (worker_threads/child_process/vm2/isolated-vm).** Reddedildi (Karar a) — bugün koşturulacak hiçbir üçüncü-taraf/imzasız kod yok (Skill SDK'nın kod-imzalama mekanizması F3-T2'de); bu yatırımı bugün yapmak henüz var olmayan bir tehdit modeline karşı erken yatırım olurdu.
- **`AgentActionType` için kapalı bir enum/union.** Reddedildi (Karar c) — ADR-0024 §(a)'nın kendi `agentIdentifier: string` gerekçesiyle aynı: F3-T2 (Skill SDK) bu vokabüleri ileride dolduracak, bugün kilitlemek geriye-dönük uyumsuzluk riski taşırdı.
- **MemoryAccessPolicy'nin BİREBİR 3-parçalı `(workspaceId, userId, agentIdentifier)` anahtarını yeniden kullanmak.** Reddedildi (Karar d) — bu ADR'nin manifestosu workspace-seviyesi, admin-verilen bir çalışma-zamanı yetkisi (ADR-0032 §h'nin desenine benzer), MemoryAccessPolicy'nin kişisel rıza sorusundan farklı bir soru; aynı anahtarı zorlamak iki farklı kavramı yapay olarak birleştirirdi.
- **Dört mevcut AI orkestratörünü (`TRIGGER_ENGINE_ACTOR`, `TRIGGER_SUGGESTION_ACTOR`, `MEETING_ACTION_EXTRACTOR_ACTOR`, `COMMAND_PARSER_ACTOR`) bu manifestoya retrofit etmek.** Reddedildi (Karar f) — bunlar bugün RBAC-only kapılamayla prodüksiyonda çalışıyor; bu ADR'nin manifestosu gelecekteki otonom ajanlar için yeni altyapı, çalışan bir şeyin gereksiz bir yeniden-yazımı değil.
- **v0'da bir yönetim UI'ı inşa etmek.** Reddedildi (Karar h) — `agentIdentifier` bugün geliştirici/sistem düzeyinde bir kavram, gerçek son-kullanıcıya anlamlı bir arayüz sunacak kadar somut değil; ADR-0024 §(d)'nin AYNI gerekçesi.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** `agent_permission_manifests` `AgentPermissionGranted`/`Revoked` olaylarının salt bir projeksiyonu; `agent_action_executions` insert-only bir defter (audit ledger), kendi olay akışından türer.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu ADR bu sözleşmeyi DEĞİŞTİRMEZ — `runInAgentSandbox`'ın `AgentActionResult` şekli bu sözleşmenin YERİNE geçmez, yalnızca çalıştırma-zamanı hata-kapsülleme mekanizmasıdır; niyet/gerekçe/kaynak/geri-alma-planı alanları F3-T4'ün (Cam Kutu Otonomi, "uçuş kayıt cihazı") kapsamında ayrıca ele alınacak.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR hiçbir export uç noktasına dokunmuyor.
- **Hassas veri sınıflarının buluta ham gönderilmemesi.** Bu ADR'nin manifestosu HANGİ veri kapsamına (`AgentDataScope`) erişilebileceğini sınırlar ama sınıflandırma/yönlendirme mantığına dokunmaz — bu, F3-T12'nin (Hibrit AI) kapsamı.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- Faz 3'ün açılış görevi, ADR-0024'ün önceden işaret ettiği "F3-T1'e uzlaşması gereken sözleşim" borcunu kapatıyor — `agentIdentifier` artık iki bağımsız, birbirini SÜPÜRMEYEN sözleşmede (kişisel rıza + workspace yetkisi) aynı, kısıtlanmamış string konvansiyonuyla yaşıyor.
- `packages/agent-runtime` bağımsız, framework'süz bir paket olarak `packages/automation`'ın kanıtlanmış iskelet desenini üçüncü kez tekrarlıyor — bu deseni tek-seferlik bir çözüm olmaktan çıkarıp gerçek bir emsale dönüştürüyor.
- Sandbox/kaynak-sınırı/manifesto tasarımının üç ayrı sorusu (izolasyon derinliği, kalıcılık şekli, hız-sınırı mekanizması) koddan önce, tek tutarlı gerekçeyle kapatıldı.

**Neyi erteliyoruz / kabul ediyoruz:**

- `checkPermission`/`executeAgentAction`'ın gerçek bir tüketicisi yok (Karar e) — F3-T2/F3-T3 gelene kadar. ADR-0024'ün kendi kabul ettiği AYNI YAGNI riski.
- Gerçek OS/VM izolasyonu yok (Karar a) — F3-T2'de imzalı beceri kodu çalıştırma ihtiyacı doğduğunda bu karar yeniden gözden geçirilecek.
- Zaman penceresi yineleme/cron desteklemiyor (Karar c) — somut bir ihtiyaç doğduğunda ayrı bir karar/migration gerektirecek.
- Eşzamanlılık tavanı süreç-yerel (Karar g) — sunucu çoklu-süreç/çoklu-instance ölçeklendiğinde bu sınır per-process kalır, cross-process bir eşzamanlılık garantisi vermez; gerçek bir dağıtık iş yükü doğduğunda Redis-destekli bir mekanizmaya geçiş ayrı bir karar gerektirecek.
- v0'da manifesto yönetimi için UI yok (Karar h) — gerçek Agent Runtime kullanıma açıldığında ayrı bir görev.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E1/F3-T1-ajan-calisma-zamani.md`) zaten yazıldı (bu ADR ile paralel). Bu ADR'nin onayı üzerine doğrudan PR1'e (`packages/agent-runtime` saf domain) `test-writer` ile başlanır:

```
docs/adr/ADR-0035-ajan-calisma-zamani-izin-manifestosu.md'deki Karar (a)-(j)'yi ve
docs/specs/F3-E1/F3-T1-ajan-calisma-zamani.md'nin Kabul Kriterleri'ni temel alarak, F3-T1
PR1 (packages/agent-runtime saf domain: AgentPermissionManifest tipleri, olay şemaları,
assertValidManifestGrant, evaluateManifestGrant, runInAgentSandbox) için test-writer ile
başarısız testleri yaz.
```
