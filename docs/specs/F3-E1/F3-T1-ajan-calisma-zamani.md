# F3-T1 — Ajan Çalışma Zamanı (Agent Runtime): Sandbox, Kaynak Sınırları, İzin Manifestosu

**Epik:** F3-E1 (Agent Runtime + Skill SDK, Kapsam J) · **Durum:** Tamamlandı — ADR-0035 + PR1 (#191), PR2 (#192), PR3 (#193). Bu görev F3-E1'in ve FAZ 3'ün ("Otonomi ve Farklılaşma") açılış görevidir.
**Bağımlılık:** F2-T17/ADR-0034 (FAZ 2'nin son görevi — bu görevden önce tamamen kapandı), F2-T8/ADR-0024 (`MemoryAccessPolicy`/`isAgentAllowedToAccessMemory` — bu görevin izin-manifestosu modelinin 2-boyutlu emsali ve consumerless v0 riski örneği).

> ⚠️ MİMARİ-KARAR GEREKTİREN GÖREV — CLAUDE.md'nin ADR kriterinin (a) ve (b) fıkralarına giriyor: (a) yeni bir event-sourced varlık (`agent_permission_manifests`) icat ediliyor — `MemoryAccessPolicy`'nin (ADR-0024) grant/revoke şeklini 3 boyuta (veri kapsamı × aksiyon × zaman penceresi) genişleten, gelecekteki tüm ajan-yetkilendirme görevlerinin (F3-T2, F3-T3, F3-E2) üzerine kuracağı bir sözleşim; (b) yeni bağımsız bir paket (`packages/agent-runtime/`) ve onun sunucu bağlaması, birden fazla gelecek göreve dayatılan bir API kontratı (`AgentActionResult`, `evaluateManifestGrant`, `executeAgentAction`) tanımlıyor. `architect`'in bu iki noktayı netleştiren bir ADR taslağı (ADR-0035) + insan onayı koddan önce gerekli.

## Amaç

FAZ 2 boyunca kurulan tüm AI orkestratörleri (tetikleyici motoru, tetikleyici-önerisi, toplantı-aksiyon-çıkarımı, komut-ayrıştırıcı) sabit, kod içine gömülü actor'lerle çalışıyor ve kendi RBAC'ları dışında hiçbir ortak yetki modeline tabi değil. FAZ 3'ün otonomi hedefi (ajanların kendi başına, insan onayı olmadan daha fazla aksiyon alabilmesi) için önce şu soruya cevap veren ortak bir temel gerekiyor: bir ajan HANGİ veri kapsamına, HANGİ aksiyon tipine, HANGİ zaman penceresinde erişebilir? Bu görev bu soruyu cevaplayan bir izin-manifestosu sistemi + bu manifestoyu zorlayan hafif bir çalışma-zamanı sınırı ("sandbox") + kaynak sınırları (eşzamanlılık tavanı + hız sınırı) kuruyor. Bu, F3-T2'nin (Skill SDK) ve F3-T3'ün (ajan-insan etkileşimi) üzerine inşa edeceği altyapı — henüz bu altyapıyı çağıran bir tüketici YOK (kabul edilen bir v0 riski, ADR-0024'ün consumerless `isAgentAllowedToAccessMemory`'siyle aynı emsal).

## Kapsam

1. **Yeni bağımsız paket `packages/agent-runtime/`** — framework-free (yalnızca `@luminaos/shared` + `zod`'a bağımlı, React/Nest import edemez):
   - İzin manifestosu tipleri + event şemaları (grant/revoke).
   - Saf validatörler (`assertValidManifestGrant` — boş `actionTypes`, boş `objectTypes` dizisi, `startsAt >= expiresAt` gibi geçersiz girdileri reddeder).
   - Saf fail-closed değerlendirici `evaluateManifestGrant` (manifesto yok/iptal edilmiş/yanlış aksiyon/kapsam dışı/zaman penceresi dışı → `false`; `'all'` kapsamı + geçerli pencere + doğru aksiyon → `true`).
   - Saf sandbox yardımcısı `runInAgentSandbox` — senkron throw, reddedilen promise, asla-çözülmeyen promise (timeout) durumlarının HİÇBİRİNİN çağırana istisna sızdırmadığı, her zaman yapılandırılmış bir `AgentActionResult` döndüren çalışma-zamanı sınırı.
2. **`apps/server/src/agent-runtime/` — izin manifestosu sunucu bağlaması:**
   - `AgentPermissionManifestsService`: `grant`/`revoke` (admin+), `list` (member+), `checkPermission` (RBAC'sız dahili API — diğer servislerin çağıracağı okuma noktası).
   - `AgentPermissionManifestsController`: `workspaces/:workspaceId/agent-runtime/permission-manifests`.
   - Yeni tablo `agent_permission_manifests` + ilgili projeksiyon.
3. **`apps/server/src/agent-runtime/` — kaynak sınırları + sandbox icra bağlaması:**
   - `AgentResourceLimitsService`: workspace+ajan başına Postgres advisory-lock korumalı hız sınırı, process-local eşzamanlılık tavanı, genel giriş noktası `executeAgentAction` (izin kontrolü → kaynak sınırı kontrolü → `runInAgentSandbox` içinde icra → sonucu kaydet).
   - `AgentConcurrencyGuard`.
   - Yeni tablo `agent_action_executions` + ilgili projeksiyon.
   - İlgili env değişkenleri (eşzamanlılık tavanı/hız sınırı varsayılanları).

## 4 Bağlayıcı İnsan Kararı (bu görevin Plan Mode oturumunda `AskUserQuestion` ile alındı)

1. **Sandbox modeli:** hafif in-process sınır (timeout + eşzamanlılık tavanı + yapılandırılmış hata izolasyonu). Gerçek OS/VM izolasyonu (`worker_threads`/`child_process`/`vm2`/`isolated-vm`) YOK — çünkü henüz çalıştırılacak üçüncü-parti/imzasız kod yok (bu, F3-T2'nin Skill SDK'sının imzalı beceri paketleriyle gelecekte yeniden değerlendirilebilecek bir karar).
2. **İzin manifestosu kalıcılığı:** event-sourced, grant/revoke şekli — `MemoryAccessPolicy`'nin (ADR-0024) 3 boyuta (veri kapsamı × aksiyon tipi × zaman penceresi) genişletilmiş hâli, ama 2-parçalı `(workspaceId, agentIdentifier)` doğal anahtarıyla. Bu, `MemoryAccessPolicy`'nin 3-parçalı `(workspaceId, userId, agentIdentifier)` anahtarından KASITLI bir sapmadır — `agent_permission_manifests` `MemoryAccessPolicy`'nin YERİNE geçmez, onunla BİRLİKTE, ayrı bir varlık olarak var olur.
3. **Mevcut 4 sabit-actor'lü AI orkestratörü** (`TRIGGER_ENGINE_ACTOR`, `TRIGGER_SUGGESTION_ACTOR`, `MEETING_ACTION_EXTRACTOR_ACTOR`, `COMMAND_PARSER_ACTOR`) bu görevde retrofit EDİLMEZ — kendi mevcut RBAC'larıyla değişmeden kalırlar. Bu görevin izin-manifestosu/sandbox/kaynak-sınırı altyapısını bu orkestratörlere bağlamak kapsam dışıdır.
4. **UI YOK** (v0, backend-only) — manifesto yönetimi için bir yönetim paneli bu görevde YOK, sonraki bir göreve bırakılır.

## Mimari Özet (ADR-0035'te tam resmileşecek)

- `packages/agent-runtime/`: manifesto tipleri, olay şemaları, saf validatörler, saf fail-closed değerlendirici (`evaluateManifestGrant`), saf sandbox yardımcısı (`runInAgentSandbox`) — framework-free, yalnızca `@luminaos/shared` + `zod`'a bağımlı.
- `apps/server/src/agent-runtime/`: `AgentPermissionManifestsService` + `Controller`, `AgentResourceLimitsService` + `AgentConcurrencyGuard`, 2 yeni tablo (`agent_permission_manifests`, `agent_action_executions`), 2 yeni projeksiyon.

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar)

1. **PR1:** `packages/agent-runtime` saf domain + unit testler.
2. **PR2:** İzin manifestosu sunucu bağlaması (şema+migration+projection+service+controller+module) + entegrasyon testler.
3. **PR3:** Kaynak sınırları + sandbox icra bağlaması (şema+migration+projection+service+guard+env) + entegrasyon testler.

## Kapsam DIŞI

- **F3-T2 (Skill SDK v1):** imzalı beceri paketleri, sürümleme, yetenek bildirimi, 20 birinci parti beceri — F3-E1'in kardeş görevi, bu görevde YOK.
- **F3-T3 (Ajan-insan etkileşimi):** @mention, görev atama, DM ile ajan yeniden yapılandırma — F3-E1'in kardeş görevi, bu görevde YOK.
- **F3-T4 (Uçuş kayıt cihazı — gerekçe kaydı + kaynaklar + geri alma planı):** CLAUDE.md'nin `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` mimari değişmezinin TAM denetim-izni katmanı BURADA kurulmaz — ayrı bir epikte (F3-E2: Cam Kutu Otonomi), F3-T4'te kurulacak.
- **F3-T5 (Otonomi kadranı)** ve **F3-T6 (Tek tık geri alma):** F3-E2'nin diğer görevleri, bu görevde YOK.
- **Mevcut 4 AI orkestratörünün retrofit edilmesi:** yukarıdaki İnsan Kararı 3'e bakın.
- **Yönetim paneli / UI:** yukarıdaki İnsan Kararı 4'e bakın.
- **Gerçek OS/VM izolasyonu:** yukarıdaki İnsan Kararı 1'e bakın.

## Kabul Kriterleri

- [x] `evaluateManifestGrant` fail-closed çalışır: manifesto yok / iptal edilmiş (`revokedAt` set) / yanlış aksiyon tipi / kapsam dışı / zaman penceresi dışı durumlarının HER BİRİNDE `false` döner; `'all'` kapsamı + geçerli zaman penceresi + doğru aksiyon tipi kombinasyonunda `true` döner. PR1 (#191).
- [x] `assertValidManifestGrant` geçersiz girdiyi reddeder: boş `actionTypes`, boş `objectTypes` dizisi, `startsAt >= expiresAt`. PR1 (#191).
- [x] `runInAgentSandbox` hiçbir durumda (senkron throw, reddedilen promise, timeout/asla-çözülmeyen promise) çağırana istisna sızdırmaz — her çağrıda her zaman yapılandırılmış bir `AgentActionResult` döner. PR1 (#191).
- [x] RBAC: bir workspace member'ı `grant`/`revoke` çağıramaz (403/`ForbiddenError`); `list` çağırabilir. PR2 (#192, `AgentPermissionManifestsService`/`Controller`).
- [x] Cross-workspace izolasyon: bir workspace'in izin manifestosu başka bir workspace'te ne görünür ne de geçerlidir. PR2 (#192)'nin entegrasyon testlerinde doğrulandı.
- [x] grant → revoke → re-grant akışı: `revokedAt` sıfırlanır, kapsam/aksiyon/zaman penceresi güncellenir (upsert davranışı — `(workspaceId, agentIdentifier)` anahtarına yeni bir satır eklenmez). PR2 (#192).
- [x] Eşzamanlılık tavanı ve hız sınırı zorlanır (aşıldığında ilgili hata/red davranışı gözlemlenir); Postgres advisory-lock iki eşzamanlı çağrı altında doğru çalışır (yarış durumu yok). PR3 (#193, `AgentConcurrencyGuard` + `AgentResourceLimitsService.executeAgentAction`).
- [x] Mevcut 4 sabit-actor'lü AI orkestratörü (`TRIGGER_ENGINE_ACTOR`, `TRIGGER_SUGGESTION_ACTOR`, `MEETING_ACTION_EXTRACTOR_ACTOR`, `COMMAND_PARSER_ACTOR`) bu görevle DEĞİŞTİRİLMEMİŞTİR (regresyon testleriyle doğrulanır). PR1/PR2/PR3'ün hiçbiri bu dört orkestratöre dokunmadı (ADR-0035 Karar f); mevcut regresyon test paketleri değişmeden geçti.
- [x] UI eklenmemiştir — bu, kapsam dışı olduğu için beklenen bir durumdur, eksiklik değildir. ADR-0035 Karar (h) uyarınca v0 backend-only kalındı.
- [x] `security-reviewer` denetiminde bulgu yok (özellikle: fail-closed değerlendiricinin gerçekten fail-closed olduğu, RBAC bypass'ı, cross-workspace sızıntısı, sandbox'ın istisna sızdırmadığı, advisory-lock'un TOCTOU açığı bırakmadığı). PR1/PR2/PR3 için ayrı ayrı sıfır-bulgu doğrulandı.
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil. Her PR için ayrı ayrı doğrulandı (bkz. Test kanıtı).

## Done

**PR'lar:**

- PR1 (#191): `packages/agent-runtime` saf domain — `AgentPermissionManifest`/`AgentDataScope`/`AgentActionType`/`AgentTimeWindow` tipleri, `AgentPermissionGranted`/`AgentPermissionRevoked` olay şemaları, `assertValidManifestGrant`, fail-closed `evaluateManifestGrant`, `runInAgentSandbox` (ADR-0035 Karar a/b/c).
- PR2 (#192): İzin manifestosu sunucu bağlaması — `apps/server/src/agent-runtime/` altında `AgentPermissionManifestsService` (`grant`/`revoke` admin+, `list` member+, `checkPermission` dahili/RBAC'sız), `AgentPermissionManifestsController` (`workspaces/:workspaceId/agent-runtime/permission-manifests`), `agent_permission_manifests` şeması + migration + projeksiyon, event-sourced grant/revoke (upsert/tombstone deseni, ADR-0035 Karar b/d/i).
- PR3 (#193): Kaynak sınırları + sandbox icra bağlaması — `AgentConcurrencyGuard` (süreç-yerel eşzamanlılık tavanı), `AgentResourceLimitsService.executeAgentAction` (izin kontrolü → kaynak sınırı kontrolü → `runInAgentSandbox` içinde icra → sonucu kaydet; DB-destekli hız sınırı, Postgres advisory-lock), `agent_action_executions` insert-only audit ledger + projeksiyon + ilgili env değişkenleri (ADR-0035 Karar g/i/j).

**Test kanıtı:**

- PR1 (#191) — tam birim test paketi bu oturumda yerel olarak doğrulandı (saf domain paketi, DB bağımlılığı yok).
- PR2 (#192) — 21 entegrasyon testi (12 servis + 9 controller); PR3 (#193) — 10 entegrasyon testi. Her ikisi de Testcontainers-destekli, gerçek Postgres gerektirir — bu oturumun sandbox'ında Docker olmadığı için yalnızca CI'ın `quality` kontrolünden geçtiği doğrulandı.
- PR3 (#193)'ün `agent-concurrency-guard.test.ts` (8/8) ve `env-agent-runtime.test.ts` (16/16) test dosyaları DB'ye bağımlı olmadıkları için bu oturumda yerel olarak da doğrulandı.
- Her üç PR için de `security-reviewer` geçişi ayrı ayrı sıfır-bulgu buldu.

**Mimari kaynağı:** ADR-0035 (`docs/adr/ADR-0035-ajan-calisma-zamani-izin-manifestosu.md`).

**Epik/Faz durumu:** F3-T1 tamamlandı, ama Epik F3-E1 (Agent Runtime + Skill SDK, Kapsam J) HENÜZ KAPANMADI — aynı epiğin F3-T2'si (Skill SDK v1: imzalı beceri paketleri, sürümleme, yetenek bildirimi, 20 birinci parti beceri) ve F3-T3'ü (ajan-insan etkileşimi) hâlâ beklemede. F3-T1 bu iki görevin üzerine kuracağı temel altyapıdır (izin manifestosu + sandbox + kaynak sınırları). `docs/PLAN.md`'nin "FAZ 3 — Otonomi ve Farklılaşma" bölümü bu görevle resmen başlamıştır — bu, FAZ 3'ün ilk tamamlanan görevidir.

---

**Sıradaki adım:** F3-T1 tamamlandı, ama Epik F3-E1'in bir sonraki görevi olan F3-T2'nin (Skill SDK v1) henüz bir spec dosyası yok — CLAUDE.md'nin ritüeli gereği (`docs/specs/<EPİK>/<GÖREV>.md` önce yazılmalı) önce spec yazılmalı, doğrudan koda geçilmemeli:

```
/yeni-ozellik F3-T2 — Skill SDK v1: imzalı beceri paketleri, sürümleme, yetenek bildirimi;
20 birinci parti beceri. Bu görev Epik F3-E1'in (Agent Runtime + Skill SDK, Kapsam J)
ikinci görevidir ve F3-T1'in (ADR-0035) kurduğu izin manifestosu/sandbox/kaynak-sınırı
altyapısının ilk gerçek tüketicisi olacaktır.
```
