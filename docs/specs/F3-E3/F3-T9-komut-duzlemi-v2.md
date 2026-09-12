# F3-T9 — Komut Düzlemi v2: Niyet Ayrıştırıcı → Modül/Aksiyon Yönlendirme; Ambient Öneri Yüzeyi

**Epik:** F3-E3 (Artifact + Canlı Widget [Kapsam L] ve Intent-first UI [Kapsam M]) · **Durum:** TAMAMLANDI — Epik F3-E3'ün ÜÇÜNCÜ ve SON görevi, Kapsam L'nin (F3-T7/F3-T8, ikisi de `main`'e tam birleşti) TAMAMLANMASININ ardından Kapsam M'in ("Intent-first UI") TEK görevi. Mimari karar `docs/adr/ADR-0043-komut-duzlemi-v2.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** F1-T16 (`CommandsService.parse()`/`decide()`, `ProposedAction`, ADR-0015) — DEĞİŞTİRİLMEZ. F2-T16 (`GET .../commands/proposals`, `AutomationHistoryPanel.tsx`, `useProposalsQuery`/`useDecideProposalMutation`, ADR-0033) — DEĞİŞTİRİLMEZ, YENİDEN KULLANILIR. F3-T5 (`AutonomyTierSettingsService`, `AutonomyTierPanel.tsx`, ADR-0039) — yalnızca `AutonomyTierPanel.tsx`'in `KNOWN_ACTION_TYPES` sabiti refactor edilir, servis DEĞİŞMEZ.

## Amaç

Bugün `docs/PLAN.md` §5'in "Komut düzlemi tüm modül aksiyonlarını tek kayıt defterinden (action registry) çağırır — UI menüleri de aynı kayıttan üretilir, ikilik oluşmaz" ilkesi HİÇBİR kod karşılığı olmadan duruyor (`dispatchExecute`'un düz switch'i "yönlendirme"nin tamamı, `AutonomyTierPanel.tsx`'in `KNOWN_ACTION_TYPES`'ı backend'den bağımsız sabit-kodlanmış bir ikilik) ve Cmd+K komut paleti salt arama/navigasyon — `CommandsService.parse()`'a hiç bağlı değil, yazılan bir cümle hiçbir gerçek aksiyon üretmiyor. Bu görev ADR-0043 Karar (a)-(h)'de tam sabitlendiği üzere: (1) bir action registry (`packages/agent-runtime`) tanımlar, (2) `AutonomyTierPanel`'in mevcut ikiliğini bu registry'ye bağlayarak giderir, (3) komut paletini gerçekten `parse()`'a bağlar, (4) ZATEN var olan bekleyen-öneri verisini (yeni bir AI-tetikleme mekanizması OLMADAN) pasif bir ambient rozetle görünür kılar.

## Kapsam

1. `packages/agent-runtime` genişlemesi — `action-registry.ts`: `ActionModule` (`'task'|'agentPermissions'`), `ActionRegistryEntry` (`{actionType, module, label}`), `ACTION_REGISTRY` (6 sabit giriş), `findActionRegistryEntry(actionType)`. `index.ts`'e export edilir. Sıfır I/O, sıfır yeni bağımlılık (Karar a).
2. `apps/server/src/ai/parse-command.ts`'e `export const PROPOSED_ACTION_TYPES = proposedActionSchema.element.shape.type.options;` eklenmesi (Karar b) — `ALLOWED_PARSE_COMMAND_TYPES` DEĞİŞMEZ, export edilmez.
3. `apps/server/src/commands/action-registry.consistency.test.ts` (YENİ) — `ACTION_REGISTRY`'nin `actionType` kümesinin `PROPOSED_ACTION_TYPES` kümesiyle TAM eşit olduğunu doğrulayan test (Karar b) — `dispatchExecute`'un switch'i DEĞİŞTİRİLMEZ.
4. `apps/web`'e YENİ `@luminaos/agent-runtime` runtime bağımlılığı (Karar a/f, ADR-0042 Karar a'nın `@luminaos/artifacts` emsaliyle AYNI).
5. `apps/web/src/views/shared/AutonomyTierPanel.tsx` — `KNOWN_ACTION_TYPES` sabit-kodlanmış dizisi `ACTION_REGISTRY`'den türetilir (Karar f) — davranış DEĞİŞMEZ, yalnızca veri kaynağı.
6. `apps/web/src/lib/apiClient.ts`'e `ParseCommandResponse` arayüzü + `parseCommand(workspaceId, command, sourceObjectId?)` fonksiyonu (Karar c) — `POST .../commands/parse`'ı sarmalıyor, sunucuda YENİ hiçbir kod gerekmiyor.
7. `apps/web/src/hooks/useProposalsQuery.ts`'e `useParseCommandMutation(workspaceId)` eklenmesi (Karar c) — başarıda `['proposals', workspaceId]` ön-ekiyle invalidation (`useDecideProposalMutation`'ın AYNI deseni).
8. `apps/web/src/views/shared/CommandPalette.tsx` genişlemesi — `rawQuery` boş değilken render edilen, arrow-key navigasyonuna DAHİL OLMAYAN bir "komutu çalıştır" satırı; `parseResult.actions`/`autonomousResults` küme farkına göre yürütülmüş-vs-bekleyen aksiyonları ayıran render mantığı; bekleyen aksiyonlar için `AutomationHistoryPanel`'e bir çapa-bağlantısı (Karar c/d) — palette İÇİNE yeni bir onayla/reddet UI'si YAZILMAZ.
9. `apps/web/src/hooks/useAmbientPendingProposalsQuery.ts` (YENİ) — `listProposals(workspaceId, {pendingOnly:true, limit:5})`'i `refetchInterval=45_000`+`refetchIntervalInBackground:false` ile sarmalıyor, istemci-taraflı `actions.length>0` ek-filtresiyle (Karar e).
10. `apps/web/src/views/shared/AmbientProposalsBadge.tsx` (YENİ) — sayı 0 iken render etmeyen, `AutomationHistoryPanel`'e çapa-bağlantısı olan minimal bir rozet (Karar e).
11. `apps/web/src/App.tsx` — `AmbientProposalsBadge` mount edilmesi + `AutomationHistoryPanel`'i saran bir `<div id="automation-history-panel">` eklenmesi (Karar e) — spesifik UI yerleşimi implementer'ın kararı (F3-T7 PR3'ün AYNI serbestliği).

## 3 Bağlayıcı İnsan Kararı

- **"Ambient öneri yüzeyi" v0 kapsamı: mevcut bekleyen önerileri pasif göster.** ZATEN var olan `ActionsProposed`/bekleyen-karar kayıtlarını (mevcut `GET .../commands/proposals`) kullanıcı ayrıca bir panele gitmeden görüntüler. SIFIR yeni AI-tetikleme mekanizması — yalnızca zaten var olan verinin görünürlüğü, ADR-0042'nin client-poll desenine tutarlı (ADR-0043 insan kararı 1).
- **F3-T7 (artifact)/F3-T8 (widget) üretimi, niyet ayrıştırıcının gönderilebilir aksiyon kümesine DAHİL EDİLMEZ (v0).** Registry gelecekte bunların da kaydolabileceği kadar genel tasarlanır, ama sınıflandırma mühendisliği bu görevin DIŞINDA — `ArtifactsService`/`WidgetsService` kendi REST uç-noktalarında KALIR (ADR-0043 insan kararı 2).
- **Komut paleti (Cmd+K), BU GÖREVDE gerçekten `CommandsService.parse()`'a bağlanır.** Palete yazılan bir cümle gerçek `ProposedAction`'lar üretir (mevcut `decide()`/otonomi-kademesi akışı AYNEN kullanılır, hiçbir yeni gating kodu gerekmez) — Intent-first UI epiğinin somut, kullanıcı-görünür teslimatı (ADR-0043 insan kararı 3).

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0043-komut-duzlemi-v2.md` Karar (a)-(h) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Action Registry:** `packages/agent-runtime/src/action-registry.ts` — `ActionModule`(`'task'|'agentPermissions'`, 2 GERÇEK modül, sahte çoklu-modül soyutlaması İCAT EDİLMEDİ), `ACTION_REGISTRY` (6 sabit `{actionType, module, label}` girişi, etiketler `AutonomyTierPanel`'in mevcut `KNOWN_ACTION_TYPES`'ıyla BİREBİR aynı). `ALLOWED_PARSE_COMMAND_TYPES` (parse-command.ts'in private allowlist'i) registry'ye DAHİL EDİLMEZ/DUPLICATE EDİLMEZ — v0'ın hiçbir tüketicisi bu bilgiye ihtiyaç duymuyor.
- **(b) Registry ↔ `dispatchExecute` ilişkisi — EN YÜK TAŞIYAN karar:** registry `dispatchExecute`'un switch'ini SÜRMEZ/YENİDEN YAZMAZ (tip-güvenliği/regresyon riski, sıfır fonksiyonel kazanç); tutarlılık YAPISAL BAĞLANMA yerine BİR TESTLE sağlanır (`action-registry.consistency.test.ts`, `ACTION_REGISTRY`'nin `actionType` kümesi ile `parseCommand`'ın `PROPOSED_ACTION_TYPES`'ının (YENİ export) TAM eşleşmesini doğrular).
- **(c) CommandPalette → `parse()`:** `rawQuery` boşken görünmeyen, arrow-key navigasyonu DIŞINDA yeni bir "komutu çalıştır" satırı → `useParseCommandMutation` → `apiClient.parseCommand` → mevcut `POST .../commands/parse` (SIFIR yeni backend kodu, RBAC mevcut `member`+ gate'i AYNEN).
- **(d) Palette sonuç render:** `parseResult.actions` (ZATEN yürütülmüş `autonomousResults` HARİÇ) küme farkıyla bekleyen aksiyonlar belirlenir — palette bunlar için KENDİ onayla/reddet UI'sini İNŞA ETMEZ, ZATEN var olan `AutomationHistoryPanel`'e (F2-T16) yönlendirir (bilgilendirici mesaj + çapa-bağlantısı).
- **(e) Ambient rozet:** `useAmbientPendingProposalsQuery` — `listProposals({pendingOnly:true, limit:5})`'i 45s `refetchInterval` ile poll'lar; `decidedAt=null` AMA `actions=[]` olan (tümü `'act_and_notify'`) proposal satırlarını istemci-taraflı filtreleyerek DIŞLAR (gerçek bir edge case, kodda doğrulandı); sayı 0 iken görünmez; tıklanınca `AutomationHistoryPanel`'e çapa-kaydırması (gerçek routing/sekme sistemi YOK, flat dev-shell).
- **(f) Registry'nin gerçek ikinci tüketicisi:** `AutonomyTierPanel.KNOWN_ACTION_TYPES` `ACTION_REGISTRY`'den türetilir — PLAN.md §5'in "ikilik oluşmaz" ilkesinin, kod tabanında ZATEN VAR OLAN bir ikiliği gidererek SOMUTLAŞTIRILMASI; `CommandPalette`'in pending-aksiyon etiketleri de AYNI registry'den (`findActionRegistryEntry`) okunur.
- **(g) RBAC/güvenlik:** registry PUBLIC/statik metadata, HİÇBİR `GET /action-registry` uç-noktası YOK; rol-bazlı UI-gizleme (`AutonomyTierPanel`'in ZATEN var olan `GOVERNANCE_FLOOR_ACTION_TYPES` nezaketiyle AYNI) bir güvenlik sınırı DEĞİL — gerçek yetkilendirme HER ZAMAN backend'de (mevcut, değiştirilmeyen gate'lerde) kalır. `reconfigureAgentPermissions` palette üzerinden YAPISAL OLARAK erişilemez (`ALLOWED_PARSE_COMMAND_TYPES`, dokunulmadı).
- **(h) HTTP yüzeyi:** SIFIR yeni backend rotası — `parse`/`proposals`/`decide` ÜÇÜ DE ZATEN VAR; tek eksik parça `apps/web`'in `parseCommand` istemci sarmalayıcısıydı (Karar c'de kapatıldı).

## PR Bölünmesi (2 PR, tek plan onayı hepsini kapsar)

1. **PR1 — Backend: Action Registry + tutarlılık testi.** `packages/agent-runtime/src/action-registry.ts` (`ActionModule`/`ActionRegistryEntry`/`ACTION_REGISTRY`/`findActionRegistryEntry`, `index.ts` export'u), `apps/server/src/ai/parse-command.ts`'e `PROPOSED_ACTION_TYPES` export'u, `apps/server/src/commands/action-registry.consistency.test.ts`. Testler: `findActionRegistryEntry`'nin bilinen/bilinmeyen `actionType` için doğru davrandığı; `ACTION_REGISTRY`'nin `actionType` kümesinin `PROPOSED_ACTION_TYPES`'ın (dolayısıyla `dispatchExecute`'un dispatch ettiği TAM 6 tipin) kümesiyle BİREBİR eşit olduğu (bu test, registry'ye bir tip eklenip switch güncellenmezse veya tersi KIRMIZI olmalı — kasıtlı olarak ikisinden birine tek taraflı bir tip eklenerek regresyon-doğrulaması yapılır). `dispatchExecute`'un KENDİSİ DEĞİŞTİRİLMEZ.
2. **PR2 — Frontend: registry tüketimi + palette-parse wiring + ambient rozet.** `@luminaos/agent-runtime` YENİ `apps/web` bağımlılığı; `AutonomyTierPanel.KNOWN_ACTION_TYPES` → `ACTION_REGISTRY`'den türetme; `apiClient.ts`'e `ParseCommandResponse`/`parseCommand`; `useProposalsQuery.ts`'e `useParseCommandMutation`; `CommandPalette.tsx`'e "komutu çalıştır" satırı + sonuç render (yürütülmüş/bekleyen ayrımı + `AutomationHistoryPanel` çapa-bağlantısı); `useAmbientPendingProposalsQuery.ts` (YENİ); `AmbientProposalsBadge.tsx` (YENİ); `App.tsx`'e mount + `id="automation-history-panel"`. Testler: `AutonomyTierPanel`'in `ACTION_REGISTRY`'den türetilen listeyle ÖNCEKİYLE AYNI 6 satırı render ettiği (regresyon); `CommandPalette`'in "komutu çalıştır" satırının doğru `{command}` gövdesiyle `parseCommand`'ı çağırdığı, `autonomousResults` içindeki aksiyonların "yürütüldü" olarak, kalanların bekleyen/`AutomationHistoryPanel`'e-yönlendirme olarak ayrıldığı, `parseError:true` durumunun görünür bir hata mesajı ürettiği; `useAmbientPendingProposalsQuery`'nin doğru `refetchInterval`/`refetchIntervalInBackground` ile çağrıldığı VE `actions:[]` olan bir `decidedAt:null` satırının sayıma DAHİL EDİLMEDİĞİ (güvenlik/doğruluk-kritik edge-case testi); `AmbientProposalsBadge`'in sayı 0 iken HİÇBİR ŞEY render etmediği, sayı>0 iken `AutomationHistoryPanel`'e çapa-bağlantısı içerdiği.

## Kapsam Dışı

- **Proaktif/otomatik AI-tetiklemeli öneri üretimi** (sayfa açılışı/periyodik analiz). ADR-0043 insan kararı 1'in AÇIKÇA reddettiği alternatif.
- **Artifact/widget üretiminin niyet ayrıştırıcıya entegrasyonu.** ADR-0043 insan kararı 2 — `ArtifactsService`/`WidgetsService` kendi uç-noktalarında kalır.
- **Yeni bir sunucu-push (WebSocket/SSE) altyapısı.** Ambient rozet client-poll ile çalışır (ADR-0042'nin AYNI gerekçesi).
- **`dispatchExecute`'un switch'inin registry-güdümlü bir dispatch mekanizmasına dönüştürülmesi.** ADR-0043 Karar b — tip-güvenliği/regresyon riski, tutarlılık bir testle sağlanıyor.
- **`reconfigureAgentPermissions`/meeting/trigger extractor'larının kendi ayrı gate'lerine herhangi bir değişiklik.** `ALLOWED_PARSE_COMMAND_TYPES`, `hasAtLeastRole(callerRole,'admin')` senkron kontrolleri DEĞİŞMEZ.
- **`AutonomyTierSettingsService`/`CommandsService.decide()`/`dispatchExecute`/ledger mekanizmasına herhangi bir değişiklik.** Zaten generic/tamamlanmış, olduğu gibi kullanılır.
- **Palette içinde tam bir onayla/reddet UI'si (`AutomationHistoryPanel`'in yeniden inşası).** ADR-0043 Karar d — palette yalnızca bilgilendirir + yönlendirir.
- **`GET /action-registry` gibi bir HTTP uç-noktası.** ADR-0043 Karar g — registry statik, doğrudan paket-import'uyla tüketilir.
- **Ambient rozetin tam/kesin sayım yapması.** v0'da `5+` eşiği yeterli (ADR-0043 Karar e).

## Kabul Kriterleri

- [x] **PR1:** `findActionRegistryEntry`, bilinen bir `actionType` için doğru `ActionRegistryEntry`'yi, bilinmeyen bir `actionType` için `undefined` döner.
- [x] **PR1:** `ACTION_REGISTRY`'nin `actionType` alanları TAM OLARAK 6 değer içerir: `createTask`, `generateSubtasks`, `assignPeople`, `createTaskFromMeeting`, `createTaskFromTrigger`, `reconfigureAgentPermissions` — her biri doğru `module` (`task` veya `agentPermissions`) ile eşleşmiş.
- [x] **PR1 (tutarlılık-kritik):** `action-registry.consistency.test.ts`, `ACTION_REGISTRY`'nin `actionType` kümesinin `PROPOSED_ACTION_TYPES`'ın (parse-command.ts'in zod enum'undan türetilen, `dispatchExecute`'un dispatch ettiği TAM tip kümesiyle birebir aynı) kümesiyle EŞİT olduğunu doğrular — bu test, iki listeden birine TEK taraflı bir tip eklenip diğerine eklenmezse KIRMIZI olmalı (test-writer bu regresyon-senaryosunu AÇIKÇA kanıtlamalı).
- [x] **PR1:** `dispatchExecute`'un (`apps/server/src/commands/commands.service.ts`) switch mantığına HİÇBİR KOD DEĞİŞİKLİĞİ yapılmadı (regresyon: mevcut `commands.service.test.ts`/entegrasyon testlerinin TAMAMI değişmeden yeşil).
- [x] **PR1:** `pnpm --filter @luminaos/agent-runtime typecheck && lint && test:changed` VE `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [x] **PR2:** `AutonomyTierPanel`, `ACTION_REGISTRY`'den türetilen listeyle ÖNCEKİ davranışla BİREBİR aynı 6 satırı (aynı `actionType`/`label` sırası ve içeriği) render eder (regresyon: mevcut `AutonomyTierPanel.test.tsx` DEĞİŞMEDEN yeşil kalır).
- [x] **PR2:** `CommandPalette`'te `rawQuery` boş değilken bir "`{rawQuery}` komutunu çalıştır" satırı görünür, boşken görünmez; bu satır mevcut arrow-key/Enter arama-navigasyon davranışına (mevcut `CommandPalette.test.tsx`) HİÇBİR REGRESYON getirmez.
- [x] **PR2:** Bu satıra tıklandığında/Enter'a basıldığında `apiClient.parseCommand(workspaceId, {command: rawQuery})` doğru gövdeyle çağrılır.
- [x] **PR2:** `parseResult.autonomousResults` içindeki HER aksiyon, palette'te "otomatik yürütüldü" olarak (Onayla/Reddet butonu OLMADAN) gösterilir.
- [x] **PR2:** `parseResult.actions` içinde olup `autonomousResults`'ta KARŞILIĞI OLMAYAN her aksiyon "bekliyor" olarak gösterilir VE `AutomationHistoryPanel`'e (`#automation-history-panel`) bir çapa-bağlantısı sunulur — palette bu aksiyonlar için kendi onayla/reddet UI'sini SUNMAZ.
- [x] **PR2:** `parseResult.parseError === true` durumunda kullanıcıya görünür bir hata mesajı gösterilir (çökmeden).
- [x] **PR2:** `useAmbientPendingProposalsQuery`, `listProposals`'ı `{pendingOnly:true, limit:5}` ile, `refetchInterval=45_000`+`refetchIntervalInBackground:false` seçenekleriyle çağırdığının doğrulanması.
- [x] **PR2 (doğruluk-kritik):** `useAmbientPendingProposalsQuery`'nin, `decidedAt:null` AMA `actions:[]` olan bir mock proposal satırını sayıma DAHİL ETMEDİĞİ — yalnızca `actions.length>0` olan `decidedAt:null` satırların sayıldığı ayrı bir testle kanıtlanmış.
- [x] **PR2:** `AmbientProposalsBadge`, sayı `0` iken HİÇBİR ŞEY render ETMEZ (`null` döner); sayı `>0` iken `AutomationHistoryPanel`'e (`#automation-history-panel`) giden bir bağlantı ve doğru sayı/`"5+"` metni içerir (`hasMore:true` durumu ayrı test edilmiş).
- [x] **PR2 (regresyon):** `AutomationHistoryPanel`'in KENDİSİ (`useProposalsQuery`/`useDecideProposalMutation`, onayla/reddet akışı) HİÇBİR DAVRANIŞ DEĞİŞİKLİĞİ görmüyor — yalnızca `App.tsx`'te bir sarmalayıcı `id` kazanıyor.
- [x] **PR2:** `pnpm --filter @luminaos/web typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.

## Done

3 PR `main`'e merge edildi (2 uygulama PR'ı + spec/ADR'yi resmileştiren 1 doküman-only PR):

- **Docs (spec + ADR-0043)** ([#245](https://github.com/sirfurkansahin/luminaos/pull/245)): bu spec dosyası + `docs/adr/ADR-0043-komut-duzlemi-v2.md` — kod içermeyen, mimari kararı (a)-(h) ve PR bölünmesini sabitleyen doküman-only PR.
- **PR1 — `packages/agent-runtime` action registry** ([#246](https://github.com/sirfurkansahin/luminaos/pull/246)): `action-registry.ts` (`ActionModule`/`ActionRegistryEntry`/`ACTION_REGISTRY` 6 sabit giriş/`findActionRegistryEntry`, sıfır I/O), `parse-command.ts`'e `PROPOSED_ACTION_TYPES` export'u, `action-registry.consistency.test.ts` (drift-simülasyon regresyon testleri dahil) — `dispatchExecute`'un switch'i DEĞİŞTİRİLMEDİ. Kanıt: 119/119 `agent-runtime` testi + 580/580 server birim testi yeşil, `commands.service.ts`'e sıfır regresyon.
- **PR2 — Frontend: registry tüketimi + palette-parse wiring + ambient rozet** ([#247](https://github.com/sirfurkansahin/luminaos/pull/247)): `AutonomyTierPanel.KNOWN_ACTION_TYPES`'ın `ACTION_REGISTRY`'den türetilmesi, `apiClient.parseCommand`/`useParseCommandMutation`, `CommandPalette`'e "komutu çalıştır" satırı + yürütülmüş/bekleyen aksiyon render ayrımı + `#automation-history-panel` çapa-bağlantısı (palette içinde onayla/reddet UI'si YOK), `useAmbientPendingProposalsQuery`/`AmbientProposalsBadge` (YENİ), `App.tsx`'e mount + sarmalayıcı `id`. Kanıt: 74/74 yeni/genişletilmiş frontend testi + 836/836 tam web test paketi yeşil, sıfır regresyon.

## Açık Sorular

- **`CommandPalette`'in "komutu çalıştır" satırının tam UI-yerleşimi/etiketi** (sonuç grubunun altında mı, ayrı bir sekme/mod mu) — implementer'ın kararı, F3-T7 PR3'ün AYNI serbestliği; kabul kriterleri davranışı sabitliyor, pikseli DEĞİL.
- **Ambient rozetin App shell'deki TAM konumu** (`App.tsx`'in bugünkü flat dev-shell yapısında hangi panelin hemen öncesi/sonrası) — implementer'ın kararı; gerçek bir header/nav bileşeni bu görevde İNŞA EDİLMİYOR (kod tabanında henüz yok).
- **Gerçek bir routing/sekme sistemi geldiğinde ambient rozetin `href="#automation-history-panel"` çapa-bağlantısının nasıl bir gerçek "panele git" navigasyonuna dönüşeceği** — bu görev İÇİNDE ÇÖZÜLMÜYOR, flat dev-shell'in kendisi ayrı bir gelecekteki karar.
- **PR2 uygulaması sırasında test-writer'ın kendi test fixture'larında ortaya çıkan iki lint hatası — düzeltildi:** `AmbientProposalsBadge.test.tsx`'te bir template-literal içinde sayının doğrudan interpolasyonundan kaynaklanan bir lint hatası; `AutonomyTierPanel.test.tsx`'te, `@luminaos/agent-runtime` henüz `apps/web`'in gerçek bir bağımlılığı olmadan yazılmış olmasından kalma, gereğinden savunmacı bir `@vite-ignore` etiketli dinamik `import()` kullanımı. Bağımlılık gerçek hale geldikten sonra ikisi de doğrudan düzeltildi — dinamik import, normal statik/tipli bir import'a çevrildi. Küçük bir uygulama notu, tasarım kararı değil.

## Sıradaki adım

Epik F3-E3, F3-T9'un tamamlanmasıyla (Kapsam L + Kapsam M) TAMAMLANDI — `docs/PLAN.md`'ye göre sıradaki Epik **F3-E4: Plan-Gerçek Motoru (Kapsam N)**, ilk görevi **F3-T10 — Evrensel baseline: herhangi bir sorgu/metrik/plan anlık görüntüsü + sapma hesaplayıcı** (satır 293). Henüz ne ADR'si ne spec dosyası var:

```
docs/PLAN.md'nin Epik F3-E3'ü (Artifact + Canlı Widget, Kapsam L / Intent-first UI, Kapsam M)
F3-T9 ile tamamladığını doğrula; sıradaki Epik F3-E4 (Plan-Gerçek Motoru, Kapsam N), ilk görevi
F3-T10 -- Evrensel baseline: herhangi bir sorgu/metrik/plan anlık görüntüsü + sapma hesaplayıcı
(henüz ne ADR'si ne spec dosyası var). Önce explorer ile mevcut QuerySpec/SavedView/widget
altyapısını (F1-T6, F1-T9, F3-T8) VE "baseline_snapshot" kavramına en yakın emsalleri keşfet,
sonra architect ile docs/adr/ADR-0044-<konu>.md taslağını VE docs/specs/F3-E4/F3-T10-<konu>.md
spec dosyasını oluştur, insana onaylat; sonra plan mode'a geç.
```
