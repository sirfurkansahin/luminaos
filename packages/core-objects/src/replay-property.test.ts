import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Actor, DomainEvent } from '@luminaos/shared';

import {
  archiveObject,
  createObject,
  renameObject,
  restoreObject,
  softDeleteObject,
} from './commands.js';
import { replayObject } from './replay.js';

import type { ObjectEventDraft } from './commands.js';
import type { Lifecycle, LuminaObject } from './lumina-object.js';

/**
 * THE fast-check property test for AC #2: "replayObject: rastgele geçerli
 * komut dizileri için property-based test (fast-check) — hiçbir dizi
 * geçersiz duruma ulaşamaz."
 *
 * Strategy: fast-check's model-based/command-sequence testing
 * (`fc.commands` + `fc.modelRun`). A lightweight `Model` tracks only the
 * lifecycle fast-check needs to decide which commands are legal next
 * (mirrors `lifecycle.ts`'s transition table exactly, independently
 * re-derived here so this test doesn't just re-import and trivially agree
 * with `canTransition`). Each fast-check `Command`'s `check(model)` is the
 * legality gate: fast-check ONLY ever sequences a command when `check`
 * returns true for the model state reached so far, so by construction it
 * can never generate an invalid sequence — this is deliberately NOT a
 * fuzzer hunting for thrown errors, it is a generator that stays inside the
 * legal-transition graph at every step and asserts the replayed state is
 * always structurally sound.
 *
 * `RealSystem` is the "real" side of the model/real pair: it accumulates
 * realistic `DomainEvent` fixtures (id/streamId/workspaceId/version/actor/
 * occurredAt all filled in, matching F0-T6's `domainEventSchema` shape) and
 * exposes `state`, which re-runs `replayObject` over everything
 * accumulated so far — i.e. replay is exercised fresh after every single
 * command in the sequence, not just once at the end.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const STREAM_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR: Actor = { type: 'user', id: 'user-1' };
const FIXED_OBJECT_TYPE = 'task';

interface Model {
  lifecycle: Lifecycle;
}

class RealSystem {
  events: DomainEvent[] = [];
  createdAt: Date | undefined;
  private version = 0;
  private clockMs = Date.UTC(2026, 0, 1, 0, 0, 0);

  applyDrafts(drafts: ObjectEventDraft[]): void {
    for (const draft of drafts) {
      this.version += 1;
      this.clockMs += 1_000;
      const versionHex = this.version.toString(16).padStart(11, '0');

      this.events.push({
        id: `44444444-4444-4444-8${versionHex}`,
        streamId: STREAM_ID,
        streamType: 'lumina-object',
        workspaceId: WORKSPACE_ID,
        type: draft.type,
        version: this.version,
        payload: draft.payload,
        actor: ACTOR,
        occurredAt: new Date(this.clockMs),
      });
    }
  }

  get state(): LuminaObject {
    return replayObject(this.events);
  }
}

/** Asserts the invariants that must hold after EVERY step, valid or not. */
function assertInvariants(real: RealSystem, model: Model): void {
  const state = real.state;

  expect(['active', 'archived', 'deleted']).toContain(state.lifecycle);
  expect(state.lifecycle).toBe(model.lifecycle);
  expect(state.id).toBe(OBJECT_ID);
  expect(state.workspaceId).toBe(WORKSPACE_ID);
  expect(state.type).toBe(FIXED_OBJECT_TYPE);
  expect(state.createdBy).toBe(ACTOR.id);
  expect(real.createdAt).toBeDefined();
  if (real.createdAt) {
    expect(state.createdAt.getTime()).toBe(real.createdAt.getTime());
  }
  expect(state.updatedAt.getTime()).toBeGreaterThanOrEqual(state.createdAt.getTime());
}

class ArchiveCommand implements fc.Command<Model, RealSystem> {
  check(m: Readonly<Model>): boolean {
    return m.lifecycle === 'active';
  }

  run(m: Model, r: RealSystem): void {
    const drafts = archiveObject(r.state);
    r.applyDrafts(drafts);
    m.lifecycle = 'archived';
    assertInvariants(r, m);
  }

  toString(): string {
    return 'archive';
  }
}

class RestoreCommand implements fc.Command<Model, RealSystem> {
  check(m: Readonly<Model>): boolean {
    return m.lifecycle === 'archived' || m.lifecycle === 'deleted';
  }

  run(m: Model, r: RealSystem): void {
    const drafts = restoreObject(r.state);
    r.applyDrafts(drafts);
    m.lifecycle = 'active';
    assertInvariants(r, m);
  }

  toString(): string {
    return 'restore';
  }
}

class SoftDeleteCommand implements fc.Command<Model, RealSystem> {
  check(m: Readonly<Model>): boolean {
    return m.lifecycle === 'active' || m.lifecycle === 'archived';
  }

  run(m: Model, r: RealSystem): void {
    const drafts = softDeleteObject(r.state);
    r.applyDrafts(drafts);
    m.lifecycle = 'deleted';
    assertInvariants(r, m);
  }

  toString(): string {
    return 'softDelete';
  }
}

/**
 * Title is pre-generated (non-empty/non-whitespace) by the arbitrary that
 * builds this command, so `check` only needs to gate on lifecycle — the
 * title itself is never invalid by construction (matches
 * `renameObject`'s contract: illegal only when `lifecycle === 'deleted'`,
 * for a type that doesn't require an empty-title exemption).
 */
class RenameCommand implements fc.Command<Model, RealSystem> {
  constructor(private readonly title: string) {}

  check(m: Readonly<Model>): boolean {
    return m.lifecycle !== 'deleted';
  }

  run(m: Model, r: RealSystem): void {
    const drafts = renameObject(r.state, { title: this.title });
    r.applyDrafts(drafts);
    // Rename does not change lifecycle.
    assertInvariants(r, m);
  }

  toString(): string {
    return `rename(${this.title})`;
  }
}

const nonEmptyTitleArbitrary = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((title) => title.trim().length > 0);

const commandArbitraries = [
  fc.constant(new ArchiveCommand()),
  fc.constant(new RestoreCommand()),
  fc.constant(new SoftDeleteCommand()),
  nonEmptyTitleArbitrary.map((title) => new RenameCommand(title)),
];

function setup(): { model: Model; real: RealSystem } {
  const real = new RealSystem();
  const drafts = createObject({
    objectId: OBJECT_ID,
    workspaceId: WORKSPACE_ID,
    objectType: FIXED_OBJECT_TYPE,
    title: 'Initial title',
    actor: ACTOR,
  });
  real.applyDrafts(drafts);
  real.createdAt = real.state.createdAt;

  const model: Model = { lifecycle: 'active' };
  assertInvariants(real, model);

  return { model, real };
}

describe('replayObject property: no valid command sequence ever reaches an invalid state', () => {
  it(
    'holds for every command sequence starting with createObject and only using ' +
      'legal-per-current-lifecycle archive/restore/softDelete/rename steps',
    () => {
      fc.assert(
        fc.property(fc.commands(commandArbitraries, { maxCommands: 30 }), (cmds) => {
          fc.modelRun(setup, cmds);
        }),
        // The default (100) is a reasonable floor for most fast-check
        // properties, but this is THE literal acceptance-criterion property
        // for a mission-critical domain invariant (AC #2) — spending more
        // runs here to search a larger slice of the command-sequence space
        // is worth the extra CI time.
        { numRuns: 200 },
      );
    },
  );
});
