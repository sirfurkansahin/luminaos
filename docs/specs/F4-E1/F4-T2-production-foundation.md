# F4-T2 — Portable zero-cost production foundation

**Epic:** F4-E1 (Public beta and release readiness)

**Status:** Staging deployed — release gates pending

## Goal

Make the existing NestJS API runnable as a portable production container on an
Oracle Cloud Always Free ARM VM, alongside PostgreSQL and Redis. The web client
will later be delivered by Cloudflare Pages and must be able to target an
absolute API origin.

## Scope

- honor the hosting platform's `PORT` environment variable while preserving
  local port `3000` as the default;
- add a reproducible server container build from the monorepo root;
- add a production Compose topology for the API, PostgreSQL, and Redis;
- keep all runtime secrets out of version control and document required
  production-only configuration;
- prepare the web client for an explicit production API base URL without
  changing its relative-URL local development behavior.
- provide a zero-cost, same-origin Cloudflare Pages Function adapter at
  `/api/*` that forwards HTTP and WebSocket traffic to one fixed HTTPS API
  origin without becoming an open proxy.

## Out of scope

- provisioning or logging into Oracle Cloud;
- selecting the Oracle home region before account capacity is known;
- public DNS, Cloudflare account changes, or secret entry;
- file/object storage, native mobile release, billing, or user invitations.

## Acceptance criteria

- [x] The server honors a valid `PORT` value and rejects an invalid one safely.
- [x] `docker build` produces a runnable API image on Linux ARM64 and AMD64.
- [x] `docker compose config` validates the production topology without a
      secret value in the repository.
- [x] PostgreSQL and Redis are private to the Compose network; only the API
      publishes a loopback-only port for the host TLS proxy.
- [x] API data survives a container recreation through named volumes.
- [x] The web client defaults to relative API URLs but accepts an explicitly
      configured `VITE_API_BASE_URL` for Cloudflare Pages.
- [x] The web client accepts `/api` as a root-relative base path, including the
      document WebSocket URL.
- [x] The Pages Function strips only the `/api` prefix, preserves method,
      headers, body, query, cookies, and WebSocket upgrades, and rejects a
      missing, invalid, or self-referential upstream origin.
- [x] The Function overwrites the private origin-authentication header, and
      Caddy rejects direct requests that do not carry the shared secret.
- [x] The production Function accepts only its configured canonical web
      origin so preview deployments cannot reach production data by default.
- [x] Pages invokes the Function only for `/api/*`; static assets remain
      outside the Workers request quota.
- [x] The deployment runbook includes backup, restore, update, and rollback
      commands for the VM operator.
- [x] Production data has an encrypted, versioned, off-host backup and a
      successful isolated restore rehearsal.
- [x] The VM runs recurring health and backup checks with bounded Docker log
      retention.

## Verification

19–20 September 2026: 76 targeted web tests and 8 port tests passed. Web and
server typechecks and targeted lint passed. Native Linux AMD64 and emulated
Linux ARM64 images both built successfully (10 build tasks each). An isolated,
network-disabled container loaded the migration module, found the SQL journal,
hashed and verified a password with the architecture-specific argon2 binary,
and confirmed a non-root runtime. Production Compose configuration validation
also passed.

The repeatable `deploy/smoke.ps1` test ran every migration twice, started the
API with isolated PostgreSQL and Redis services, and verified health,
registration, login, secure session-cookie attributes, workspace write/read,
and unauthorized denial on AMD64 and ARM64. It then recreated the API,
PostgreSQL, and Redis containers without deleting their named volumes and
confirmed the account and workspace were preserved. The smoke flow also
created a logical `pg_dump`, restored it with `--exit-on-error` into a separate
empty PostgreSQL volume, and verified restored user data. The ARM64 result used
Docker emulation on an AMD64 workstation; a native Oracle VM smoke test and an
encrypted off-host backup rehearsal remain deployment gates. The web API
origin also governs document WebSocket connections. Free same-origin browser
routing without a purchased domain is now implemented through a narrowly
routed Pages Function. Its 14 Node tests cover HTTP bodies/cookies, WebSocket
upgrades, configuration fail-closed behavior, canonical-origin enforcement,
secret-header overwrite, and network-path SSRF prevention. A production-mode
Vite build copied the `/api`-only `_routes.json` into `dist`; 22 related web
tests, web typecheck, and web lint passed. A real Caddy container returned `403`
without the shared header and proxied the same request with `200` when the
correct secret was present. Wrangler 4.135.0 compiled the Pages Function
successfully with the 20 September 2026 compatibility date. A publicly
reachable TLS hostname for the Oracle origin and the real Cloudflare/Oracle
deployment remain external staging gates.

On 20 September 2026 the stack was deployed natively to an Oracle Always Free
ARM VM in `eu-frankfurt-1` with 4 OCPU, 24 GB RAM, and a 50 GB boot volume.
PostgreSQL, Redis, migrations, API health, private container ports, OCI network
rules, and public TLS were verified. Cloudflare Pages deployment succeeded,
but `pages.dev` returned `ERR_CONNECTION_RESET` from the target network.
The documented standalone same-origin Caddy fallback was therefore activated;
the web UI and `/api/health` both returned 200 over HTTPS and the UI rendered in
a real browser. A private, versioned OCI Object Storage bucket now receives a
daily AES-256 encrypted database dump through instance-principal credentials.
The first object (`daily/luminaos-20260920T073746Z.dump.gpg`) was restored into
an isolated PostgreSQL volume and all 48 migration rows were verified. The
recovery key is stored outside the repository. Five-minute health checks,
daily backup timers, and 10 MB × 5-file Docker log rotation are active. A
production dependency audit reports no known vulnerabilities after pinning
patched `fast-uri`, `multer`, TipTap, `hono`, and `qs` releases. External alert
delivery and the final release-readiness gates remain open.

- Unit tests for port and API-base resolution.
- `pnpm typecheck`, relevant unit tests, and `docker compose -f
docker-compose.production.yml config`.
- The native VM smoke test repeats `deploy/smoke.ps1` and verifies public TLS
  routing after the operator has an Oracle account.
