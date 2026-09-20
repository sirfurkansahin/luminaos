# F4-T1 — Public Beta Foundation

**Epic:** F4-E1 (Public beta and release readiness)

**Status:** Approved — in progress

**Decision date:** 19 September 2026

## Goal

Prepare LuminaOS for an invite-only web beta without widening the existing
product surface. The beta proves that small knowledge-work teams can manage
tasks, documents, calendar context, and search reliably in a shared workspace.

## Product decision

The first external release is web-first. Mobile is included in two steps:

1. responsive web and PWA support are beta requirements;
2. native iOS/Android is a follow-up beta track after the web MVP metrics are
   validated.

The desktop shell remains internal/limited beta until packaging, signing, and
update policy are complete.

## Beta scope

### Included

- authenticated workspace and member access;
- task create/edit/complete in list, table, and board views;
- documents linked to work items;
- calendar view and basic time blocks;
- workspace-scoped search;
- manual AI assistance with usage limits and clear error states;
- user data export and support-assisted deletion flow;
- responsive mobile web experience for the critical flows.

### Explicitly excluded or feature-flagged

- autonomous agent actions;
- federation;
- automatic meeting/notetaker participation;
- broad third-party connector availability;
- native mobile store release;
- public self-service signup and billing.

## Approved infrastructure direction

The beta must not require paid managed infrastructure or provider-specific data
services. Use Cloudflare Pages Free for the web client and an Oracle Cloud
Always Free ARM VM for the API, PostgreSQL, and Redis. These services run as
standard Docker containers; database dumps and runtime configuration remain
portable to another provider.

## Work packages

| Order | Package               | Outcome                                                              | Dependency                             |
| ----- | --------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| 1     | Release baseline      | Canonical docs, environment inventory, ownership, and go/no-go gates | Product owner                          |
| 2     | Production foundation | Staging/prod deployment, secrets, backups, monitoring, rollback      | Approved Oracle + Cloudflare direction |
| 3     | MVP hardening         | Critical E2E, mobile-responsive UX, accessibility, error recovery    | Staging                                |
| 4     | Closed beta           | Invited teams, feedback, telemetry, support process                  | Legal texts and consent                |
| 5     | Release candidate     | Load/security testing and launch rehearsal                           | Beta evidence                          |

## Acceptance criteria for this task

- [ ] The beta scope and feature-flag boundary are documented and agreed.
- [ ] The authoritative release-readiness checklist identifies owners and exit
      criteria for platform, security, product, and support.
- [ ] The production environment variable inventory is documented without
      committing secret values.
- [ ] Local developer commands documented in the repository exist and work.
- [ ] The next task is a production-foundation implementation spec; it must
      not broaden the MVP feature scope.

## Non-goals

- Selecting a cloud provider or signing third-party contracts without an owner
  decision.
- Enabling an external connector, autonomous agent action, or public account
  registration.
- Publishing a desktop or native mobile app.

## Evidence required before completion

- Documentation review by product and platform owners.
- A clean typecheck/lint check after any configuration changes.
- A release-readiness checklist linked from the repository entry point.

## Next step

Proceed with `docs/specs/F4-E1/F4-T2-production-foundation.md`. Cloudflare
Pages Free and an Oracle Cloud Always Free ARM VM are approved; select the
exact Oracle home region only when capacity is confirmed. Object storage is
deferred until the beta enables file uploads. Error tracking and an incident
owner remain required before invitations are sent.
