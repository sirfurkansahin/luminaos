# F0-T1 — Monorepo ve Paket İskeletlerinin Kurulumu

**Epik:** F0-E1 (Monorepo ve araç zinciri) · **Durum:** Yapılacak
**Bağımlılık:** Yok (ilk görev)

## Amaç
LuminaOS'in tüm kodunu barındıracak pnpm + Turborepo tabanlı monorepo'yu sıfırdan kurmak ve PLAN.md Bölüm 2.2'deki dizin yapısını boş ama derlenebilir paketlerle oluşturmak.

## Kapsam (yapılacaklar)
1. Kök dizinde `pnpm` workspace kurulumu (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `tooling/*`).
2. Turborepo kurulumu (`turbo.json`): `build`, `test`, `lint`, `typecheck` boru hatları; doğru önbellekleme.
3. Şu paketlerin iskeletini oluştur (her biri: `package.json`, `tsconfig.json`, `src/index.ts`, 1 örnek birim test):
   - `packages/shared`, `packages/core-objects`, `packages/ui`, `packages/ai-gateway`
4. Şu uygulama iskeletlerini oluştur (yalnız "merhaba dünya" seviyesinde çalışır durumda):
   - `apps/server` (NestJS), `apps/web` (React + Vite)
5. Kök `package.json` script'leri: `build`, `test`, `lint`, `typecheck`, `dev`.
6. `.gitignore`, `.nvmrc` (LTS Node sürümü), `README.md` (kurulum komutları).

## Kapsam DIŞI
- Desktop (Tauri) ve mobile uygulamaları (sonraki görevler).
- Gerçek iş mantığı — yalnız iskelet.
- CI (F0-T3'te), lint kuralları (F0-T2'de).

## Kabul Kriterleri
- [ ] Temiz bir klonda `pnpm install && pnpm build` hatasız tamamlanır.
- [ ] `pnpm test` koşar ve her pakette en az 1 örnek test geçer.
- [ ] `pnpm --filter @luminaos/core-objects build` tek paketi derler.
- [ ] `apps/web` tarayıcıda açılır ve "LuminaOS" başlığını gösterir; `apps/server` `/health` ucundan `{status:"ok"}` döner.
- [ ] Paketler arası import çalışır: `apps/server`, `@luminaos/shared`'dan bir fonksiyon kullanır.

## Notlar
- Paket adlandırma: `@luminaos/<paket>`.
- Node LTS + pnpm sürümünü `packageManager` alanında sabitle.
