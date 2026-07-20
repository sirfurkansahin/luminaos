# LuminaOS

Bağlam-öncelikli, ajan-destekli Work OS. Monorepo: pnpm workspaces + Turborepo.

## Gereksinimler
- Node 24.x (bkz. `.nvmrc`)
- Corepack (Node ile birlikte gelir)

## Kurulum
```bash
corepack enable
pnpm install
```

## Komutlar
- `pnpm build` — tüm paketleri derler (`turbo run build`)
- `pnpm test` — tüm paketlerde Vitest koşar
- `pnpm typecheck` — `tsc --noEmit`, tüm paketlerde
- `pnpm lint` — yer tutucu (gerçek ESLint kuralları F0-T2'de gelecek)
- `pnpm dev` — `apps/server` ve `apps/web`'i eşzamanlı başlatır
- `pnpm --filter @luminaos/core-objects build` — tek paketi derler

## Yapı
- `apps/server` — NestJS API (`/health`)
- `apps/web` — Vite + React istemci
- `packages/*` — saf TypeScript domain paketleri
- `tooling/tsconfig/base.json` — paylaşılan strict tsconfig

Ayrıntılı mimari harita için `docs/PLAN.md` ve `docs/adr/`.
