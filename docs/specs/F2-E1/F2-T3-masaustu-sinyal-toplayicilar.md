# F2-T3 — Masaüstü Kabuktan Sinyal Toplayıcılar (Takvim Durumu, Aktif Pencere Başlığı)

**Epik:** F2-E1 (Lumina Context Fabric) · **Durum:** Taslak — insan onayı bekliyor
**Bağımlılık:** F2-T2b (apps/desktop iskeleti — Tauri v2, ADR-0019), F2-T1 (bağlam grafiği — ADR-0017, `context_graph_nodes`/`context_graph_edges`), ADR-0012 (takvim senkron — `calendar_events_cache` ve `GET /workspaces/:workspaceId/calendar/events`)

> ⚠️ MİMARİ-KRİTİK GÖREV: Bu görev CLAUDE.md'nin "hassas veri sınıfları buluta ham gönderilmez" mimari değişmezine (bkz. `docs/adr/ADR-000X-hibrit-ai.md`) doğrudan dokunuyor — aktif pencere başlığı ve takvim durumu kullanıcının en hassas ham verilerinden ikisi. Ayrıca burada tanımlanacak sinyal → olay → bağlam-grafiği yazma yolu (yeni bir domain event tipi + yeni bir ingestion sözleşimi), repoda hiç emsali olmayan bir desen kurup gelecekteki F2-T4 ve Faz 3 masaüstü-bağımlı görevlerine (Agent Runtime, Ambient Intelligence) dayatılacak. CLAUDE.md'nin ADR kriteri (a) ve (b)'sine göre ADR gerekir — architect subagent ile yazılıp insan onayından önce kod yazılmamalı. ADR-0019 Karar (f), bu komutların kendi rıza/yerinde-işleme modeli netleşmeden eklenmemesini bu göreve devretmişti; bu spec o netleştirmeyi yapıyor.

## Amaç

Masaüstü kabuktan (Tauri, `apps/desktop`) iki sinyal sınıfını — **takvim durumu** ve **aktif pencere başlığı** — kullanıcının **açık rızası** ile toplayıp, ham hassas veriyi buluta göndermeden (**yerinde işleme**), F2-T1'in ürettiği bağlam grafiğine akıtan bir mimari kurmak. Bu, Context Fabric'in "sistemin kendi event log'unun ötesinde, kullanıcının gerçek zamanlı bağlamını da yakalama" hedefinin ilk somut örneğidir.

## Mevcut Durum

- **`apps/desktop` iskeleti (F2-T2b sonrası, doğrulandı):** `src-tauri/capabilities/default.json` yalnızca `{"permissions": ["core:default"]}` içeriyor — sıfır OS-sinyal izni. `src-tauri/src/lib.rs`'deki `invoke_handler(tauri::generate_handler![])` boş; kod yorumu ADR-0019 Karar (f)'ye referans veriyor ve `get_active_window`'u gelecekteki bir F2-T3 komutu olarak adlandırıyor. `Cargo.toml`'da hiçbir OS-API plugin/crate'i yok.
- **Test altyapısı hazır, OS-mock deseni yok:** `@tauri-apps/api/mocks` (`mockIPC`, `clearMocks`) kurulu, vitest ile uyumlu — frontend-taraflı `invoke()` çağrıları OS'suz test edilebilir. Rust-taraflı OS-mock (aktif pencere API'sini test ortamında sahtelemek) deseni repoda yok, ilk kez bu görevde tasarlanacak.
- **Rıza (consent) mekanizması yok:** `apps/server/src/db/schema/index.ts`'de `consents` tablosu yok; `apps/desktop/src/`'de onboarding/izin ekranı yok (yalnızca iskelet App.tsx var). F2-E2'nin (Memory Passport, F2-T8) "Memory Passport" kavramı farklıdır — o zaten toplanmış belleğe ajan erişimini kapsıyor, veri toplamaya kullanıcı izni değil. Bu görev kendi rıza mekanizmasını sıfırdan tasarlamak zorunda.
- **Hassas-veri sınıflandırıcısı placeholder:** `docs/adr/ADR-000X-hibrit-ai.md` henüz yazılmadı (F3-T12'ye ertelendi). Bu görev, F3-T12'yi beklemeden, kendi dar kapsamı (yalnızca kendi topladığı iki sinyal sınıfı) için bağımsız bir kural koymak zorunda.
- **Takvim durumu için mevcut sunucu altyapısı yeterli:** `GET /workspaces/:workspaceId/calendar/events` endpoint'i zaten var (`apps/server/src/calendar/calendar-events.controller.ts`), `SessionAuthGuard` + `WorkspaceMembershipGuard` korumalı, `CalendarEventsService.listCachedEvents(workspaceId, range)` üzerinden ADR-0012 §a'nın salt-okunur dış-veri cache'i olan `calendar_events_cache`'i okuyor. Bu görev yeni bir sunucu-taraflı takvim entegrasyonu icat etmez — masaüstü uygulaması bu endpoint'i kimlik doğrulamalı bir HTTP istemcisiyle çağırır.
- **Sinyal → bağlam grafiği yazma yolunda hiç emsal yok:** `apps/server/src/context/context-graph-sync.worker.ts` yalnızca var olan event log'u `catchUp` ile okuyup projeksiyona uyguluyor, yeni olay üretmiyor. Repoda "dış/masaüstü istemci → yeni domain event → event store" desenine dair hiçbir emsal yok; bugüne kadarki tüm domain event'ler sunucu-içi komut handler'larından üretiliyor. Bu görev bu deseni ilk kez tasarlamalı.

## Kapsam

1. **Rıza (consent) mekanizması (ADR'de sabitlenir, bkz. Açık Soru 1):** sinyal-tipi bazında (takvim ayrı, pencere başlığı ayrı) açık kullanıcı onayı; onay verilmeden hiçbir toplama başlamaz. Onay durumu görünür ve geri alınabilir olmalı (aç/kapat).
2. **Yeni Tauri komutları:**
   - Aktif pencere başlığı için yeni bir `#[tauri::command]` (ör. `get_active_window`, ADR-0019 yorumundaki adlandırmayla tutarlı) + Windows-spesifik native API çağrısı yapan yeni bir Rust crate (bkz. Açık Soru 3).
   - Takvim durumu için Rust tarafında yeni bir komuta gerek yok — frontend doğrudan mevcut `GET /workspaces/:workspaceId/calendar/events`'i HTTP ile çağırabilir; yalnızca kimlik doğrulama/oturum yönetimi masaüstü tarafında çözülmeli.
   - Her yeni komut, `capabilities/`'e en az ayrıcalık ilkesiyle, isimlendirilmiş bir izin olarak eklenir (bkz. Açık Soru 5) — `default.json`'a mevcut `core:default`'un yanına serbestçe eklenmez.
3. **Yerinde işleme sınırı (ADR'de sabitlenir, bkz. Açık Soru 4):** ham pencere başlığı/takvim verisinin hangi kısmı hiç sunucuya gitmiyor, hangi türetilmiş/özetlenmiş sinyal sunucuya gidiyor — açıkça tanımlanır ve kod bu sınıra göre yazılır.
4. **Sinyal → bağlam grafiği yazma yolu (ADR'de sabitlenir, bkz. Açık Soru 2):** yeni bir domain event tipi (ör. `DesktopSignalCaptured`) + bu event'i kabul eden yeni bir HTTP ingestion endpoint'i (kimlik doğrulamalı, workspace-izole) + F2-T1'in `ContextGraphProjection`'ının bu event'i nasıl işleyeceği (yeni bir düğüm/kenar türü mü, yoksa mevcut `entity-time`/`entity-topic` şemasına mı eşlenecek).
5. **Frontend entegrasyonu:** `apps/desktop/src/`'de rıza ekranı/ayarı + `@tauri-apps/api/core`'un `invoke()`'u ile komut çağrıları; testler `@tauri-apps/api/mocks` ile OS'suz yazılır.
6. **ADR:** `architect` subagent ile bir sonraki numarayla (bu spec taslağı sırasında `docs/adr/ADR-0017-baglam-grafigi.md` ve `docs/adr/ADR-0019-desktop-app-iskeleti.md` en son numaralı ADR'ler; bu görevin ADR'si sıradaki boş numarayı alır) — rıza modeli, yerinde işleme sınırı, sinyal-ingestion sözleşimi, Tauri capability modeli insan onayından önce yazılır.

## Kapsam DIŞI

- **F2-T4** (ilgililik skorlama + zaman aşımıyla sönümleme) — bu görevin ürettiği sinyal-türevi düğüm/kenarları kullanacak ayrı görev, burada yok.
- **F2-E2 / Memory Passport (F2-T5–F2-T8)** — zaten toplanmış belleğin kullanıcıya görünürlüğü/düzenlenmesi ayrı görev; bu görev yalnızca toplama tarafını kapsıyor.
- **ADR-000X (hibrit-AI / hassas-veri sınıflandırıcısı, F3-T12)** — genel, tüm sağlayıcılara uygulanacak hassas-veri sınıflandırma motoru; bu görev yalnızca kendi iki dar sinyal sınıfı için bağımsız bir kural koyar, genel sınıflandırıcıyı icat etmez.
- Takvim/pencere dışında başka sinyal sınıfları (ör. dosya sistemi etkinliği, tarayıcı sekmeleri) — bu görev yalnızca PLAN.md'de adı geçen iki sinyalle sınırlı.
- macOS/Linux için aktif pencere başlığı desteği — Açık Soru 3'e bağlı, v1'de kapsam dışı bırakılabilir (bkz. o soru).
- Genel bir "üçüncü taraf istemciden event ingestion" API'si — bu görev yalnızca kendi dar sinyal tipi için bir ingestion yolu açar, genel bir dış-entegrasyon platformu kurmaz.

## Açık Sorular

1. **[KRİTİK]** Rıza mekanizması nasıl tasarlanacak?
   - **Seçenek A (öneri):** Sunucu-taraflı `consents` tablosu (workspace + user + sinyal-tipi bazında, `granted_at`/`revoked_at` ile), F1-T18'in RBAC/kapsam desenine (ADR-0016) benzer şekilde denetlenebilir ve çoklu-cihaz senkron. Yeni bir migration + şema gerektirir.
   - **Seçenek B:** Yalnızca masaüstü-yerel bir ayar (Tauri'nin yerel depolaması, sunucuya hiç gitmez). Daha basit ama denetlenemez, kullanıcı cihaz değiştirdiğinde sıfırlanır, ve "rıza verildi" durumu event log'a (tek doğruluk kaynağı) hiç yansımaz — CLAUDE.md'nin event-sourcing değişmeziyle gerilim yaratır.
   - Seçenek A öneriliyor: rızanın kendisi de bir olay olarak modellenmeli (ör. `DesktopSignalConsentGranted`/`Revoked`), event log tek doğruluk kaynağı ilkesiyle tutarlı kalır ve F2-T1'in projeksiyon çatısı üzerinden okunabilir hale gelir. Granülerlik: sinyal-tipi bazında ayrı rıza (takvim ≠ pencere başlığı) — insan onayı gerekiyor.
2. **[KRİTİK]** Sinyal → bağlam grafiği yazma yolu: yeni bir `DesktopSignalCaptured` domain event'i + yeni bir HTTP ingestion endpoint'i mi, yoksa başka bir mekanizma (ör. WebSocket akışı, ayrı bir "signals" tablosu + polling) mi?
   - **Seçenek A (öneri):** `POST /workspaces/:workspaceId/context/desktop-signals` gibi kimlik doğrulamalı bir endpoint, gövdede türetilmiş/özetlenmiş sinyali taşıyan bir `DesktopSignalCaptured` event'i üretir, event store'a yazar; `ContextGraphProjection` bunu `handles[]`'ine ekleyip mevcut `entity-time` şemasına (zaman düğümü) ve yeni bir `person-topic`/`entity-topic` türü kenara eşler. Bu, ADR-0017'nin event-sourcing zorunluluğuyla ("tek doğruluk kaynağı olay günlüğü") doğrudan uyumludur ve F0-T6'nın var olan `Projection` çatısını yeniden kullanır.
   - **Seçenek B:** Ayrı, event-log dışı bir "signals" tablosuna doğrudan yazma + context grafiğine ayrı bir arka-plan job'uyla senkron. Daha az kod ama event-sourcing değişmezini deler, F2-T1'in kurduğu tek-okuma-modeli ilkesiyle çelişir.
   - Seçenek A öneriliyor; insan onayı ve F2-T1 ekibiyle (ADR-0017 yazarıyla) uyum teyidi gerekiyor.
3. Aktif pencere başlığı için hangi Rust crate/yaklaşım kullanılacak?
   - **Seçenek A (öneri, dar kapsam):** Yalnızca Windows-spesifik native API (ör. `windows` crate ile `GetForegroundWindow`/`GetWindowTextW`) — F2-T2b'nin CI'sı zaten yalnızca Windows-only olduğundan platform kapsamı bununla sınırlı tutulabilir, cross-platform soyutlama Faz 3'e ertelenir.
   - **Seçenek B:** Baştan cross-platform bir soyutlama (ör. `active-win` benzeri bir crate) — macOS/Linux desteğini şimdiden açar ama ek bağımlılık yüzeyi ve test karmaşıklığı getirir.
   - İnsan onayı gerekiyor; CI'nın platform kapsamına bağlı bir karar.
4. Yerinde işleme sınırı nerede çizilecek — ham pencere başlığı/takvim verisi hiç sunucuya gitmiyor mu (yalnızca türetilmiş/özetlenmiş bir sinyal mi gidiyor), yoksa ham veri gidip sunucu tarafında mı filtreleniyor?
   - CLAUDE.md'nin "hassas veri sınıfları buluta ham gönderilmez" değişmezi gereği, ham veri sunucuya gitmemeli; türetme (ör. pencere başlığından uygulama adı + kaba kategori çıkarma) masaüstü tarafında (Rust veya frontend) yapılıp yalnızca türetilmiş sinyal `DesktopSignalCaptured` event'ine konmalı. Bu, ADR'de kesin kural olarak yazılmalı ve security-reviewer tarafından denetlenmeli.
5. Tauri capability/izin modeli: yeni komutlar için isimlendirilmiş özel bir permission dosyası mı (Tauri v2'nin custom-permission konvansiyonu), yoksa `capabilities/default.json`'a satır içi mi eklenecek?
   - Bu repoda henüz emsal yok, architect'in ilk kez tasarlaması gerekiyor. Öneri: her sinyal komutu için ayrı, isimlendirilmiş bir permission dosyası (ör. `capabilities/desktop-signals.json`) — en az ayrıcalık ilkesini görünür kılar ve gelecekteki komutların `default.json`'u şişirmesini önler; insan onayı gerekiyor.

## Kabul Kriterleri

- [ ] Rıza akışı olmadan hiçbir sinyal toplanmadığı testli (rıza reddedilmiş/verilmemiş durumda `invoke()` çağrısının hiç tetiklenmediği veya sunucunun ingestion isteğini reddettiği).
- [ ] Ham hassas veri (ham pencere başlığı, ham takvim olay detayı) sunucuya hiç gitmediği — yalnızca ADR'de tanımlanan türetilmiş/özetlenmiş sinyalin gönderildiği testli/denetlenmiş.
- [ ] Yeni Tauri komutları en az ayrıcalık ilkesiyle (isimlendirilmiş, dar kapsamlı capability) eklendiği security-reviewer tarafından denetlendi.
- [ ] F2-T1'in ürettiği bağlam grafiğine sinyallerin `DesktopSignalCaptured` (veya ADR'de kararlaştırılan eşdeğeri) üzerinden nasıl aktığı, `ContextGraphProjection`'ın bunu işlediği testli.
- [ ] Rıza durumu (verildi/geri alındı) event log'a yansıyan bir olay olarak modellendiği ve F0-T6'nın `Projection` çatısı üzerinden okunabildiği testli (Açık Soru 1, Seçenek A onaylanırsa).
- [ ] Takvim durumu, mevcut `GET /workspaces/:workspaceId/calendar/events` endpoint'i üzerinden okunuyor — yeni bir sunucu-taraflı takvim entegrasyonu eklenmediği kod incelemesiyle teyit edildi.
- [ ] `rebuild` komutu, sinyal-türevi düğüm/kenarlar dahil, sıfırdan aynı grafiği ürettiği testli (F0-T6 determinizm kabul kriteriyle tutarlı).
- [ ] ADR yazıldı ve insan tarafından onaylandı (rıza modeli, sinyal-ingestion sözleşimi, yerinde işleme sınırı, Tauri capability modeli kararları dahil).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.
