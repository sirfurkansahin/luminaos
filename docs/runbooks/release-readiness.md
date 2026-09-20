# LuminaOS release readiness

This is the authoritative operational checklist for the invite-only web beta.
It complements, but does not replace, feature-level acceptance criteria.

## Release boundary

- Web is the beta delivery surface.
- Responsive mobile web and PWA installation are in scope.
- Native iOS/Android and the Tauri desktop installer are not launch blockers.
- Agents, federation, automatic notetaking, and nonessential connectors remain
  disabled by feature flag until separately approved.

## Required owner decisions

| Decision                                             | Owner               | Required before       |
| ---------------------------------------------------- | ------------------- | --------------------- |
| Cloud provider, primary region, and data residency   | Product + platform  | Production foundation |
| Managed PostgreSQL, Redis, and object storage        | Platform            | Production foundation |
| Secret manager and key-rotation policy               | Platform + security | First staging deploy  |
| Error tracking, uptime monitor, and incident channel | Platform            | Closed beta           |
| Privacy policy, terms, DPA, and deletion process     | Legal + product     | User invitation       |
| Beta cohort and support response owner               | Product + support   | Closed beta           |

## Environment inventory

Never put the values below in source control. Store production values in the
selected secret manager and grant each runtime only the secrets it needs.

| Group       | Required configuration                                                                        |
| ----------- | --------------------------------------------------------------------------------------------- |
| Runtime     | `DATABASE_URL`, `REDIS_URL`, `LOG_LEVEL`, `SERVER_PUBLIC_URL`, `WEB_ORIGIN`, `DESKTOP_ORIGIN` |
| Pages proxy | `VITE_API_BASE_URL`, `PUBLIC_WEB_ORIGIN`, `API_ORIGIN`, encrypted `API_PROXY_SECRET`          |
| Encryption  | `ENCRYPTION_KEY` (32-byte base64-decoded AES key)                                             |
| AI          | `ANTHROPIC_API_KEY`, `AI_TOKEN_QUOTA_PER_WORKSPACE`, `AI_COST_BUDGET_USD_PER_WORKSPACE`       |
| OAuth       | Provider client ID/secret pairs for only the connectors enabled in beta                       |
| Webhooks    | `NOTETAKER_WEBHOOK_SECRET` only if that feature is explicitly enabled                         |
| Limits      | document, agent, notification, and search limit variables in `apps/server/src/config/env.ts`  |

## Gates

### Before staging

- [ ] Container build is reproducible from a clean checkout.
- [ ] All migrations have matching down migrations and a restore rehearsal.
- [ ] Secrets are injected at runtime, never baked into images or client code.
- [ ] Health/readiness checks and structured redacted logs are available.

### Before closed beta

- [ ] Critical E2E flows pass: signup/invite, login, task lifecycle, document,
      search, calendar, export, and permission denial.
- [ ] Mobile viewport and keyboard-only acceptance tests pass.
- [ ] Backup and point-in-time recovery are tested against a non-production
      restore environment.
- [ ] Error tracking, uptime alerts, and an incident owner are active.
- [ ] Privacy, AI disclosure, retention, export, and deletion user flows are
      published and tested.

### Before public launch

- [ ] No open P0/P1 security, data-loss, or tenant-isolation finding.
- [ ] Load test meets the agreed p95 latency and error-rate budget.
- [ ] Rollback rehearsal is completed for application and database migration.
- [ ] Support, status communication, and release notes are ready.
- [ ] Product, platform, security, and support owners record go/no-go approval.

## First 30 days

- [ ] Daily review: error rate, login failures, failed jobs, and backup status.
- [ ] Weekly review: activation, weekly active teams, search success, and
      support themes.
- [ ] Weekly beta interviews with at least two active teams.
- [ ] Keep feature flags reversible; do not enable autonomous actions based on
      anecdotal feedback alone.
