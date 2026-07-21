---
name: yeni-ozellik
description: Run when starting any new task/feature from a spec file under docs/specs/. Walks the full CLAUDE.md ritual end to end — spec, plan, TDD, security review, PR, spec-doc close-out.
---

Use this skill whenever a task begins from a spec file (`docs/specs/<EPIC>/<TASK>.md`). It is the project's standard 7-step ritual (see `docs/PLAN.md` §4.6) — follow it in order, don't skip steps.

## When to trigger

- The user references a spec file, an epic/task ID (e.g. "F0-T5"), or says something like "implement the next task" / "read the spec and build it."
- Do **not** trigger for trivial one-line fixes with no spec — this ritual is for real feature/task work.

## Steps

1. **Read the spec.** Open `docs/specs/<EPIC>/<TASK>.md` in full before writing any code. If it doesn't exist, stop and ask — CLAUDE.md forbids coding without one.
2. **Plan mode + explorer.** Enter plan mode. Delegate codebase discovery to the `explorer` subagent (read-only) rather than exploring inline yourself when the surface area is non-trivial. If the spec implies an architectural decision or a deviation from `docs/PLAN.md`, also delegate to `architect` for a design/ADR draft.
3. **Human approves the plan.** Exit plan mode and get explicit sign-off before writing code. Do not proceed on an assumed "yes."
4. **TDD — red then green.** Delegate to `test-writer` to produce failing tests from the spec's acceptance criteria first. Confirm they fail for the right reason. Then delegate to `implementer` to write the minimal code that makes them pass, scoped to the one package the spec names.
5. **Security review.** Before considering the task done, delegate to `security-reviewer` on the diff. Close every finding it raises (fix or explicitly justify why not, with a reason comment if a rule is being relaxed — never a bare `eslint-disable` without one).
6. **Small, single-purpose commits + PR.** Split the change into small commits (~±400 lines per PR). Open a PR; if CI is green, it's mergeable.
7. **Close out the spec.** Use `docs-writer` to mark the spec file's acceptance criteria checked off, add a "Done" section with evidence (test output, commands run) and the PR link.

## Checklist before calling it done

- [ ] Every acceptance criterion has test evidence
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` green
- [ ] security-reviewer findings closed
- [ ] Docs updated if public API changed
- [ ] Spec file has Done + PR link
