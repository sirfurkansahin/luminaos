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

## Yerel Ortam (Veritabanı + Auth)

`apps/server`, PostgreSQL 16 + Redis'e ihtiyaç duyar. Sıfırdan ayağa kaldırmak için:

```bash
docker compose up -d
cp apps/server/.env.example apps/server/.env
pnpm db:migrate
pnpm dev
```

- `docker compose up -d` — Postgres (`localhost:5432`, kullanıcı/şifre/db: `lumina`/`lumina`/`lumina_dev`) ve Redis (`localhost:6379`) konteynerlerini başlatır.
- `pnpm db:generate` — Drizzle şemasından yeni bir migration üretir.
- `pnpm db:migrate` — bekleyen migration'ları uygular.
- `pnpm db:migrate:down` — en son uygulanan migration'ı geri alır (her migration'ın bir `down` script'i olmak zorundadır).
- `docker compose down -v` — konteynerleri ve verileri temizler.

## Komutlar

- `pnpm build` — tüm paketleri derler (`turbo run build`)
- `pnpm test` — tüm paketlerde Vitest koşar
- `pnpm test:integration` — Testcontainers ile gerçek Postgres üzerinde entegrasyon testleri (Docker gerektirir)
- `pnpm typecheck` — `tsc --noEmit`, tüm paketlerde
- `pnpm lint` — ESLint (strict TypeScript kuralları)
- `pnpm dev` — `apps/server` ve `apps/web`'i eşzamanlı başlatır
- `pnpm --filter @luminaos/core-objects build` — tek paketi derler

## Yapı

- `apps/server` — NestJS API (`/health`)
- `apps/web` — Vite + React istemci
- `packages/*` — saf TypeScript domain paketleri
- `tooling/tsconfig/base.json` — paylaşılan strict tsconfig

Ayrıntılı mimari harita için `docs/PLAN.md` ve `docs/adr/`.
