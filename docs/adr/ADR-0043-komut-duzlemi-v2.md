# ADR-0043: Komut Düzlemi v2 — Niyet Ayrıştırıcı → Modül/Aksiyon Yönlendirme, Ambient Öneri Yüzeyi (Epik F3-E3'ün Üçüncü ve SON Görevi, Kapsam M'in TEK Görevi)

**Durum:** Kabul edildi — 3 merkezi ürün-kapsam kararı (ambient yüzeyin v0'da SIFIR yeni AI-tetikleme ile yalnızca ZATEN var olan bekleyen-öneri verisini pasif göstermesi [insan kararı 1], F3-T7/F3-T8'in artifact/widget üretiminin niyet ayrıştırıcının gönderilebilir aksiyon kümesine DAHİL EDİLMEMESİ [insan kararı 2], ve komut paletinin (Cmd+K) BU GÖREVDE gerçekten `CommandsService.parse()`'a bağlanması [insan kararı 3]) bu Plan Mode oturumunda insan tarafından ÖNCEDEN dikte edildi (mimarın çıkarımı DEĞİL, ADR-0041/42'nin AYNI disipliniyle aşağıda ayrıca işaretlendi). Bunların ÜZERİNE inşa edilen somut mimari (action registry'nin gerçek şekli/yerleşimi, registry'nin `dispatchExecute` switch'iyle İLİŞKİSİ, palette-parse akışının render/RBAC/durum-yönetimi, ambient rozetin veri kaynağı/polling/tıklama-hedefi, registry'nin İKİNCİ gerçek tüketicisi olarak `AutonomyTierPanel`'in mevcut kod-tekrarının giderilmesi) mimarın KENDİ çıkarımıdır, Karar (a)-(h)'de ayrıca işaretlenmiştir.
**Tarih:** 2026-09-12
**İlgili görev:** F3-T9 — Komut düzlemi v2: niyet ayrıştırıcı → modül/aksiyon yönlendirme; ambient öneri yüzeyi. `docs/PLAN.md` satır 289, FAZ 3, Epik F3-E3'ün ÜÇÜNCÜ ve SON görevi (Kapsam L'nin tamamlanmasının ardından, Kapsam M'in — "Intent-first UI" — TEK görevi) — F3-T7 (Artifact boru hattı, ADR-0041)/F3-T8 (Sorgu→Canlı Widget, ADR-0042)'den bağımsız bir alt-kapsamda, ama AYNI Epik içinde, ikisinin de `main`'e tam birleştiği bir noktadan başlıyor.
**İlgili plan referansı:** CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin İKİNCİ fıkrasını tetikliyor: bu karar birden fazla pakete (`packages/agent-runtime`, `apps/server/src/commands`, `apps/web`) VE gelecekteki görevlere dayatılan yeni bir sözleşim (action registry'nin `{actionType, module, label}` şekli) tanımlıyor — `docs/PLAN.md`'nin §5 "Intent-first UI" mimari-ilke cümlesinin ("Komut düzlemi tüm modül aksiyonlarını tek kayıt defterinden çağırır — UI menüleri de aynı kayıttan üretilir, ikilik oluşmaz") somutlaştırılmasıdır.

> Bu görev, `docs/PLAN.md`'de F3-T9 için tek bir görev satırı + tek bir mimari-ilke cümlesi DIŞINDA HİÇBİR elaborasyon bulunmadığı, bir `explorer` alt-ajanının doğrudan koddan doğruladığı, açıkça olağandışı bir şekilde az-belirtilmiş bir görev. Bu ADR'nin en kritik bulgusu şu: **komut/aksiyon/otonomi/ledger altyapısının NEREDEYSE TAMAMI (F1-T16, F2-T16, F3-T5, F3-T4 üzerinden) ZATEN VAR** — `CommandsService.parse()`, `POST .../commands/parse`, `POST .../commands/:id/decide`, `GET .../commands/proposals`, `AutonomyTierSettingsService.resolveTier` (genel, `action.type` string'ine göre ÇALIŞAN), `AutomationHistoryPanel.tsx` (TAM bir onayla/reddet UI'si, `useProposalsQuery`/`useDecideProposalMutation` ile ZATEN `App.tsx`'te mount edilmiş). Bu ADR'nin gerçek işi bu yüzden "sıfırdan bir komut düzlemi inşa etmek" DEĞİL — **var olan parçaları BİRBİRİNE bağlamak** (palette → `parse()`) VE PLAN.md'nin somut olarak adlandırdığı TEK gerçek boşluğu (bir action registry, çünkü bugün `dispatchExecute`'un düz switch'i "yönlendirme"nin TAMAMI VE `AutonomyTierPanel.tsx`'in `KNOWN_ACTION_TYPES`'ı zaten TAM OLARAK PLAN.md'nin uyardığı "ikilik" örneği) kapatmak.

## Bağlam

Doğrudan koddan doğrulandı (bir `explorer` alt-ajanı VE mimar tarafından iki ayrı turda):

1. **`apps/server/src/ai/parse-command.ts`** — `ProposedAction.type` 6-değerli union (`createTask|generateSubtasks|assignPeople|createTaskFromMeeting|createTaskFromTrigger|reconfigureAgentPermissions`). `ALLOWED_PARSE_COMMAND_TYPES` (satır 72-76, **private, export edilmiyor**) yalnızca İLK 3'üne `parseCommand()` üzerinden izin veriyor — diğer 3'ü kendi özel extractor'larına (`extractMeetingActions`/`extractDirectMessageReconfiguration`, ikincisi senkron `hasAtLeastRole(callerRole,'admin')` kontrolüyle) ayrılmış, güvenlik-inceleme gerekçesiyle (F3-T3 PR4 yorumu: "parse()'ın çağıranı member+, admin-gated `reconfigureAgentPermissions`'a sızıntı riski").
2. **`apps/server/src/commands/commands.service.ts`** — TAM akış doğrulandı: `parse()`/`propose*` (4 kaynak) → `routeProposedActions` (satır 700-788) `AutonomyTierSettingsService.resolveTier(workspaceId, action.type)`'ı HER aksiyon için, `action.type` STRING'ine göre GENEL şekilde çağırıyor (RBAC parametresi YOK, unset'te fail-safe `'propose'`) → `'act_and_notify'` aksiyonları `decide()`'ı TAMAMEN atlayıp ANINDA yürütülür (`executeAutonomousAction`) VE `remaining`'e (dolayısıyla `command_proposals.actions`'a) HİÇ GİRMEZ → geriye kalan (`'propose'`+`'approve_and_act'`) HER ZAMAN `recordProposal`'a (boş bile olsa) geçer → EĞER `remaining` boş DEĞİLSE VE tamamı `'approve_and_act'` İSE `decideAsSystem` ile OTOMATİK karara bağlanır → `dispatchExecute` (satır 1060-1105) TÜM 6 tip üzerinde DÜZ bir `switch` — **bugünkü "yönlendirme"nin TAMAMI budur, PLAN.md'nin "action registry" ilkesinin doldurmaya işaret ettiği TAM boşluk.**
3. **`CommandsController`** (`apps/server/src/commands/commands.controller.ts`) — `POST parse` (satır 49-59, `SessionAuthGuard`+`WorkspaceMembershipGuard`, EK admin-gate YOK), `GET proposals` (satır 73-101, `pendingOnly`/`limit`/`cursor` query-param'ları, RBAC `member`+ SERVİS katmanında), `POST :proposalId/decide` (satır 103-115) — **ÜÇÜ DE ZATEN VAR, HTTP yüzeyinde BU GÖREV İÇİN sıfır yeni backend rota gerekiyor.**
4. **`CommandsService.listProposals`** (satır 1569-1605) — `pendingOnly=true` filtresi `isNull(commandProposals.decidedAt)`'e derleniyor; **kritik, KENDİ başına yeterli OLMAYAN bir nüans (aşağıda Karar e'de ele alınıyor):** `routeProposedActions`'ın `remaining.length > 0 && ...` kontrolü (satır 771) `remaining` BOŞSA (tüm aksiyonlar `'act_and_notify'`) `decideAsSystem`'i HİÇ ÇAĞIRMIYOR — yani `actions:[]` olan bir proposal satırı `decidedAt=null` olarak SONSUZA KADAR kalıyor, `pendingOnly=true` filtresinde görünmeye DEVAM EDİYOR, ama İNSANIN karar vermesi gereken SIFIR aksiyon TAŞIYOR. `listProposals` `actions` alanını (jsonb, tam dizi) HER ZAMAN döndürdüğü için bu, istemci tarafında `actions.length > 0` ek filtresiyle ÜCRETSİZ düzeltilebilir bir durum — yeni bir backend alanı/kolon GEREKMİYOR.
5. **`packages/agent-runtime/src/autonomy-tier.ts`** — `AUTONOMY_GOVERNANCE_FLOOR` (satır 35) şu an `['reconfigureAgentPermissions']`; `AutonomyTierSettingsService.set` (`apps/server/src/agent-runtime/autonomy-tier-settings.service.ts:80-122`) bunu `admin`+ RBAC ile ZORLUYOR. **Otonomi-kademesi ZATEN GENEL olarak bağlı** — bu ADR'nin YENİ ekleyeceği HİÇBİR aksiyon tipi (bu görev sıfır yeni aksiyon tipi eklemiyor, aşağıda Karar b) olmadığından, bu servise HİÇBİR değişiklik gerekmiyor.
6. **`apps/web/src/views/shared/CommandPalette.tsx`** — BUGÜN SALT arama/navigasyon (`useSearchQuery`/`useExternalSearchQuery`, debounce, ok-tuşu/Enter ile nesneye git). `CommandsService.parse()`'a HİÇ bağlı DEĞİL. Tek istisna: sabit-kodlanmış "Toplantıya bot davet et" hızlı-aksiyonu (satır 25-43, `rawQuery`'ye anahtar-kelime eşleşmesiyle koşullu render edilen, arrow-key navigasyonuna DAHİL OLMAYAN, ayrı bir statik satır) — bu ADR'nin Karar (c)'sinin doğrudan ödünç aldığı UI deseni.
7. **`apps/web/src/lib/apiClient.ts`** — `listProposals`/`decideProposal` (satır 715-750) **ZATEN VAR** (F2-T16 PR4). `POST .../commands/parse` için istemci sarmalayıcısı ise **YOK** — repo-çapında `commands/parse` dizesi için sıfır eşleşme.
8. **`apps/web/src/hooks/useProposalsQuery.ts`** — `useProposalsQuery`/`useDecideProposalMutation` **ZATEN VAR** (F2-T16 PR4), `['proposals', workspaceId, filter]` sorgu-anahtarı, `onSuccess`'te `['proposals', workspaceId]` ÖN-EKİYLE invalidation. Sıfır polling (`refetchInterval` YOK) — bu ADR'nin YENİ tanıttığı şey.
9. **`apps/web/src/views/shared/AutomationHistoryPanel.tsx`** — **TAM, çalışan bir onayla/reddet UI'si ZATEN VAR**: `useProposalsQuery(workspaceId)` (filtresiz) + `useDecideProposalMutation`, `data.proposals`'ı `decidedAt`'e göre pending/decided'a ayırıyor, her pending aksiyon için `intent` + Onayla/Reddet butonları (`decideMutation.mutate({proposalId, decisions:[{actionId, decision}]})`). **`App.tsx`'te satır 118'de ZATEN mount edilmiş** (`McpAccessPanel`/`WebhookSubscriptionsPanel`'in hemen ardından, `TriggerSuggestionsPanel`/`AgentDirectoryPanel`'den ÖNCE), flat dev-shell içinde her zaman görünür.
10. **`apps/web/src/views/shared/AutonomyTierPanel.tsx`** — `KNOWN_ACTION_TYPES` (satır 30-37): **6 aksiyon tipinin TAMAMI için `{actionType, label}` sabit-kodlanmış bir dizi, frontend'e ÖZEL, backend'deki HİÇBİR yapıyla BAĞLI DEĞİL.** Bu, PLAN.md §5'in "UI menüleri de aynı kayıttan üretilir, ikilik oluşmaz" ilkesinin bugün İHLAL EDİLDİĞİ, SOMUT, TEK örnek — bu ADR'nin action registry'sinin İLK gerçek refactor-hedefi (Karar f).
11. **`apps/web/src/views/shared/TriggerSuggestionsPanel.tsx`** — en yakın "öneri kartı" emsali, TAMAMEN tıklama-güdümlü ("Şimdi analiz et" butonu), hiçbir sayfa-açılışı/zamanlayıcı tetiklemesi YOK — proaktif/ambient bir teslimat DEĞİL.
12. **`packages/core-objects/src/object-type-registry.ts`** — `ObjectType` union'ının (`task|doc|note|timeblock|meeting|artifact`) KENDİ `Record<ObjectType,{titleRequired}>` registry deseni — bu ADR'nin action registry'sinin İZLEDİĞİ, kod tabanında ZATEN yerleşik "tip → statik metadata" deseni (aynı `isKnown*`/lookup-fonksiyonu şekli).
13. **`apps/web`'in mevcut framework-free-paket-tüketme emsali** (ADR-0042 Bağlam #8/Karar a) — `apps/web`, `@luminaos/artifacts` (framework-free) gibi bir domain paketini ÇALIŞMA-ZAMANI bağımlılığı olarak ZATEN tüketiyor; `apps/web`'e `@luminaos/agent-runtime`'ı (aynı şekilde framework-free) YENİ bir çalışma-zamanı bağımlılığı olarak eklemek bu deseni GENİŞLETİYOR, YENİ bir kategori İCAT ETMİYOR.
14. **ADR-0042'nin `refetchInterval`+`refetchIntervalInBackground:false` polling deseni** (`useLiveWidgetQuery.ts`) — `apps/web`'in tek `react-query`-polling emsali, bu ADR'nin ambient rozetinin AYNEN ödünç aldığı desen; kod tabanında genel bir pub-sub/WebSocket-push emsali (Yjs-özel kanal DIŞINDA) YOK.

**İnsan kararları (bu Plan Mode oturumunda alındı, mimarın çıkarımı DEĞİL):**

1. **"Ambient öneri yüzeyi" v0 kapsamı: mevcut bekleyen önerileri pasif göster.** App shell'de kalıcı bir rozet/bildirim göstergesi — ZATEN var olan `ActionsProposed`/bekleyen-karar kayıtlarını (`CommandsService`'in mevcut `GET .../commands/proposals` uç-noktasından) kullanıcı ayrıca bir panele gitmeden görüntüler. SIFIR yeni AI-tetikleme mekanizması. Reddedilen alternatif: sayfa açılışında/periyodik OTOMATİK AI analizi tetikleyen bir "proaktif özet akışı" — yeni bir arka-plan AI-tetikleme mekanizması ve maliyet-kontrolü gerektirdiği için orantısız mühendislik (ADR-0042'nin WebSocket'i reddetme gerekçesiyle AYNI mantık).
2. **F3-T7 (artifact)/F3-T8 (widget) üretimi, niyet ayrıştırıcının gönderilebilir aksiyon kümesine DAHİL EDİLMEZ (v0).** Registry gelecekte bunların da kaydolabileceği kadar genel tasarlanır, ama "sunum oluştur" gibi serbest-metin isteklerini doğru sınıflandırma mühendisliği bu görevin DIŞINDA — `ArtifactsService`/`WidgetsService` kendi REST uç-noktalarında KALIR, değiştirilmez.
3. **Komut paleti (Cmd+K), BU GÖREVDE gerçekten `CommandsService.parse()`'a bağlanır.** Palete yazılan bir cümle gerçek `ProposedAction`'lar üretir (mevcut `decide()`/otonomi-kademesi akışı AYNEN kullanılır, hiçbir yeni gating kodu gerekmez). Bu, "Intent-first UI" epiğinin somut, kullanıcı-görünür teslimatıdır.

**Çözülmesi gereken merkezi sorular:** action registry'nin gerçek şekli/yerleşimi ve `dispatchExecute`'la ilişkisi (a/b), palette→`parse()` akışının render/RBAC/durum-yönetimi (c/d), ambient rozetin veri kaynağı/polling/tıklama-hedefi (e), registry'nin gerçek ikinci tüketicisi (f), RBAC/güvenlik (g), HTTP yüzeyi (h).

## Karar

### (a) Action Registry — `packages/agent-runtime/src/action-registry.ts`, YALNIZCA metadata (`actionType`/`module`/`label`), YENİ paket YOK

```ts
// packages/agent-runtime/src/action-registry.ts
/**
 * F3-T9 (ADR-0043 Karar a): PLAN.md §5'in "tek kayıt defteri" ilkesinin
 * somutlaştırılması -- `packages/agent-runtime`'a eklenir (YENİ bir
 * `packages/action-registry` DEĞİL): bu paket zaten `AutonomyTier`/
 * `AUTONOMY_GOVERNANCE_FLOOR`'un (aynı "per-actionType metadata" kategorisi)
 * evi, framework-free (React/Nest yasak, CLAUDE.md), ve hem `apps/server`
 * (zaten bağımlı) hem `apps/web` (Karar f'nin YENİ bağımlılığı, ADR-0042
 * Karar a'nın `@luminaos/artifacts` emsaliyle AYNI) tarafından tüketilebilir.
 *
 * SADECE 2 GERÇEK modül var bugün -- `task` (5 tip) ve `agentPermissions`
 * (1 tip, `reconfigureAgentPermissions`) -- sahte bir çoklu-modül soyutlaması
 * İCAT EDİLMEDİ: `reconfigureAgentPermissions` gerçekten farklı bir domaine
 * (`AgentPermissionManifestsService`) dispatch ediliyor, task'lardan ayrı bir
 * modül olması dürüst bir ayrım, "gelecekte belki 5 modül olur" varsayımıyla
 * ÖNDEN genişletilmiş bir tip DEĞİL.
 */
export type ActionModule = 'task' | 'agentPermissions';

export interface ActionRegistryEntry {
  actionType: string;
  module: ActionModule;
  label: string;
}

/**
 * Etiketler `AutonomyTierPanel.tsx`'in bugünkü `KNOWN_ACTION_TYPES`'ıyla
 * BİREBİR aynı (Karar f'nin refactor hedefi) -- kelimesi kelimesine aynı
 * Türkçe metin, yeni bir çeviri/i18n kararı İCAT EDİLMEDİ.
 */
export const ACTION_REGISTRY: readonly ActionRegistryEntry[] = [
  { actionType: 'createTask', module: 'task', label: 'Görev oluştur' },
  { actionType: 'generateSubtasks', module: 'task', label: 'Alt görevler oluştur' },
  { actionType: 'assignPeople', module: 'task', label: 'Kişi ata' },
  { actionType: 'createTaskFromMeeting', module: 'task', label: 'Toplantıdan görev oluştur' },
  { actionType: 'createTaskFromTrigger', module: 'task', label: 'Tetikleyiciden görev oluştur' },
  {
    actionType: 'reconfigureAgentPermissions',
    module: 'agentPermissions',
    label: 'Ajan izinlerini yeniden yapılandır',
  },
];

export function findActionRegistryEntry(actionType: string): ActionRegistryEntry | undefined {
  return ACTION_REGISTRY.find((entry) => entry.actionType === actionType);
}
```

`packages/agent-runtime/src/index.ts`'e `export * from './action-registry.js';` eklenir.

**Registry NE İÇERMİYOR (kasıtlı, dar tutuluyor):** `parseCommand()`'a hangi tiplerin erişilebilir olduğu (`ALLOWED_PARSE_COMMAND_TYPES`) BİLGİSİ. Brief'in sorduğu "registry bu allowlist'i BAŞKA bir yerde DUPLICATE mi ediyor" sorusunun cevabı: **HAYIR, çünkü v0'ın registry'sinin HİÇBİR tüketicisi (Karar c/f) bu bilgiye ihtiyaç duymuyor** — palete yazan kullanıcı bir aksiyon TİPİ SEÇMİYOR (serbest metin yazıyor, `parse()` içeride hangi tiplerin üretilebileceğine zaten karar veriyor), `AutonomyTierPanel` HER 6 tipi de gösteriyor (kademe hepsi için ayarlanabilir, `parseCommand`-erişilebilirliğinden BAĞIMSIZ bir kavram). `ALLOWED_PARSE_COMMAND_TYPES` bu yüzden **export edilmeye bile gerek YOK** — `parse-command.ts`'in kendi private sabiti olarak KALIR, tek gerçek kaynak konumu HİÇ TARTIŞMAYA AÇILMAZ.

### (b) Registry — `dispatchExecute`'un switch'ini SÜRMEZ; tutarlılık BİR TESTLE sağlanır, yapısal bağlanma İLE DEĞİL

**En yük taşıyan karar.** `dispatchExecute` (`commands.service.ts:1060-1105`), her `action.type`'a özel per-tip param-doğrulama + `AgentActionRecordsService` ledger yazımı + actor/role threading içeren, F3-T3/F3-T4/F3-T5 boyunca güvenlik-incelemesinden geçmiş, TAM test kapsamına sahip bir switch. Bu ADR bunu registry'den TÜRETİLEN bir `Record<string, Handler>` haritasına DÖNÜŞTÜRMEZ — nedenleri:

1. Tip-güvenliği KAYBI: bugünkü switch, TypeScript'in kendi exhaustiveness-check'inden (hiçbir `default` dalı yok, her `case` dönüyor) FAYDALANIYOR — bu, YENİ bir `action.type` eklendiğinde derleme-zamanında "bu case'i unuttun" hatası verir. Bir `Record<ProposedAction['type'], Handler>` nesne-literaline dönüştürmek AYNI garantiyi TEORİDE korur ama registry'nin KENDİSİ `string`-tipli olduğundan (a), registry → switch yönünde bir "handler haritası" inşa etmek, tip-daraltmayı registry'nin ZAYIF `string` tipinden GEÇİRMEK anlamına gelir — net kazanç YOK, net risk VAR.
2. Regresyon riski: `ArtifactsService.generate()`/`WidgetsService.generate()`'i BİRLEŞTİRMEME kararının (ADR-0042 Karar a) AYNI mantığı — "çalışan, test edilmiş, güvenlik-incelemesinden geçmiş bir yolu SADECE yapısal saflık için yeniden yazmak" riski, kazanılan hiçbir gerçek esneklikle DENGELENMİYOR (bugün YENİ bir aksiyon tipi eklemek zaten NADİR, F3-T3/T4/T5/T9 boyunca toplam 0 kez oldu — 6 tip F1-T16'dan beri SABİT).

**Tutarlılığı KORUYAN mekanizma (yapısal bağlanma DEĞİL, bir TEST):** `apps/server/src/commands/action-registry.consistency.test.ts` — `ACTION_REGISTRY`'nin (`@luminaos/agent-runtime`) `actionType` kümesinin, `parseCommand`'ın `proposedActionSchema.element.shape.type.options`'ının (zod enum introspection, `parse-command.ts`'e `export const PROPOSED_ACTION_TYPES = proposedActionSchema.element.shape.type.options;` eklenir — bu, `dispatchExecute`'un switch'inin dispatch ettiği TAM tip kümesiyle BİREBİR aynı, çünkü `decidableActionSchema` `proposedActionSchema.element`'i extend ediyor) kümesiyle TAM eşit olduğunu doğrular. Bu test, registry'ye YENİ bir tip eklenip switch'e eklenmezse (veya tersi) KIRMIZI olur — "iki liste driftler" riskini yapısal bağlanma OLMADAN, ADR-0042'nin `MAX_DECISIONS_PER_CALL`'ı `dto/decide-actions.schema.ts`'nin AYNI sabiti yeniden kullanmasıyla (yorum satırı satır 68'de: "so a future PR can reuse the exact same cap instead of hardcoding a second, driftable value") AYNI disiplinle çözer.

### (c) CommandPalette → `parse()` — YENİ bir "komutu çalıştır" satırı, mevcut ok-tuşu/arama navigasyonunu DEĞİŞTİRMEZ

`CommandPalette.tsx`'in "Toplantıya bot davet et" hızlı-aksiyonunun (Bağlam #6) AYNI deseni: `rawQuery.trim().length > 0` iken, sonuç grupları/dış-kaynaklar bölümünün ALTINA, `flatResults` arrow-key navigasyonuna DAHİL OLMAYAN, ayrı, tıklanabilir bir satır render edilir:

```tsx
// apps/web/src/views/shared/CommandPalette.tsx (diff, PR2)
{
  rawQuery.trim().length > 0 && (
    <div
      data-testid="command-palette-run-command-action"
      role="button"
      tabIndex={0}
      onClick={() => {
        handleRunCommand();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') handleRunCommand();
      }}
    >
      &quot;{rawQuery.trim()}&quot; komutunu çalıştır
    </div>
  );
}
```

`handleRunCommand` yeni `useParseCommandMutation(workspaceId)`'i çağırır (`apps/web/src/hooks/useProposalsQuery.ts`'e EKLENİR — proposal-domain hook'larının ZATEN yaşadığı dosya, ayrı bir dosya İCAT EDİLMİYOR):

```ts
// apps/web/src/hooks/useProposalsQuery.ts (diff, PR2)
export function useParseCommandMutation(
  workspaceId: string,
): UseMutationResult<ParseCommandResponse, Error, { command: string; sourceObjectId?: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables) =>
      parseCommand(workspaceId, variables.command, variables.sourceObjectId),
    onSuccess: () => {
      // Palette'in ürettiği proposal'ı AutomationHistoryPanel/ambient rozet
      // hemen görsün diye AYNI ön-ek invalidation'ı (useDecideProposalMutation'ın
      // BİREBİR aynı satırı) -- ekstra plumbing GEREKMİYOR.
      void queryClient.invalidateQueries({ queryKey: ['proposals', workspaceId] });
    },
  });
}
```

`apiClient.ts`'e (Bağlam #7'nin doğruladığı EKSİK parça):

```ts
// apps/web/src/lib/apiClient.ts (diff, PR2)
export interface ParseCommandResponse {
  proposalId: string;
  actions: ProposedActionSummary[]; // ZATEN tanımlı (satır 685-693)
  parseError: boolean;
  message?: string;
  autonomousResults?: DecideActionResult[]; // ZATEN tanımlı (satır 695-702)
}

export function parseCommand(
  workspaceId: string,
  command: string,
  sourceObjectId?: string,
): Promise<ParseCommandResponse> {
  return request<ParseCommandResponse>(
    `/workspaces/${encodeURIComponent(workspaceId)}/commands/parse`,
    {
      method: 'POST',
      body: JSON.stringify({
        command,
        ...(sourceObjectId !== undefined ? { sourceObjectId } : {}),
      }),
    },
  );
}
```

**RBAC: SIFIR yeni kapı.** `POST .../commands/parse` ZATEN `SessionAuthGuard`+`WorkspaceMembershipGuard` altında, EK admin-gate YOK (Bağlam #3) — palette'ten gelen çağrı BAŞKA bir gate İCAT ETMEZ, `parse()`'ın kendi mevcut `member`+ tabanını kullanır (ADR-0041 Karar g'nin AYNI "AI'ı tetikleme kapısı, politika-yazma kapısı DEĞİL" mantığı). `reconfigureAgentPermissions` palette üzerinden YAPISAL OLARAK üretilemez — `ALLOWED_PARSE_COMMAND_TYPES` (değiştirilmeyen, private) bunu ZATEN engelliyor, bu ADR bu garantiye HİÇ dokunmuyor.

### (d) Palette sonuç render — `actions`/`autonomousResults` KÜME FARKI, palette İÇİNE İKİNCİ bir onayla/reddet UI'si YAZILMAZ

`ParseCommandResponse`'un şekli (`routeProposedActions`'ın davranışı, Bağlam #2) palette'e HİÇBİR ek backend sorgusu OLMADAN şunu ayırt etmesi için yeterli:

```ts
// apps/web/src/views/shared/CommandPalette.tsx (diff, PR2) -- render mantığı
const pendingActions = parseResult
  ? parseResult.actions.filter(
      (action) =>
        !parseResult.autonomousResults?.some((result) => result.actionId === action.actionId),
    )
  : [];
```

- `parseResult.autonomousResults` içindeki HER giriş (hem `'act_and_notify'` hem otomatik-karara-bağlanmış `'approve_and_act'` batch'i) **ZATEN yürütülmüş** — palette bunu bir `toast({title: 'N aksiyon otomatik yürütüldü', variant:'success'})` + kısa bir liste (`intent: status`) olarak gösterir, onay/red butonu SUNMAZ (yürütme zaten oldu).
- `pendingActions` (yukarıdaki küme-farkı) hâlâ insan kararı bekleyen `'propose'`-tier aksiyonlardır — palette bunlar için **YENİ bir onayla/reddet UI'si İNŞA ETMEZ**: `AutomationHistoryPanel.tsx` (Bağlam #9) ZATEN bunu tam olarak yapıyor (`useProposalsQuery`+`useDecideProposalMutation`, `App.tsx`'te ZATEN mount edilmiş). Palette bunun yerine kısa bir bilgilendirme render eder: `"N öneri oluşturuldu, onaylamak için Otomasyon Geçmişi panelini kullanın"` + `AutomationHistoryPanel`'in DOM köküne bir `<a href="#automation-history-panel">` çapa-bağlantısı (Karar e'nin AYNI çapa-hedefi, tek bir `id` eklemesiyle paylaşılır).

**Neden ayrı bir onayla/reddet UI'si REDDEDİLDİ (palette içinde ikinci bir implementasyon):** `AutomationHistoryPanel`'in `useDecideProposalMutation` çağrısını palette'te YİNELEMEK, AYNI mutasyonun İKİ ayrı UI yüzeyinden tetiklenmesi anlamına gelirdi — davranışsal olarak ZARARSIZ (aynı endpoint) ama bakım yükünü GEREKSİZ ikiye katlar (iki test seti, iki UI'nin senkron kalması gerekir). Palette'in İŞİ "niyeti aksiyona çevirmek", "aksiyonu onaylamak" DEĞİL — bu ayrım, `SavedView`'ın "sorgu YAPILANDIRMASI" ile "widget'ın CANLI render'ı" (ADR-0042) arasındaki ayrımla AYNI ruhta.

### (e) Ambient rozet — YENİ `useAmbientPendingProposalsQuery` hook'u, `pendingOnly=true` + istemci-taraflı `actions.length>0` filtresi, mevcut `refetchInterval` deseni

```ts
// apps/web/src/hooks/useAmbientPendingProposalsQuery.ts (PR3, YENİ dosya)
const AMBIENT_BADGE_POLL_INTERVAL_MS = 45_000; // ADR-0042'nin AYNI 45s sabiti
const AMBIENT_BADGE_SAMPLE_LIMIT = 5; // "5+" göstermek için yeterli, tam sayım GEREKMİYOR

export function useAmbientPendingProposalsQuery(
  workspaceId: string,
): UseQueryResult<{ count: number; hasMore: boolean }> {
  return useQuery({
    queryKey: ['ambientPendingProposals', workspaceId],
    queryFn: async () => {
      const { proposals, nextCursor } = await listProposals(workspaceId, {
        pendingOnly: true,
        limit: AMBIENT_BADGE_SAMPLE_LIMIT,
      });
      // Bağlam #4'ün doğruladığı edge case: `decidedAt=null` OLABİLİR ama
      // `actions=[]` (tüm batch `'act_and_notify'` idiyse) -- bu satırların
      // İNSANIN karar vermesi gereken SIFIR aksiyonu var, sayıma DAHİL EDİLMEZ.
      const withPendingActions = proposals.filter(
        (proposal) => Array.isArray(proposal.actions) && proposal.actions.length > 0,
      );
      return { count: withPendingActions.length, hasMore: nextCursor !== undefined };
    },
    refetchInterval: AMBIENT_BADGE_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false, // ADR-0042 Karar e'nin AYNI gerekçesi
  });
}
```

`useProposalsQuery`'nin KENDİSİ değiştirilmiyor (`refetchInterval`'ı DEFAULT davranış olarak sızdırmamak için, ADR-0042'nin `useLiveWidgetQuery`'yi `useObjectsQuery`'den AYRI tutma gerekçesinin BİREBİR aynısı) — bu YENİ, ayrı bir hook.

```tsx
// apps/web/src/views/shared/AmbientProposalsBadge.tsx (PR3, YENİ dosya)
export function AmbientProposalsBadge({ workspaceId }: { workspaceId: string }) {
  const { data } = useAmbientPendingProposalsQuery(workspaceId);
  const count = data?.count ?? 0;

  if (count === 0) return null; // "ambient" -- gösterilecek bir şey yoksa SESSİZ kalır

  return (
    <a href="#automation-history-panel" data-testid="ambient-proposals-badge">
      {data?.hasMore ? `${AMBIENT_BADGE_SAMPLE_LIMIT}+ bekleyen öneri` : `${count} bekleyen öneri`}
    </a>
  );
}
```

`App.tsx`'e (implementer'ın PR3'te uygulayacağı, bu ADR'nin İCAT ETMEDİĞİ küçük bir diff): `<AmbientProposalsBadge workspaceId={DEV_WORKSPACE_ID} />` `<AutomationHistoryPanel>`'in HEMEN ÖNÜNE eklenir + `AutomationHistoryPanel`'i saran bir `<div id="automation-history-panel">` (gerçek bir routing/sekme sistemi YOK bugün — Bağlam #9'un doğruladığı flat dev-shell — "tıklanınca panele git" bu yüzden gerçek bir sayfa-geçişi DEĞİL, aynı sayfa içinde bir çapa-kaydırması; implementer bunu bir gerçek routing/sekme sistemine BAĞLI KILMADAN teslim eder).

**Neden `pendingOnly=true` (proposal-seviyesi) sayılıyor, aksiyon-seviyesi DEĞİL:** `AutomationHistoryPanel`'in KENDİ pending/decided ayrımı ZATEN proposal-seviyesinde (`decidedAt`) — rozetin SAYDIĞI birim, kullanıcının panelde GÖRECEĞİ birimle TUTARLI olmalı (bir rozetin "3" göstermesi ama panelin "5 ayrı aksiyon satırı 2 proposal'a dağılmış" göstermesi kafa karıştırıcı olurdu).

### (f) Registry'nin gerçek İKİNCİ tüketicisi — `AutonomyTierPanel.KNOWN_ACTION_TYPES` refactor edilir, PLAN.md'nin "ikilik oluşmaz" ilkesi SOMUTLAŞIR

```ts
// apps/web/src/views/shared/AutonomyTierPanel.tsx (diff, PR2)
import { ACTION_REGISTRY } from '@luminaos/agent-runtime';
// KALDIRILAN: const KNOWN_ACTION_TYPES: { actionType: string; label: string }[] = [ ...6 satır sabit-kod... ];
// YERİNE:
const KNOWN_ACTION_TYPES = ACTION_REGISTRY.map(({ actionType, label }) => ({ actionType, label }));
```

Bu, brief'in sorduğu "registry SADECE metadata/UI-üretimi için mi" sorusunun EVET cevabının SOMUT kanıtı: `AutonomyTierPanel` bugün 6 satırlık bir sabit-kodlanmış diziyi (backend'in `dispatchExecute`'unun dispatch ettiği tiplerle HİÇBİR yapısal bağı olmayan) tutuyor — registry bunu TEK gerçek kaynağa indirger. `CommandPalette`'in Karar (d)'deki pending-aksiyon listesi de `findActionRegistryEntry(action.type)?.label ?? action.type` kullanarak aksiyon tipini ham string yerine OKUNABİLİR bir etiketle gösterir — registry'nin İKİ AYRI UI yüzeyinde (`AutonomyTierPanel`'in dropdown etiketleri, `CommandPalette`'in pending-aksiyon etiketleri) AYNI kaynaktan üretildiğinin kanıtı, PLAN.md §5'in tam olarak istediği şey.

`apps/web/package.json`'a `@luminaos/agent-runtime: workspace:*` YENİ runtime bağımlılığı eklenir (ADR-0042 Karar a'nın `@luminaos/artifacts` emsaliyle AYNI gerekçe: framework-free paket, `apps/web`'in tüketmesine mimari bir engel YOK).

### (g) RBAC/güvenlik — registry PUBLIC/statik metadata, HİÇBİR HTTP uç-noktası YOK, HİÇBİR RBAC filtrelemesi veri-katmanında YAPILMAZ

Brief'in sorduğu "registry'nin kendisi (ör. `GET /action-registry`) rol-bazlı filtreleme yapıyor mu" sorusunun cevabı: **böyle bir uç-nokta YOK, gerek de YOK.** Registry, `apps/web`'in `ACTION_REGISTRY`'yi (Karar a/f) DOĞRUDAN, çalışma-zamanında import ettiği statik bir dizi — workspace'e/kullanıcıya özel HİÇBİR bilgi taşımıyor (aynı 6 satır her workspace/kullanıcı için aynı), bu yüzden bir HTTP round-trip'i GEREKTİRMİYOR (ADR-0042'nin `renderArtifactHtml`'i `apps/web`'e DOĞRUDAN import ettirme kararıyla AYNI mantık — saf, statik veri bir API uç-noktası ARKASINA GİZLENMEZ).

**Rol-bazlı GİZLEME (ör. `reconfigureAgentPermissions`'ı non-admin'den saklamak) UI-katmanında bir NEZAKETTİR, güvenlik SINIRI DEĞİLDİR** — `AutonomyTierPanel.tsx`'in ZATEN var olan `GOVERNANCE_FLOOR_ACTION_TYPES` yorumunun ("UX only, not a security boundary — the PUT would 403 regardless") AYNI mantığı: gerçek yetkilendirme HER ZAMAN backend'de, action-specific olarak ZATEN uygulanıyor (`AutonomyTierSettingsService.set`'in `admin`+ gate'i, `proposeFromDirectMessage`'ın senkron admin-check'i, `ALLOWED_PARSE_COMMAND_TYPES`'ın yapısal engeli). Registry bu gate'lerin HİÇBİRİNİ TEKRARLAMAZ, TEMSİL ETMEZ — yalnızca `module`/`label` taşır.

**Palette→`parse()` yolu YENİ hiçbir RBAC İCAT ETMİYOR** (Karar c) — mevcut `member`+ gate'i AYNEN kullanılır. **`reconfigureAgentPermissions` palette üzerinden YAPISAL OLARAK erişilemez** (`ALLOWED_PARSE_COMMAND_TYPES`'ın DEĞİŞMEDEN kalması sayesinde) — bu ADR'nin dokunmadığı, önceden var olan bir güvenlik garantisi.

### (h) HTTP yüzeyi — SIFIR yeni backend rota; tek eksik parça `apps/web`'in `parseCommand` istemci sarmalayıcısıydı (Karar c'de kapatıldı)

`POST .../commands/parse`, `GET .../commands/proposals`, `POST .../commands/:id/decide` — ÜÇÜ DE F1-T16/F2-T16'dan beri VAR, bu ADR HİÇBİRİNİ DEĞİŞTİRMİYOR. Bu görevin TÜM yeni yüzeyi: (1) `packages/agent-runtime`'a saf bir TS dosyası (registry), (2) `apps/web`'e bir apiClient fonksiyonu + iki hook + üç bileşen diff'i. **Backend'de bu görev için YAZILAN TEK yeni dosya `action-registry.ts` (paket) + `action-registry.consistency.test.ts` (server) — hiçbir controller/servis/migration YOK.**

## Somut Şekiller

(Karar a-f'nin tam kod sketch'leri yukarıda Karar bölümünde — burada tekrarlanmıyor.) Migration: **YOK gerekli** — bu görev hiçbir DB şemasına dokunmuyor, hiçbir yeni jsonb alanı/kolonu eklemiyor.

## Alternatifler ve Reddedilme Gerekçeleri

- **YENİ bir `packages/action-registry` paketi yaratmak.** Reddedildi (Karar a) — `packages/agent-runtime` ZATEN "per-actionType metadata" (`AutonomyTier`/`AUTONOMY_GOVERNANCE_FLOOR`) kategorisinin evi; ayrı bir paket AÇMAK, tek bir 30 satırlık dosya için gereksiz bir build/test/lint iskeleti daha demektir.
- **`dispatchExecute`'un switch'ini registry-güdümlü bir `Record<string, Handler>`'a dönüştürmek.** Reddedildi (Karar b) — TypeScript'in switch-exhaustiveness garantisini ZAYIFLATIR, test edilmiş/güvenlik-incelemesinden geçmiş bir yolu SIFIR fonksiyonel kazanç için yeniden yazma riski taşır; tutarlılık BİR TESTLE (yapısal bağlanma OLMADAN) sağlanıyor.
- **`ALLOWED_PARSE_COMMAND_TYPES`'ı registry'nin bir alanı yapmak (`parseable: boolean`).** Reddedildi (Karar a) — v0'ın HİÇBİR tüketicisi bu bilgiye ihtiyaç duymuyor (palette serbest metin yazıyor, tip seçmiyor; `AutonomyTierPanel` her tipi gösteriyor); eklemek, ihtiyaç duyulmayan bir alan için `parse-command.ts`'in private sabitini export etmeyi ve onu registry'de KOPYALAMAYI gerektirirdi — tek gerçek kaynak ilkesini GEREKSİZ YERE riske atardı.
- **Palette içine kendi onayla/reddet UI'sini yazmak (`AutomationHistoryPanel`'i YENİDEN İCAT ETMEK).** Reddedildi (Karar d) — AYNI mutasyonun (`useDecideProposalMutation`) iki UI yüzeyinden tetiklenmesi bakım yükünü gereksiz ikiye katlar; palette'in işi niyeti aksiyona çevirmek, onaylamak DEĞİL.
- **Ambient rozetin TÜM bekleyen aksiyonları tam olarak SAYMASI (limit'siz `listProposals` çağrısı).** Reddedildi (Karar e) — `AMBIENT_BADGE_SAMPLE_LIMIT=5` + `hasMore` bayrağı yeterli ("5+" göstermek), her 45 saniyede bir workspace'in TÜM bekleyen proposal'larını (potansiyel olarak sınırsız `actions`/`decisions` jsonb blob'ları dahil) çekmek gereksiz yük olurdu (`MAX_LIST_PROPOSALS_LIMIT=200`'ün KENDİSİNİN var olma sebebiyle AYNI mantık, `commands.service.ts` satır 74-84).
- **`GET /action-registry` gibi bir HTTP uç-noktası açmak.** Reddedildi (Karar g) — registry statik, workspace-bağımsız veri; bir API round-trip'i ARKASINA gizlemek gereksiz bir ağ-bağımlılığı ekler, `apps/web`'in zaten framework-free paketleri DOĞRUDAN import etme emsaliyle (ADR-0042) TUTARSIZ olurdu.
- **`AutonomyTierPanel.KNOWN_ACTION_TYPES`'ın refactor'unu bu görevin kapsamı DIŞINDA bırakmak (registry'yi yalnızca YENİ kod için kullanmak).** Reddedildi (Karar f) — PLAN.md §5'in "ikilik oluşmaz" ilkesi, kod tabanında ZATEN VAR OLAN somut bir ikiliği (Bağlam #10) düzeltmeden yalnızca bir ADR cümlesi olarak KALIRDI; refactor küçük (6 satırlık bir sabit-kod bloğunun import'a dönüşmesi), riski düşük (davranış değişmiyor, yalnızca veri kaynağı).
- **F3-T7/F3-T8'in artifact/widget üretimini niyet ayrıştırıcının kapsamına dahil etmek.** Reddedildi (insan kararı 2) — "sunum oluştur" gibi isteklerin doğru sınıflandırılması ayrı bir prompt-mühendisliği + güvenlik-incelemesi gerektirir; `ArtifactsService`/`WidgetsService` kendi REST uç-noktalarında kalır.
- **Sayfa açılışında/periyodik otomatik AI analizi tetikleyen proaktif bir öneri akışı.** Reddedildi (insan kararı 1) — yeni bir arka-plan AI-tetikleme mekanizması + maliyet-kontrolü gerektirir, v0 için orantısız mühendislik.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** Bu görev SIFIR yeni event türü/projeksiyon EKLEMİYOR — `ActionsProposed`/`ActionsDecided` (F1-T16) ve `TaskAutonomyTierSet` (F3-T5) ZATEN VAR OLAN olaylar, registry salt statik kod-metadatası (hiçbir persistence'ı YOK), ambient rozet salt mevcut `command_proposals` projeksiyonunun bir OKUMASI.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu ADR bu sözleşmeye HİÇBİR yeni aksiyon tipi EKLEMİYOR — palette sadece MEVCUT `parse()`'ı, MEVCUT `ProposedAction` şeklini kullanarak tetikliyor; her üretilen aksiyon ZATEN bu sözleşmeye uyuyor (`parseCommand`'ın `intent`/`rationale`/`resources`/`rollbackNote` alanları, F1-T16'dan beri değişmedi).
- **Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz.** Bu ADR export'la İLGİSİZ — hiçbir yeni veri sınıfı/depolama İCAT ETMİYOR.
- **Hassas veri sınıfları buluta ham gönderilmez (ADR-0029).** Palette'in `parse()`'a gönderdiği metin, kullanıcının kendi serbest-metin komutu — `parse()`'ın ZATEN var olan `command` string'i ile AYNI kategori (Bağlam #6/#7, hiçbir yeni veri kanalı AÇILMIYOR). Registry/ambient rozet hiçbir AI çağrısı İÇERMİYOR (rozet salt bir DB okuması, registry salt statik kod) — bu ADR'nin YENİ hiçbir hassas-veri yüzeyi YOK.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:** `docs/PLAN.md`'nin F3-T9 vaadi (niyet ayrıştırıcı → modül/aksiyon yönlendirme, ambient öneri yüzeyi) NEREDEYSE TAMAMEN VAR OLAN altyapı (parse/decide/proposals/otonomi-kademesi/ledger, F1-T16→F3-T5) ÜZERİNE, SIFIR yeni backend endpoint'i, SIFIR yeni migration'la kuruluyor; PLAN.md §5'in "ikilik oluşmaz" ilkesi somut, KOD TABANINDA ZATEN VAR OLAN bir ikiliğin (`AutonomyTierPanel.KNOWN_ACTION_TYPES`) giderilmesiyle KANITLANIYOR; Cmd+K komut paleti gerçek, kullanıcı-görünür bir "niyetten aksiyona" akışı KAZANIYOR (Intent-first UI epiğinin somut teslimatı).

**Neyi erteliyoruz/kabul ediyoruz:**

- Proaktif/otomatik AI-tetiklemeli öneri üretimi YOK (insan kararı 1) — ambient rozet salt PASİF bir gösterge, yeni bir AI maliyeti YARATMIYOR.
- Artifact/widget üretimi niyet ayrıştırıcıya ENTEGRE EDİLMEDİ (insan kararı 2) — `ArtifactsService`/`WidgetsService` kendi ayrı uç-noktalarında kalıyor; registry gelecekte bunları da kaydedebilecek kadar genel ama bu ADR o sınıflandırma mühendisliğini YAPMIYOR.
- Registry `dispatchExecute`'un switch'ini SÜRMÜYOR (Karar b) — YENİ bir aksiyon tipi eklendiğinde HEM registry'ye HEM switch'e elle satır eklemek gerekiyor (bir test bunu KIRMIZI yaparak hatırlatıyor, ama otomatik senkronize OLMUYOR) — bu, tip-güvenliği/regresyon-riski TRADE-OFF'unun BİLİNÇLİ kabulü.
- Ambient rozet TAM sayım YAPMIYOR (`5+` sınırı, Karar e) — kullanıcı tam sayıyı görmek isterse panelin kendisini açmalı.
- Palette'in pending-aksiyon render'ı SADECE bilgilendirici (Karar d) — gerçek onay/red HALA `AutomationHistoryPanel`'de yapılıyor, palette KENDİ BAŞINA bir "onayla-ve-kapat" akışı SUNMUYOR; gerçek bir tek-akış talep doğarsa AYRI bir gelecekteki karar gerektirir.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md`) yazılır. Bu ADR'nin onayı üzerine PR1'e (`packages/agent-runtime` action registry + `apps/server`'da consistency testi) `test-writer` ile başlanır:

```
docs/adr/ADR-0043-komut-duzlemi-v2.md'deki Karar (a)-(h)'yi ve
docs/specs/F3-E3/F3-T9-komut-duzlemi-v2.md'nin Kabul Kriterleri'ni temel alarak, F3-T9
PR1 (packages/agent-runtime'a action-registry.ts: ActionModule/ActionRegistryEntry/
ACTION_REGISTRY/findActionRegistryEntry -- sıfır I/O, saf TS; apps/server/src/ai/parse-command.ts'e
export const PROPOSED_ACTION_TYPES eklenmesi; apps/server/src/commands/action-registry.consistency.test.ts
-- ACTION_REGISTRY'nin actionType kümesinin PROPOSED_ACTION_TYPES kümesiyle TAM eşleştiğini
doğrulayan test) için test-writer ile başarısız testleri yaz.
```
