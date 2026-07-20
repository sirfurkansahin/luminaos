# F0-T1 — Monorepo ve Paket İskeletlerinin Kurulumu

**Epik:** F0-E1 (Monorepo ve araç zinciri) · **Durum:** Tamamlandı
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
- [x] Temiz bir klonda `pnpm install && pnpm build` hatasız tamamlanır.
- [x] `pnpm test` koşar ve her pakette en az 1 örnek test geçer.
- [x] `pnpm --filter @luminaos/core-objects build` tek paketi derler.
- [x] `apps/web` tarayıcıda açılır ve "LuminaOS" başlığını gösterir; `apps/server` `/health` ucundan `{status:"ok"}` döner.
- [x] Paketler arası import çalışır: `apps/server`, `@luminaos/shared`'dan bir fonksiyon kullanır.

## Notlar
- Paket adlandırma: `@luminaos/<paket>`.
- Node LTS + pnpm sürümünü `packageManager` alanında sabitle.

## Done
- Doğrulama: `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint` kökte hatasız; `pnpm --filter @luminaos/core-objects build` tekil çalışır; derlenmiş `apps/server` `/health` → `{"status":"ok"}` (curl ile doğrulandı); `apps/web` build+preview → `<title>LuminaOS</title>` ve `<h1>LuminaOS</h1>` içeriyor.
- Yerel commit'ler (repo bu görevle `git init` edildi; henüz remote/GitHub yok, bu yüzden PR linki yok):
  - `9757f5e` chore: pnpm + Turborepo workspace iskeleti
  - `dfd6cd0` feat: packages/shared iskeleti + health payload yardımcısı
  - `0fafda9` feat: packages/core-objects iskeleti
  - `ab30dc6` feat: packages/ui iskeleti
  - `f0a2f1d` feat: packages/ai-gateway iskeleti
  - `59d39a2` feat: apps/server NestJS iskeleti
  - `57c6866` feat: apps/web Vite+React iskeleti
- Sapma notu: `.claude/agents/*` (explorer/test-writer/implementer/security-reviewer) henüz kurulu değil (F0-T4'te gelecek); bu görevde TDD adımları ve güvenlik taraması doğrudan ana oturumda uygulandı.
