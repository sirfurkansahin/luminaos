# F0-T9 — Playwright E2E Altyapısı

**Epik:** F0-E1 · **Durum:** Yapılacak
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

## Kabul Kriterleri (taslak)

- [ ] `pnpm --filter <paket> test:e2e` (veya benzeri) yerelde ve CI'da çalışır.
- [ ] F1-T7 Board görünümünün sürükle-bırak senaryosu gerçek bir tarayıcıda (Chromium) uçtan uca doğrulanır.
- [ ] CI'a eklenen `e2e` job'u kırmızıyken `gh pr merge` engellenir (mevcut kalite kapıları ile aynı disiplin).
