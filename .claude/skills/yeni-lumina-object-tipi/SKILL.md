---
name: yeni-lumina-object-tipi
description: Run when adding a new Lumina Object entity type (the single-entity-class model from docs/PLAN.md vision item A). Covers schema, migration, view-engine registration, and the test checklist together, since these four always move as one unit.
---

Use this skill when a task adds a **new Lumina Object type** (e.g. a new entity kind on top of the core-objects model described in `docs/PLAN.md` vision item A). This subsystem doesn't exist yet as of Phase 0 — this skill documents the procedure for when it lands in Phase 1, so the four moving parts (schema, migration, view registration, tests) don't drift apart when someone adds the first/next type.

## When to trigger

- The task explicitly says "add a new object type" / "new entity kind" / references `packages/core-objects`'s type registry.
- Not for changes to an _existing_ object type's fields alone — only for introducing a new type.

## Steps

1. **Schema.** Define the new type's shape in `packages/core-objects` following the existing Lumina Object base contract (Custom/AI Fields + relationships, per PLAN.md vision item A). Validate all external construction of it with zod, per CLAUDE.md's boundary-validation rule.
2. **Migration.** Every schema-affecting change needs a migration **with a working down script** — CLAUDE.md forbids merging one without. Write and test the rollback path, not just the forward path.
3. **View-engine registration.** Register the new type with the view engine (vision item B) so it can render in List/Board/Table/Calendar/etc. Don't let a type exist in the data model without a view path — that's a dead end for users.
4. **Events.** If the type participates in the event log (CLAUDE.md's event-sourcing invariant), name its events in past tense (`XCreated`, `XFieldChanged`) and treat them as immutable — corrections are new events, never edits.
5. **Tests.** At minimum: schema validation (valid + invalid input), migration up+down, and one view-registration smoke test. Follow the TDD ritual (`test-writer` → `implementer`) from the `yeni-ozellik` skill for the actual code.

## Checklist before calling it done

- [ ] zod schema + narrowed types, no `any`
- [ ] Migration has a tested down script
- [ ] Type is registered with the view engine, not just the data layer
- [ ] Events (if any) are past-tense and immutable
- [ ] Full `yeni-ozellik` ritual checklist also satisfied (this skill extends it, doesn't replace it)
