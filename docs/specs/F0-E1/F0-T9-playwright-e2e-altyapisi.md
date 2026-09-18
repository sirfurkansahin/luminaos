# F0-T9 — Playwright E2E Altyapısı

**Epik:** F0-E1 · **Durum:** Tamamlandı — [PR #273](https://github.com/sirfurkansahin/luminaos/pull/273)
**Bağımlılık:** F0-T3 (CI boru hattı — Kapsam DIŞI'nda "E2E testleri (Playwright altyapısı Faz 1'de)" olarak zaten not edilmişti)

## Amaç

Repoda henüz hiç Playwright kurulumu (devDependency, config, CI job) yok. Gerçek bir tarayıcıda uçtan uca doğrulama gerektiren senaryolar (özellikle pointer-tabanlı sürükle-bırak gibi jsdom/vitest'in gerçekçi şekilde simüle edemediği etkileşimler) şimdilik yalnızca birim seviyesinde (handler'ı doğrudan çağırarak) test ediliyor — bu görev gerçek bir tarayıcıda doğrulama katmanını kurar.

## Tetikleyici Not

F1-T7 PR3'ün (Board/Kanban görünümü, `docs/specs/F1-E2/F1-T7-list-board-table.md`) kabul kriterlerinden biri ("Board görünümünde bir kartı sürükleyip başka sütuna bırakmak, alanın değerini gerçekten değiştirir — entegrasyon/E2E testi") orijinal planda Playwright'a bağlıydı. Bu altyapı henüz kurulu olmadığı için PR3, o kriteri **birim seviyesinde** (dnd-kit'in `onDragEnd`/`onDragCancel` callback'lerini gerçek pointer sürüklemesi simüle etmeden doğrudan tetikleyerek + klavye a11y'yi `@testing-library/user-event` ile) karşıladı. Bu görev tamamlandığında, gerçek pointer-tabanlı sürükle-bırakı gerçek bir tarayıcıda kanıtlayan bir Playwright testi F1-T7'nin Board görünümüne eklenmeli ve F1-T7'nin ilgili kabul kriteri buna göre güncellenmeli.

## Kapsam (taslak — göreve başlarken netleştirilecek)

1. `@playwright/test` devDependency + `playwright.config.ts` (muhtemelen `apps/web` altında veya kök seviyede ayrı bir `e2e/` paketi — karar implementer/architect aşamasında).
2. `webServer` konfigürasyonu: gerçek `apps/web` dev sunucusuna (ve muhtemelen gerçek/test `apps/server`'a) karşı çalıştırma.
3. `.github/workflows/ci.yml`'e yeni bir `e2e` job'u (F0-T3'ün mevcut `quality`/`security`/`pr-size-guard` job'larına ek).
4. İlk gerçek E2E senaryosu: F1-T7 Board görünümünde bir kartı gerçek pointer olaylarıyla sürükleyip bırakmak.

## Kapsam DIŞI

- Görsel regresyon testleri (screenshot diffing) — ayrı bir görev.
- Çapraz tarayıcı matrisi (Firefox/WebKit) — v0'da yalnızca Chromium yeterli.

## Kabul Kriterleri

- [x] `pnpm --filter @luminaos/e2e run test:e2e` yerelde ve CI'da çalışır — yeni `apps/e2e` paketi (`playwright.config.ts`, Chromium-only), `turbo.json`'a `test:e2e` task'ı.
- [x] F1-T7 Board görünümünün sürükle-bırak senaryosu gerçek bir tarayıcıda (Chromium) uçtan uca doğrulanır — `apps/e2e/tests/board-drag-drop.spec.ts`: gerçek kullanıcı/workspace/oturum API'ye doğrudan istekle kurulur, kart gerçek `mouse.down/move/up` pointer olaylarıyla sürüklenir, `status` alanının API üzerinde gerçekten değiştiği `expect.poll` ile doğrulanır.
- [x] CI'a eklenen `e2e` job'u kırmızıyken `gh pr merge` engellenir — `ci.yml`'e Postgres+Redis servis konteynerli `e2e` job'u eklendi; PR #273 bu job dahil tüm check'ler yeşil olduktan sonra merge edildi (mevcut disiplinle aynı: CI kırmızıyken hiçbir zaman merge edilmedi). Bu check'i GitHub'ın branch-protection "required status checks" listesine eklemek bir repo-admin ayarı — CLAUDE.md kapsamında ajanın yapacağı bir iş değil, insan gerekirse GitHub ayarlarından ekler.

## Done

**PR:** [#273 - feat: F0-T9 - Playwright E2E altyapisi](https://github.com/sirfurkansahin/luminaos/pull/273) (squash-merged, tüm CI check'leri yeşil: `ai-eval`, `desktop-build`, `e2e`, `integration`, `pr-size-guard`, `quality`, `security`).

Bu görev, adı üstünde, uygulamayı **ilk kez gerçek bir tarayıcıda** çalıştırdı — daha önce hiçbir CI job'u veya test koşucusu `apps/web`'i gerçek bir Node/Vite/Chromium yığınında uçtan uca ayağa kaldırmamıştı (`quality`/`integration` job'ları vitest + jsdom + mock fetch üzerinden koşuyor). Bu ilk gerçek çalıştırma, testin kendisi kadar önemli iki gerçek, önceden bilinmeyen prod hatasını ortaya çıkardı:

1. **`node:crypto` tarayıcı paketine sızıyordu.** `packages/shared/src/index.ts`'in düz barrel export'u iki `node:crypto`-bağımlı dosyayı (`ids/deterministic-uuid.ts`, `secrets/token-encryption.ts`) re-export ediyordu. Vite'ın dev sunucusu (production build'in aksine) bir barrel'dan herhangi bir named import'ta TÜM modül grafiğini değerlendiriyor — `apps/web/src/lib/apiClient.ts`'in `AppError` value-import'u bu yüzden bu iki Node-only dosyayı da tarayıcı paketine çekiyor, uygulamayı yüklenirken çökertiyordu (`Module "node:crypto" has been externalized for browser compatibility`). **Çözüm:** `packages/shared` tarayıcı-güvenli `.` export'u (errors/events/query) ve yeni Node-only `./server` alt-yolu (ids/secrets) olarak ikiye bölündü; `apps/server/src`'deki 9 `deriveDeterministicUuid` + 9 `encryptSecret`/`decryptSecret`/`DecryptionError` çağıran dosyanın (toplam ~18 dosya) import yolu güncellendi, mantık değişmedi.
2. **`apps/web`'in Vite dev sunucusunda hiç proxy yoktu.** `apiClient.ts`'nin bütün istekleri göreli URL (`/workspaces/...`); proxy olmadan bunlar tarayıcıda dev sunucusunun kendisine (5173) gidiyordu, `apps/server`'a (3000) hiç ulaşmıyordu — yani web istemcisi gerçek sunucuyla hiç konuşamıyordu, bu güne kadar fark edilmemişti çünkü hiçbir test bunu gerçek bir tarayıcıda denemedi. **Çözüm:** `vite.config.ts`'e dar kapsamlı bir `server.proxy['/workspaces'] -> localhost:3000` eklendi.
3. **CI'ın `e2e` job'u ilk halinde de kırmızı çıktı** (ayrı bir bulgu, aynı kök neden sınıfı): `apps/web`/`apps/server`'ın webServer'ları gerçek Node ESM çözümlemesi kullanıyor, bu da her workspace bağımlılığının (`@luminaos/shared`, `@luminaos/ui`, vb.) `dist/`'inin gerçekten var olmasını gerektiriyor -- CI'da bunu hiçbir job önceden derlemiyordu. `ci.yml`'e `pnpm build` adımı eklendi.
4. **dnd-kit + Playwright sürükle-bırak zamanlaması:** dnd-kit'in varsayılan `autoScroll` özelliği, sayfa Board'dan önce onlarca ilgisiz panel içerdiği için (bkz. Kapsam DIŞI notları — gerçek bir router/sayfalama henüz yok), pointer viewport kenarına yakın sabit tutulduğunda pencereyi kaydırıyor ve sürüklenen kartı hedeften uzağa düşürüyordu. Test dosyasına 2400px'lik bir viewport (`test.use({ viewport: ... })`) eklenerek her iki sütun da kenarlardan güvenli mesafede tutuldu.

security-reviewer bulgusu: yok (E2E fixture'ının oturum-çerezi enjeksiyonu tamamen `apps/e2e`'ye özel test kodu, prod'a hiç sızmıyor; `DEV_WORKSPACE_ID` query param'ı yalnızca istemci tarafı bir "hangi workspace'i sorayım" değeri — sunucu her istekte `WorkspaceMembershipGuard` ile bağımsız olarak yetkilendiriyor).

`docs/PLAN.md`'nin tanımladığı Faz 0-3'ün tamamı (F0-E1 dahil) artık tamamlanmış durumda.
