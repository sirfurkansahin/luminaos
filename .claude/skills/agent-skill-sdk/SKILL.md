---
name: agent-skill-sdk
description: Run when adding a new first-party skill to the Skill SDK (packages/skill-sdk + apps/server/src/skills/, ADR-0036) -- an agent-callable, signed, permission-gated wrapper around an existing, already-tested service method. Covers id naming, the single-.loose()-schema input pattern, the decide()/governance-write exclusion boundary, module wiring, the smoke-test catalog update, and required test coverage together, since these always move as one unit.
---

Use this skill when a task asks to add a **new agent-callable skill** to LuminaOS's Skill SDK (`packages/skill-sdk` core + `apps/server/src/skills/` bindings, ADR-0036, F3-T2 — fully implemented and merged as of this writing, 20 first-party skills registered). This is NOT for changing `packages/skill-sdk`'s own core primitives (`SkillManifest`, `SkillRegistry`, `canonicalizeManifestForSigning`, signing) — only for wrapping an existing, already-tested service method as one more callable skill in the catalog.

## When to trigger

- The task says "add a new skill" / "make `<service>.<method>` callable by agents" / references `SkillRegistry`, `SkillExecutionService`, or the 20-skill catalog in `docs/specs/F3-E1/F3-T2-skill-sdk-v1.md`.
- Not for adding an HTTP controller route for the same functionality — skills have no HTTP surface of their own (F3-T3's @mention/task-assignment flow is the intended future caller of `SkillExecutionService`, not a route added here).

## Steps

1. **Pick the skill id / actionType.** Kebab-case, verb-first, mirrors the wrapped method (`create-object` → `ObjectsService.create`, `get-meeting-details` → `MeetingsService.getMeetingDetails`). This id is used unchanged as the `AgentPermissionManifestsService.checkPermission` `actionType` — it is the thing a human grants/revokes in a manifest, so make it specific enough to grant narrowly (don't reuse an existing id for a different action).

2. **Write the build function** in the domain-appropriate `apps/server/src/skills/*-skills.ts` file (`object-skills.ts`, `meeting-recurrence-skills.ts`, `context-search-calendar-skills.ts`, `ai-command-skills.ts`, or a new file for a genuinely new domain). Pattern to follow — `buildXxxSkill(service): Skill<unknown, unknown>`:
   - `manifest: signManifest(id, capability)` — reuse the file's own module-scope `signManifest`/Ed25519 keypair helper (each `*-skills.ts` file currently generates its own keypair at module load time and exports its own `..._SKILLS_SIGNING_PUBLIC_KEY_PEM`; see "Known temporary gap" below before assuming this is the final key-management story).
   - `execute: async (input: unknown) => { ... }` — validate `input` with **one single `.loose()` zod schema** covering `workspaceId`, `agentIdentifier`, and every one of the skill's own body fields together, in one `parseSkillInput(schema, input)` call. This is the pattern `ai-command-skills.ts` (the last file written) settled on after `object-skills.ts` got the alternative wrong 8 times across 3 PRs: **do not** split into a context parse + a separate `.strict()` body-schema parse (even via `stripAuthoritativeContext`-stripping the injected `workspaceId`/`agentIdentifier` first) unless you are deliberately reusing an existing `.strict()` HTTP-facing DTO schema verbatim (older files do this and it works, but it is the more error-prone of the two patterns — prefer the single unified schema for new skills).
   - `execute` receives `input` with `workspaceId`/`agentIdentifier` **already injected and authoritative** — `SkillExecutionService.executeSkill` overwrites whatever a caller put there right before calling `execute` (see that file's own doc comment). Never trust a `workspaceId` a caller could have supplied through some other channel; there isn't one, and it must stay that way.
   - Actor convention: `{ type: 'agent', id: agentIdentifier }`; `CALLER_ROLE` is a fixed technical role (usually `'member'`, `'admin'` only where the wrapped service hard-rejects lower roles, e.g. `TriggerSuggestionsService.runAnalysis`) that satisfies the wrapped service's own RBAC parameter — it is **not** the real authorization boundary. The real authorization is the agent permission manifest, already checked by `executeSkill` before `execute` ever runs.
   - If the skill acts on an _existing_ object whose type the permission check needs to narrow on (`dataScope.objectTypes`), it is **objectId-based**: reuse `callObjectIdBasedSkill` (`object-skills.ts`) if the field is literally named `objectId`, or write a one-off sibling helper (see `callGenerateNextRecurrenceSkill` in `meeting-recurrence-skills.ts`) if it's named something else (e.g. `sourceObjectId`). This pre-fetches the object, resolves its real type, and passes that type through to `executeSkill` — never trust a type the caller merely asserts in `input`.

3. **Preserve the security boundary — do not add skills for `decide()`-style human-approval endpoints or workspace-governance writes.** Per ADR-0036 Decision (e) and the spec's "Kritik Güvenlik-Sınırı Bulgusu", the following are **permanently out of scope for skill-wrapping**, regardless of what permission manifest an agent holds:
   - `CommandsService.decide`, `TriggerSuggestionsService.decide` (human-approval checkpoints of the propose→approve chain).
   - `AutomationTriggersService.create/update/delete`, `WebhookSubscriptionsService.create/update/remove`, `McpClientGrantsService.grant/revoke` (workspace-governance writes with persistent, systemic effects beyond a single call).

   Only wrap: (a) direct reads/writes already within an agent's own permission-manifest `dataScope` (the same class of thing a `member`-role human could already do), and (b) propose-only AI flows that emit a `*Proposed`/`*Suggested` event and still require a human `decide()` before any real mutation. If a request asks you to wrap one of the excluded endpoints, refuse and flag it — this is a deliberate, ADR-documented boundary, not an oversight to "helpfully" close.

4. **Wire the new skill into `skills.module.ts`.** Add the `build...Skill` import from your `*-skills.ts` file, add the wrapped service to the factory's `inject`/parameter list if it isn't already there (widen the service's own module export if needed — the factory injects concrete service classes, not just their module), and call `registry.register(buildYourSkill(yourService), YOUR_FILE_SIGNING_PUBLIC_KEY_PEM)` using the **signing key constant from the same `*-skills.ts` file the build function lives in** (each file's manifests are signed with that file's own keypair — mixing keys across files fails signature verification at registration time with a `ValidationError`, fail-closed by design).

5. **Update the end-to-end smoke test.** Add the new skill id to `EXPECTED_SKILL_IDS` in `skills-registry-smoke.integration.test.ts` (keep it sorted the same way the existing list reads, alphabetical-ish by domain grouping is fine — the test itself sorts before comparing). If the skill wraps something adjacent to the excluded-endpoint list, double check it does **not** also need adding to `EXCLUDED_ACTION_IDS` in the same file — that list exists specifically to catch a future skill silently smuggling in a governance/decide action id.

6. **Required test coverage** (integration test in a sibling `*-skills.integration.test.ts`, following the existing files' pattern):
   - **Happy path**, end-to-end through `SkillExecutionService.executeSkill` (not calling `skill.execute` directly) — real service call reaches the DB/downstream, independently re-verified via a separate read call where practical.
   - **Permission-denial spy test**: grant no manifest (or a manifest lacking this skill's actionType), assert `executeSkill(...)` rejects with `ForbiddenError`, and assert — via `vi.spyOn(service, 'method')` recorded _before_ the call — that the wrapped method's call count is unchanged afterward. This is the concrete proof for the spec's acceptance criterion "izin reddedildiğinde altta yatan servis metodu HİÇ ÇAĞRILMAZ".
   - **Cross-workspace isolation test**: grant the manifest only in workspace A, then call `executeSkill` for the same agent identifier in workspace B, assert `ForbiddenError`.
   - If the skill is objectId-based, also cover: the pre-fetch resolving the real object type (not a caller-asserted one), and that an object belonging to a different workspace is rejected/not found rather than silently acted upon.

## Known, currently-accepted gaps (do not "fix" silently — these are documented trade-offs, not bugs)

- **Signing keys are per-file, process-lifetime-generated, not the canonical `SKILL_SDK_PUBLIC_KEY_PEM`.** No private key matching that checked-in canonical constant exists anywhere in the repo yet (see `skill-sdk-public-key.ts`'s own doc comment) — real release-time key management is a follow-up, not something to invent ad hoc while adding one skill.
- **Field-level visibility is not narrowed per agent manifest.** A fixed `CALLER_ROLE` unlocks that role's full field visibility (including, for `get-meeting-details`, verbatim transcript text) for any agent whose coarse actionType/dataScope check passes — per-agent field-level narrowing is a separate, not-yet-designed mechanism.
- **objectId pre-fetches for permission-check type resolution run before the permission check itself**, outside `AgentResourceLimitsService`'s rate/concurrency gate — accepted because there is currently no external-facing caller of `SkillExecutionService` at all (no HTTP route is wired; F3-T3 will be the first). Revisit when that changes.

## Checklist before calling it done

- [ ] Skill id follows the kebab-case verb-first convention and is not reused across two different actions
- [ ] `execute` validates `input` with a single `.loose()` zod schema (or documents why it reuses a `.strict()` DTO + `stripAuthoritativeContext` instead)
- [ ] Wrapped method is NOT `decide()` or a workspace-governance write (triggers/webhooks/MCP grants) — confirmed against ADR-0036 Decision (e)'s exclusion list
- [ ] Registered in `skills.module.ts` with the correct file-matching signing public key constant
- [ ] `EXPECTED_SKILL_IDS` (and, if relevant, `EXCLUDED_ACTION_IDS`) updated in `skills-registry-smoke.integration.test.ts`
- [ ] Integration test covers: happy path end-to-end, permission-denial spy proving the wrapped method is never called, cross-workspace isolation
- [ ] `pnpm --filter @luminaos/skill-sdk build/typecheck/test` and `pnpm --filter @luminaos/server typecheck/lint/test` both green
- [ ] Full `yeni-ozellik` ritual checklist also satisfied (test-writer → implementer → security-reviewer) — this skill extends it, doesn't replace it
