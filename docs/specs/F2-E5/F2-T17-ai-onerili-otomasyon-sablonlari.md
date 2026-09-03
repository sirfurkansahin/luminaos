# F2-T17 — AI Önerili Otomasyon Şablonları

**Epik:** F2-E5 (Otomasyon Motoru, Kapsam I) · **Durum:** Taslak — insan onayına sunuluyor.
**Bağımlılık:** F2-T15/ADR-0032 (tetikleyici/koşul/aksiyon çekirdeği — bu görevin ürettiği `automation_triggers`'a dönüşüm hedefi), F2-T16/ADR-0033 (`CommandsService.listProposals` — bu görevin kullanım-deseni girdisinin bir kaynağı), F1-T16/ADR-0015 (konuşma-komutları öner→onayla akışı — bu görevin izlediği fail-closed disiplinin kaynağı).

> ⚠️ MİMARİ-KARAR GEREKTİREN GÖREV — CLAUDE.md'nin ADR kriterinin (a) ve (b) fıkralarına giriyor: (a) yeni bir event-sourced varlık (`trigger_template_suggestions`) icat ediliyor — `command_proposals`'ın mimarisini yansıtan ama ona katılmayan, gelecekteki "AI bir config-nesnesi önerir, insan onaylar" görevlerinin üzerine inşa edeceği bir sözleşim; (b) `packages/ai-gateway` üzerinden ÜÇÜNCÜ bir LLM-çağrı orkestratörü ekleniyor (kullanım-deseni özetinden tetikleyici şablonu üretimi) — bu, kota/kilit/model-seçimi disiplinine yeni bir `outputType` ekliyor. `architect`'in bu iki noktayı netleştiren bir ADR taslağı (ADR-0034) + insan onayı koddan önce gerekli.

## Amaç

F2-T15'in tetikleyici/koşul motoru (ADR-0032) ve F2-T16'nın otomasyon geçmişi ekranı (ADR-0033), bir workspace'in ne sıklıkla hangi komutları çalıştırdığını, hangi aksiyon tiplerini onayladığını/reddettiğini ve hâlihazırda hangi tetikleyicilere sahip olduğunu artık OKUNABİLİR hale getirdi — ama bu veriden YENİ bir otomasyon fikri çıkarmak tamamen insanın kendi gözlemine bırakılmış durumda. Bu görev, AI'ın bu geçmiş kullanım verisini analiz edip "bu deseni bir tetikleyiciye dönüştürmek ister misin?" şeklinde somut, adı ve `spec`'i hazır ŞABLON önerileri üretmesini; kullanıcının bu önerileri inceleyip tek tıkla onaylayarak (veya reddederek) gerçek bir `automation_triggers` satırına dönüştürebilmesini sağlıyor. F1-T16'dan beri bu kod tabanının her AI-önerisi özelliğinde olduğu gibi, hiçbir şablon insan onayı olmadan gerçek bir tetikleyiciye dönüşmez.

## Mevcut Durum (bir `Explore` dispatch'i + bir `Plan` subagent pressure-test'iyle doğrulandı)

- **`packages/automation/src/trigger.ts`/`trigger-commands.ts`'de hiçbir "draft"/"template"/"suggestion" kavramı yok** — yalnızca `ActionTemplate` (bir GERÇEK tetikleyicinin aksiyon payload'ı `{title: string}`, bir öneri değil). `createTrigger(input: {triggerId, workspaceId, name, spec: TriggerSpec}): TriggerEventDraft[]` SAF bir fonksiyon (DB yan etkisi yok, doğrular veya fırlatır — `name` boş olamaz, `scheduled` için `intervalMinutes` pozitif tamsayı, `condition` için `objectType`/`fieldKey` boş olamaz + `assertSafeRegexPattern`). Bu, bir öneri onaylanırken YENİDEN KULLANILACAK tam olarak doğru validasyon noktası.
- **`AutomationTriggersService`** (F2-T15/ADR-0032 §h): `create(workspaceId, actor, callerRole, {name, spec})` admin+ RBAC, gerçek actor kaydeder; `.list(workspaceId, callerRole)` member+, TAM `Trigger[]` döner (tek okuma metodu, `get(id)` yok).
- **`CommandsService.listProposals`** (F2-T16/ADR-0033 §b): `listProposals(workspaceId, callerRole, filter?: {pendingOnly?, limit?, cursor?})`, member+ RBAC, `DEFAULT_LIST_PROPOSALS_LIMIT=50`/`MAX_LIST_PROPOSALS_LIMIT=200` (serviste kırpılmış). `CommandProposalSummary`: `{id, workspaceId, command, sourceObjectId, actions, decisions, createdAt, decidedAt}`.
- **Kritik mimari çatal:** `ProposedAction`/`command_proposals`/`recordProposal` KAPALI bir nesne-mutasyonu aksiyon tipleri kümesi (`createTask`/`generateSubtasks`/`assignPeople`/`createTaskFromMeeting`/`createTaskFromTrigger`) — `executeDecidedAction`'ın exhaustive switch'i her zaman bir Lumina Object üretir/mutasyona uğratır. Bir "tetikleyici şablonu öner" tipini buraya eklemek bu değişmezi bozar (bir tetikleyici oluşturmak nesne mutasyonu değildir). Bu yüzden bu görev YENİ, BAĞIMSIZ bir event-sourced varlık gerektiriyor.
- **AI-çağrı deseni** (`apps/server/src/ai/parse-command.ts`/`extract-meeting-actions.ts`, ikisi de tam okundu): girdi arayüzü `{provider, <görev-özel girdi>, model?, recordUsage}` → zod şeması → saf `render*Prompt` → `complete()` closure → `tryParse*` (JSON.parse→safeParse→sunucu-taraflı fresh id) → orkestratör (bir kez dene, başarısızsa AYNI prompt'la bir kez daha dene, ikinci başarısızlıkta ASLA fırlatmayan bir sentinel döner: `{..., parseError: true, message}`).
- **Kota/kilit disiplini** (`ai-usage.service.ts`, `commands.service.ts:229-249`): `withWorkspaceAILock` (Postgres advisory lock, TÜM kritik bölüm boyunca tutulur — TOCTOU kota yarışını önler) → `assertAITokenQuotaNotExceeded` → `assertAICostBudgetNotExceeded` → `selectAIModel({outputType})` → provider çağrısı → `recordAIUsage`. Her iki kota kontrolü de provider çağrısından ÖNCE, tam olarak bir kez çalışır.
- **`selectAIModel({outputType: 'text'|'select'|'qa'|'command'}): string`** — `'select'` Haiku'ya, geri kalanı Sonnet'e yönlendirir.
- **Kod tabanında hiçbir "kullanım deseni analizi"/"öneri motoru"/"şablon" özelliği yok** (kapsamlı grep ile doğrulandı) — F2-T17 bunun ilki olacak. `AutomationTriggersService.list()` + `CommandsService.listProposals()` bu görevin "kullanım deseni" girdi verisi için TEK iki mevcut okuma kaynağı; üçüncü bir agregasyon/analitik okuma-modeli yok.

## Kapsam

1. **Yeni event-sourced varlık: `trigger_template_suggestions`** — `command_proposals`'ın mimarisini yansıtan (kendi stream tipi, `pending → approved|rejected` durum makinesi), her biri aday bir `{name, spec: TriggerSpec, rationale}` taşıyan öneri kayıtları.
2. **Kullanım-deseni özetleme** — `AutomationTriggersService.list()` (aktif tetikleyiciler) + `CommandsService.listProposals()` (karara bağlanmış öneriler) çıktısını, LLM'e beslenebilecek SINIRLI boyutlu bir özet tabloya (aksiyon tipi × sonuç, gruplu/tally'li, örnek-sınırlı) dönüştüren saf bir fonksiyon.
3. **AI şablon-önerisi orkestratörü** — bu özeti `packages/ai-gateway` üzerinden LLM'e gönderip en fazla 5 aday `{name, spec, rationale}` öneri üreten, mevcut kota/kilit/retry/sentinel disiplinini izleyen üçüncü bir orkestratör (`parse-command.ts`/`extract-meeting-actions.ts`'in yanına).
4. **`TriggerSuggestionsService`/`Controller`** — `list` (member+), `runAnalysis` (admin+, isteğe bağlı tetiklenir, 15dk/workspace cooldown), `decide` (admin+, onayda GERÇEK `AutomationTriggersService.create`'i çağırır, reddte yalnızca durumu günceller).
5. **İki katmanlı savunmacı yeniden-doğrulama** — öneri-anında `createTrigger`'ın kuru-çalıştırması (güvensiz adayları sessizce düşürür) + onay-anında `AutomationTriggersService.create`'in GERÇEK, değiştirilmemiş çağrısı (yanıt zod şemasının yalnızca JSON şeklini kontrol ettiğini, iş kuralı doğrulamasının yerine geçmediğini varsayarak).
6. **Frontend: `TriggerSuggestionsPanel.tsx`** — bekleyen önerileri (isim + gerekçe + spec özeti) listeler, "Şimdi analiz et" butonu sunar, her öneri için onay/red aksiyonu (F2-T16'nın `AutomationHistoryPanel.tsx`'inin en yakın emsali).

## Kapsam DIŞI

- **Zamanlanmış/otomatik analiz çalıştırması** — v0'da yalnızca isteğe bağlı (admin butona basar); bir arka plan poller'ı (`TriggerSchedulerService` benzeri) bu görevin kapsamında DEĞİL (maliyet/doğruluk-gereksinimi gerekçesiyle, aşağıya bakın).
- **Reddedilen önerilerin kalıcı olarak bastırılması** — bir öneri reddedildikten sonra AYNI `(kind, spec)`'in gelecekteki bir analizde tekrar önerilmesini engelleyen bir "kalıcı ret listesi" bu görevde YOK (v0 gürültüsü olarak kabul edilir).
- **Şablonların düzenlenebilmesi (onaydan önce isim/spec'i insan değiştirebilsin)** — v0'da bir öneri ya OLDUĞU GİBİ onaylanır ya da reddedilir; kısmi düzenleme kapsam dışı (gelecekte `UpdateTriggerInput` zaten var, ayrı bir görev olarak eklenebilir).
- **Çoklu-workspace/organizasyon-genelinde desen analizi** — her analiz çalıştırması tek bir workspace'e sıkı sıkıya kapsamlanır, workspace'ler arası desen karşılaştırması yok.

## Açık Sorular

1. **[KRİTİK] `trigger_template_suggestions`'ın RBAC'ı nasıl olmalı?**
   - **İnsan kararı (bu görevin Plan Mode oturumunda `AskUserQuestion` ile alındı):** member+ okuma, admin+ yazma (`analyze`+`decide`) — `AutomationTriggersService.list`'in emsalini yansıtır; bir önerinin taşıdığı bilgi (aday isim/spec/gerekçe) zaten bir gerçek tetikleyici tanımından daha hassas değil. `WebhookSubscriptionsService`'in (F2-T16) admin+/admin+ daha muhafazakâr emsali BİLİNÇLİ olarak reddedildi.
2. **[KRİTİK] Analiz çalıştırması nasıl tetiklenmeli ve hız sınırlanmalı?**
   - **İnsan kararı (aynı oturumda `AskUserQuestion` ile alındı):** yalnızca isteğe bağlı (admin "Şimdi analiz et" butonuna basar) + workspace başına 15 dakikalık cooldown. Zamanlanmış bir arka plan işi YOK — bu özelliğin hiçbir doğruluk/güncellik gereksinimi yok, tüm workspace'leri kör bir aralıkla taramak saf israf olurdu.
3. **Yeni varlık `command_proposals`'a mı katılmalı, yoksa bağımsız mı olmalı?**
   - **Öneri (Plan subagent'ının pressure-test'i, mimari gerekçe yukarıda "Mevcut Durum"da):** BAĞIMSIZ, `command_proposals`'ın mimarisini yansıtan ama ona katılmayan yeni bir event-sourced varlık (`trigger_template_suggestions`) — çünkü bir tetikleyici-şablonu önerisi bir nesne-mutasyonu değil, `AutomationTriggersService.create`'in bir taslağı.
4. **Çalıştırma başına kaç öneri üretilebilir, aynı `(kind, spec)`'li bir öneri zaten bekliyorsa ne olur?**
   - **Öneri:** en fazla 5 öneri/çalıştırma (hem depolama hem insan inceleme yükünü sınırlar); persist etmeden önce workspace'in mevcut `'pending'` bir öneriyle aynı `(kind, spec)`'e sahip adaylar atlanır (dedup).
5. **LLM'in ürettiği bir `spec` iş-kuralı açısından güvensizse (ör. geçersiz regex, negatif interval) ne olur?**
   - **Öneri:** iki katmanlı savunmacı yeniden-doğrulama — öneri-anında `createTrigger`'ın kuru-çalıştırması güvensiz adayları sessizce düşürür (asla bir öneri olarak persist edilmez); onay-anında `AutomationTriggersService.create`'in gerçek çağrısı (aynı validasyonu transitif olarak tekrar uygular) başarısız olursa öneri `'pending'` kalır, asla bozuk bir tetikleyici yazılmaz.

## Kabul Kriterleri

- [ ] Açık Soru 1-5'in insan kararları netleşti (`architect` taslağı ADR-0034 + insan onayı) ve insan onayından önce sunuldu.
- [ ] Bir workspace admin'i, "Şimdi analiz et" butonuyla (veya destekleyici `POST` uç noktasıyla) bir analiz çalıştırması başlatabilir; bu çalıştırma workspace'in geçmiş kullanım verisinden (aktif tetikleyiciler + karara bağlanmış öneriler) en fazla 5 aday tetikleyici-şablonu önerisi üretir.
- [ ] Her öneri bir aday `name` + geçerli bir `TriggerSpec` + insan-okunabilir bir `rationale` taşır; LLM'in ürettiği güvensiz/geçersiz bir spec hiçbir zaman bir öneri olarak persist edilmez (öneri-anı kuru-çalıştırma filtresi).
- [ ] Bir workspace member'ı bekleyen önerileri listeleyebilir (member+ RBAC); yalnızca bir admin bir öneriyi onaylayabilir/reddedebilir (admin+ RBAC).
- [ ] Bir öneri onaylandığında, `AutomationTriggersService.create`'in GERÇEK (değiştirilmemiş) çağrısı üzerinden gerçek bir `automation_triggers` satırı oluşturulur; bu satırın actor'ü HER ZAMAN onaylayan insan admin'dir, asla AI değil. Onay-anı validasyonu başarısız olursa öneri `'pending'` kalır, kısmi/bozuk bir tetikleyici satırı asla yazılmaz.
- [ ] Bir öneri reddedildiğinde `automation_triggers`'a hiçbir dokunuş yapılmaz, öneri yalnızca `'rejected'` işaretlenir.
- [ ] Cross-workspace izolasyon: bir workspace'in önerileri/analiz sonuçları başka bir workspace'e asla sızmaz.
- [ ] Workspace başına 15 dakikalık analiz cooldown'u uygulanır (hızlı art arda `runAnalysis` çağrıları reddedilir); mevcut `AIUsageService` kota/maliyet kontrolleri (provider çağrısından önce, tam olarak bir kez) bu yeni orkestratör için de aynen uygulanır.
- [ ] Testler: RBAC (member yalnızca-liste, admin analyze/decide), cross-workspace izolasyon, onaylamanın gerçek bir `automation_triggers` satırı ürettiği (doğru actor ile), reddetmenin `automation_triggers`'a dokunmadığı, güvensiz-spec'li bir adayın öneri olarak bile persist edilmediği, cooldown'un ikinci bir hızlı çalıştırmayı reddettiği, kullanım-deseni özetleme fonksiyonunun agregasyon doğruluğu, AI orkestratörünün retry/sentinel akışı.
- [ ] `security-reviewer` denetiminde bulgu yok (özellikle: yanıt zod şemasının iş-kuralı doğrulamasının yerine GEÇMEDİĞİ, kota/cooldown bypass'ı, RBAC bypass'ı, onaylanan tetikleyicinin actor'ünün gerçekten insan olduğu).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** Bu spec taslağı insan onayına sunulur (zaten Plan Mode'da onaylandı — bkz. yukarıdaki İnsan kararları). Şimdi `architect` ile ADR-0034 taslağı (event-sourcing-vs-düz-CRUD seçimi, iki-katmanlı savunmacı yeniden-doğrulama, actor-provenance kuralı, RBAC ve analiz-tetikleme kararlarının "İnsan Onayı" bölümü olarak kaydı) hazırlanır; onaylanırsa PR1'den başlayarak `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir.
