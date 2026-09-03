# F3-T1 — Ajan Çalışma Zamanı (Agent Runtime): Sandbox, Kaynak Sınırları, İzin Manifestosu

**Epik:** F3-E1 (Agent Runtime + Skill SDK, Kapsam J) · **Durum:** ADR-0035 kabul edildi — `test-writer` ile PR1'e başlanıyor. Bu görev F3-E1'in ve FAZ 3'ün ("Otonomi ve Farklılaşma") açılış görevidir.
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

- [ ] `evaluateManifestGrant` fail-closed çalışır: manifesto yok / iptal edilmiş (`revokedAt` set) / yanlış aksiyon tipi / kapsam dışı / zaman penceresi dışı durumlarının HER BİRİNDE `false` döner; `'all'` kapsamı + geçerli zaman penceresi + doğru aksiyon tipi kombinasyonunda `true` döner.
- [ ] `assertValidManifestGrant` geçersiz girdiyi reddeder: boş `actionTypes`, boş `objectTypes` dizisi, `startsAt >= expiresAt`.
- [ ] `runInAgentSandbox` hiçbir durumda (senkron throw, reddedilen promise, timeout/asla-çözülmeyen promise) çağırana istisna sızdırmaz — her çağrıda her zaman yapılandırılmış bir `AgentActionResult` döner.
- [ ] RBAC: bir workspace member'ı `grant`/`revoke` çağıramaz (403/`ForbiddenError`); `list` çağırabilir.
- [ ] Cross-workspace izolasyon: bir workspace'in izin manifestosu başka bir workspace'te ne görünür ne de geçerlidir.
- [ ] grant → revoke → re-grant akışı: `revokedAt` sıfırlanır, kapsam/aksiyon/zaman penceresi güncellenir (upsert davranışı — `(workspaceId, agentIdentifier)` anahtarına yeni bir satır eklenmez).
- [ ] Eşzamanlılık tavanı ve hız sınırı zorlanır (aşıldığında ilgili hata/red davranışı gözlemlenir); Postgres advisory-lock iki eşzamanlı çağrı altında doğru çalışır (yarış durumu yok).
- [ ] Mevcut 4 sabit-actor'lü AI orkestratörü (`TRIGGER_ENGINE_ACTOR`, `TRIGGER_SUGGESTION_ACTOR`, `MEETING_ACTION_EXTRACTOR_ACTOR`, `COMMAND_PARSER_ACTOR`) bu görevle DEĞİŞTİRİLMEMİŞTİR (regresyon testleriyle doğrulanır).
- [ ] UI eklenmemiştir — bu, kapsam dışı olduğu için beklenen bir durumdur, eksiklik değildir.
- [ ] `security-reviewer` denetiminde bulgu yok (özellikle: fail-closed değerlendiricinin gerçekten fail-closed olduğu, RBAC bypass'ı, cross-workspace sızıntısı, sandbox'ın istisna sızdırmadığı, advisory-lock'un TOCTOU açığı bırakmadığı).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

## Done

Henüz başlanmadı — bu bölüm görev tamamlandığında PR linkleri ve test kanıtıyla doldurulacak.

---

**Sıradaki adım:** ADR-0035 (`docs/adr/ADR-0035-ajan-calisma-zamani-izin-manifestosu.md`) kabul edildi. `test-writer` ile PR1'e (packages/agent-runtime saf domain) geçilebilir.

```
docs/adr/ADR-0035-ajan-calisma-zamani-izin-manifestosu.md'deki Karar (a)-(j)'yi ve bu
spec dosyasının Kabul Kriterleri'ni temel alarak, F3-T1 PR1 (packages/agent-runtime saf
domain: AgentPermissionManifest tipleri, olay şemaları, assertValidManifestGrant,
evaluateManifestGrant, runInAgentSandbox) için test-writer ile başarısız testleri yaz.
```
