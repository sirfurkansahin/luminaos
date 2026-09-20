# Oracle Cloud Always Free beta deployment

This runbook deploys the portable LuminaOS API stack to an Oracle Cloud Always
Free ARM VM. It intentionally uses Docker Compose, PostgreSQL, and Redis
without an Oracle-specific runtime dependency.

## Preconditions

- An Always Free ARM VM with Ubuntu LTS, public IPv4, and an SSH key.
- A Cloudflare account with a Pages project. A purchased/custom web domain is
  optional when the same-origin `/api` Function adapter is used.
- A publicly reachable hostname with valid HTTPS for the Oracle origin. This
  can be replaced later without changing browser-facing URLs.
- Docker Engine and the Compose plugin installed on the VM.
- At least 20 GB free disk space after the initial image build.

## Initial deployment

To verify a built image without database access, run from PowerShell at the
repository root:

```powershell
Get-Content -Raw deploy/verify-image.mjs | docker run --rm -i --network none luminaos-api:local-check node --input-type=module
```

This checks runtime dependencies and migration packaging, not API/database
connectivity. To run the isolated API/database smoke test, including migration
idempotence, named-volume persistence, and a logical backup restored into a
separate empty PostgreSQL volume, use:

```powershell
.\deploy\smoke.ps1 -Image luminaos-api:arm64-check
```

The script creates a UUID-scoped Compose project, uses generated test-only
credentials, and removes only that project's containers and volumes in its
`finally` block. On an AMD64 workstation, Docker emulates the ARM64 API and can
take several minutes to pass health checks. This is useful architecture
evidence but does not replace a native smoke test on the selected Oracle VM.

1. Clone the repository on the VM and check out the approved release commit.
2. Copy `docker-compose.production.env.example` to `.env.production`.
3. Replace every `replace-with-...` value with a generated secret. Do not use
   the example values in any exposed environment.
4. For a Pages project at `https://lumina.pages.dev`, set
   `SERVER_PUBLIC_URL=https://lumina.pages.dev/api` and
   `WEB_ORIGIN=https://lumina.pages.dev`. The first value is intentionally the
   browser-visible proxy base so OAuth callback URLs also pass through Pages.
5. Build the image, start only the databases, then migrate before starting API workers:

   ```sh
   docker compose --env-file .env.production -f docker-compose.production.yml build api
   docker compose --env-file .env.production -f docker-compose.production.yml up -d --wait postgres redis
   ```

6. Run migrations in a one-off container and start the API only on success:

   ```sh
   docker compose --env-file .env.production -f docker-compose.production.yml run --rm --no-deps api node dist/db/migrate.js && \
   docker compose --env-file .env.production -f docker-compose.production.yml up -d --no-deps --wait api
   ```

7. Install Caddy on the host using `deploy/Caddyfile.example`, with the actual
   origin hostname. Generate at least 32 random base64 characters for
   `API_PROXY_SECRET`, install `deploy/caddy.env.example` as
   `/etc/luminaos/caddy.env` with mode `0600`, and configure the Caddy systemd
   service to load that `EnvironmentFile`. Use the identical value as the
   encrypted Cloudflare Pages secret. Allow inbound 80/443 in the VM and cloud
   firewall; keep 3000, 5432 and 6379 closed. Caddy proxies WebSocket upgrades
   as well as HTTP and rejects traffic without the private proxy header.

   Load the protected environment file through a systemd override:

   ```ini
   # sudo systemctl edit caddy
   [Service]
   EnvironmentFile=/etc/luminaos/caddy.env
   ```

   Then run `sudo systemctl daemon-reload`, validate with
   `sudo caddy validate --config /etc/caddy/Caddyfile`, and restart Caddy.

## Backup and restore

Production backup objects use a 30-day deletion lifecycle. This limit must be
configured and verified on the exact OCI bucket before user invitations; local
temporary dump files are removed by the backup script after upload.

Create a daily encrypted `pg_dump` outside the repository and copy it to a
separate storage account before inviting users. Test restore in a separate VM.

```sh
docker compose --env-file .env.production -f docker-compose.production.yml exec -T postgres \
  sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > lumina-$(date +%F).dump
```

Before any migration, create and verify a fresh backup. A restore rehearsal is
a beta gate, not an optional operation.

Use a restrictive shell umask (`umask 077`) before creating dumps. The command
above creates an unencrypted local dump: encryption and an independent backup
destination must be configured before real user data is stored.

Validate the dump archive with `pg_restore --list`. To rehearse a restore,
use an isolated Compose project and an empty database, never the live volume:

```sh
docker compose -p lumina-restore --env-file .env.production -f docker-compose.production.yml up -d --wait postgres
docker compose -p lumina-restore --env-file .env.production -f docker-compose.production.yml exec -T postgres \
  sh -c 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < lumina-YYYY-MM-DD.dump
```

Verify representative row counts and migration journal entries before marking
the rehearsal complete. Do not expose this restore project to public traffic.

## Update and rollback

1. Back up PostgreSQL.
2. Record the current image ID and retain/tag it as the rollback image; pulling
   an old commit alone is not a reproducible rollback of floating base images.
3. Build the approved release, stop the API workers, migrate, and start it using
   the initial-deployment sequence. This single-VM beta has a maintenance window.
4. Verify `/health`, login, and a workspace read/write smoke test.
5. If the release fails, restore the previous Git revision and restart the
   previous image. If a migration changed data, follow its down migration or
   restore the verified backup; never delete the database volume as rollback.

## Cloudflare Pages configuration

Use the repository root as the Pages project root:

| Setting                  | Value                                           |
| ------------------------ | ----------------------------------------------- |
| Build command            | `pnpm --filter @luminaos/web build`             |
| Build output directory   | `apps/web/dist`                                 |
| Build variable           | `VITE_API_BASE_URL=/api`                        |
| Runtime variable         | `PUBLIC_WEB_ORIGIN=https://<project>.pages.dev` |
| Runtime variable         | `API_ORIGIN=https://<oracle-origin-host>`       |
| Encrypted runtime secret | `API_PROXY_SECRET=<same value loaded by Caddy>` |

The Pages Function at `functions/api/[[path]].js` strips `/api`, forwards HTTP
and WebSocket upgrades to the fixed HTTPS `API_ORIGIN`, and overwrites the
origin-authentication header. It also requires the request origin to equal
`PUBLIC_WEB_ORIGIN`, preventing preview deployments from reaching production
data by default. `apps/web/public/_routes.json` ensures only `/api` requests
invoke the Function; static assets do not consume the Workers request quota.
Missing, insecure, credential-bearing, path-bearing, or self-referential
origins fail closed with `503`.

The browser now sees the UI, API, session cookie, and document WebSocket under
one `pages.dev` origin, so the current `SameSite=Lax` cookie remains valid
without weakening its attributes or purchasing a web domain. Preview
deployment hostnames fail closed: use separate preview bindings and a staging
API, or test production authentication only on the canonical Pages hostname.

## Standalone same-origin fallback

Some networks may block the shared `pages.dev` domain. In that case, keep the
same zero-cost Oracle VM and serve the built web assets and API from one HTTPS
hostname using `deploy/Caddyfile.standalone.example`:

1. Build the web client with `VITE_API_BASE_URL=/api` and copy `apps/web/dist`
   to a new directory on the VM, atomically swap it into `/var/www/luminaos`,
   then set directories to mode `755` and files to `644`. This last step is
   required when copying from Windows because transferred asset directories
   can otherwise be owner-only and Caddy will return the SPA fallback for CSS
   and JavaScript paths.
2. Set `WEB_HOST` to the public hostname, `WEB_ROOT=/var/www/luminaos`, and
   `API_UPSTREAM=127.0.0.1:3000` in the root-readable Caddy environment file.
3. Set `SERVER_PUBLIC_URL=https://<hostname>/api` and
   `WEB_ORIGIN=https://<hostname>` in `.env.production`, then recreate only the
   API service.
4. Validate Caddy with its environment file loaded, restart Caddy, and verify
   both `/` and `/api/health` over HTTPS.

The standalone configuration strips `/api` before forwarding to NestJS and
serves the SPA fallback for all other routes. It preserves the portable
PostgreSQL/Redis/Docker topology and can later be replaced by a custom domain
or the Pages proxy without changing application code. Apply
`deploy/oci-web-nsg-rules.json` to a dedicated OCI network security group so
only public HTTP/HTTPS are added; keep ports 3000, 5432, and 6379 private.

No paid AI key is forwarded by this Compose profile. Without a key, existing
application code may return mock responses; do not advertise these as working
AI. Free VM capacity, uptime and quotas are not guaranteed. No cloud resource
has been provisioned by adding these files.

## Provision an invite-only beta user

Production rejects public `POST /auth/register` requests. Create each approved
beta account from an SSH session on the VM, inside the already-running API
container. The password is read silently and piped over standard input; it is
never placed in shell history, the process argument list, application logs, or
source control:

```sh
cd /opt/luminaos
read -r -s -p 'Initial beta password: ' BETA_PASSWORD
printf '\n'
printf '%s' "$BETA_PASSWORD" | sudo docker compose --env-file .env.production -f docker-compose.production.yml exec -T api node dist/auth/provision-beta-user.js --email 'approved-user@example.com'
unset BETA_PASSWORD
```

The command normalizes the email, enforces the same 8–200 character password
contract as registration, hashes with Argon2id, and fails if the account
already exists. Send the initial password to the invited user through a
separate private channel. Do not paste it into tickets, chat logs, or this
runbook. Workspace creation happens in the web UI after the user's first login.
