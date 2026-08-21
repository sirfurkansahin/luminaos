import { describe, expect, it } from 'vitest';

import { isKnownObjectType, requiresTitle } from './object-type-registry.js';

/**
 * Designed API (per ADR-0003 "Tip genişletme"): a `Record<ObjectType, {
 * titleRequired: boolean }>` registry backs two pure accessors —
 * `isKnownObjectType(type: string): boolean` (a type guard usable on
 * untrusted/external strings, e.g. from an API body) and
 * `requiresTitle(type: ObjectType): boolean` (only meaningful for already-
 * known types; callers must narrow with `isKnownObjectType` first).
 */
describe('isKnownObjectType', () => {
  it('accepts "task"', () => {
    expect(isKnownObjectType('task')).toBe(true);
  });

  it('accepts "doc"', () => {
    expect(isKnownObjectType('doc')).toBe(true);
  });

  it('accepts "note"', () => {
    expect(isKnownObjectType('note')).toBe(true);
  });

  it('rejects an unknown type string', () => {
    expect(isKnownObjectType('project')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isKnownObjectType('')).toBe(false);
  });

  it('rejects a case-mismatched known type name', () => {
    expect(isKnownObjectType('Task')).toBe(false);
  });

  /**
   * F1-T12 PR2 (RED step) — `timeblock` object type registration. `'timeblock'`
   * is not yet a member of `ObjectType`/`objectTypeRegistry` in
   * `./object-type-registry.ts`, so this assertion is expected to fail (not
   * a TS compile error here since `isKnownObjectType` accepts `string`).
   */
  it('accepts "timeblock"', () => {
    expect(isKnownObjectType('timeblock')).toBe(true);
  });

  /**
   * F2-T13 PR1 (RED step) — `meeting` object type registration (ADR-0030
   * §b/Bağlam madde 1). `'meeting'` is not yet a member of
   * `ObjectType`/`objectTypeRegistry` in `./object-type-registry.ts`, so this
   * assertion is expected to fail (not a TS compile error here since
   * `isKnownObjectType` accepts `string`).
   */
  it('accepts "meeting"', () => {
    expect(isKnownObjectType('meeting')).toBe(true);
  });
});

describe('requiresTitle', () => {
  it('requires a title for "task"', () => {
    expect(requiresTitle('task')).toBe(true);
  });

  it('does not require a title for "doc"', () => {
    expect(requiresTitle('doc')).toBe(false);
  });

  it('does not require a title for "note"', () => {
    expect(requiresTitle('note')).toBe(false);
  });

  /**
   * F1-T12 PR2 (RED step) — a timeblock's title is optional (e.g. "Focus
   * time"); the schedule itself, not the title, is the meaningful data.
   * `'timeblock'` does not exist as an `ObjectType` member yet, so this line
   * is expected to fail TypeScript compilation ("Argument of type
   * '"timeblock"' is not assignable to parameter of type 'ObjectType'")
   * until `implementer` adds it to `./lumina-object.ts`'s `ObjectType` union
   * and to `./object-type-registry.ts`'s registry.
   */
  it('does not require a title for "timeblock"', () => {
    expect(requiresTitle('timeblock')).toBe(false);
  });

  /**
   * F2-T13 PR1 (RED step) — per ADR-0030 §b, `meeting` gets `{titleRequired:
   * true}`, the SAME rule as `task` (NOT `doc`/`note`/`timeblock`'s `false`):
   * a meeting's title is always a meaningful identifier even when derived
   * from `meetingUrl`/a calendar event. `'meeting'` does not exist as an
   * `ObjectType` member yet, so this line is expected to fail TypeScript
   * compilation ("Argument of type '"meeting"' is not assignable to
   * parameter of type 'ObjectType'") until `implementer` adds it to
   * `./lumina-object.ts`'s `ObjectType` union and to
   * `./object-type-registry.ts`'s registry.
   */
  it('requires a title for "meeting"', () => {
    expect(requiresTitle('meeting')).toBe(true);
  });
});

/**
 * NOTE on `apps/server/src/objects/dto/create-object.schema.ts`'s
 * `z.enum(['task', 'doc', 'note', 'timeblock'])` literal — this is another
 * "runtime array of the exact `ObjectType` set" in the codebase, but it has
 * no dedicated test file of its own today (`Glob` for
 * `apps/server/src/objects/dto/*.test.ts` found nothing; that schema's
 * `objectType` enum is only ever exercised indirectly, through HTTP
 * integration tests like `apps/server/src/objects/timeblock-http.integration
 * .test.ts` that POST a real object of a given type). Adding `'meeting'` to
 * that DTO enum (and any test exercising object CREATION via the generic
 * `POST /workspaces/:workspaceId/objects` endpoint) is explicitly OUT OF
 * SCOPE for this PR per the caller's instructions — PR1 registers the
 * `meeting` type in `packages/core-objects` and ships the `meeting_details`
 * table only; no controller/service wiring exists yet for a `meeting` object
 * to actually be created through that endpoint. That DTO enum literal is left
 * to whichever future PR (PR3, per ADR-0030's closing "Sıradaki adım") wires
 * up `meeting` object creation.
 */
