import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';
import type { Actor, DomainEvent } from '@luminaos/shared';

import {
  addChecklistItem,
  removeChecklistItem,
  reorderChecklistItem,
  toggleChecklistItem,
} from './checklist-commands.js';
import { createObject } from './commands.js';
import { replayObject } from './replay.js';

import type { ObjectEventDraft } from './commands.js';
import type { LuminaObject } from './lumina-object.js';

/**
 * THE fast-check property test for F1-T10's remaining PR2 acceptance
 * criterion: "Kontrol listesi: ekleme/işaretleme/silme/yeniden sıralama
 * olayları `replayObject` ile doğru sırayla katlandığı property-based testle
 * kanıtlı." The command layer (`checklist-commands.ts`) and the replay fold
 * (`replay.ts`'s `ChecklistItemAdded/Toggled/Removed/Reordered` cases) are
 * already covered by ordinary example-based unit tests
 * (`checklist-commands.test.ts`, `replay.test.ts`'s "replayObject: checklist
 * events" block) — this file is specifically the property-based coverage the
 * criterion names, sibling to `replay-property.test.ts`'s lifecycle property
 * and following the exact same `fc.commands`/`fc.modelRun` strategy.
 *
 * Unlike `replay-property.test.ts` (which is about lifecycle *legality* —
 * which commands are even allowed to run next), checklist commands are
 * always legal on an active object regardless of checklist contents (aside
 * from the id-uniqueness / 200-item-cap / permutation gates already
 * exercised by ordinary unit tests). The property under test here is
 * narrower and is exactly what this acceptance criterion asks for: that
 * `replayObject`'s FOLD of the four checklist event types is correct across
 * arbitrary legal sequences, not just the isolated single-event cases the
 * existing unit tests already cover.
 *
 * `Model.items` is an independently re-derived in-memory mirror of what the
 * checklist SHOULD be after each command, built directly from the
 * documented contract (`checklist-commands.test.ts`'s header comment) and
 * the actual fold in `replay.ts`:
 *   - add:     appends `{ id, text, done: false, order: items.length }`
 *              (order = current length at the time of the command).
 *   - toggle:  flips `done` on exactly the matching id; nothing else
 *              (text/order/other items) changes.
 *   - remove:  deletes exactly the matching id via a stable filter — it
 *              does NOT renumber the remaining items' `order` (mirrors
 *              `replay.ts`'s `ChecklistItemRemoved` case, which is a plain
 *              `filter`, deliberately leaving gaps in `order`; also
 *              exercised directly by `replay.test.ts`'s "applies
 *              ChecklistItemRemoved: drops the matched item" case).
 *   - reorder: rebuilds the array in the given id order, resequencing every
 *              item's `order` to its new index while preserving
 *              `text`/`done` (mirrors `replay.ts`'s `ChecklistItemReordered`
 *              case).
 *
 * After every single step, `assertInvariants` asserts `real.state.checklist`
 * (the actual `replayObject` fold over every accumulated event so far)
 * deep-equals `model.items` exactly, plus the structural invariants
 * (id-uniqueness, 200-item cap) that must hold no matter what sequence ran.
 *
 * Command legality gates (each command's fast-check `check()`), matching
 * this task's requirement that fast-check only ever sequence a LEGAL
 * command against the model's current state:
 *   - add:     only when the model is under the 200-item cap AND the
 *              proposed itemId is not already present in the model's
 *              current items (matches `addChecklistItem`'s duplicate-id and
 *              cap guards — re-adding a PREVIOUSLY REMOVED id is legal,
 *              since both the real command and the model only look at
 *              current items, never history).
 *   - toggle/remove: only when the proposed index actually addresses an
 *              existing item in the model's current checklist.
 *   - reorder: the permutation arbitrary is generated for a specific
 *              length (0-10) up front; `check()` only allows it once the
 *              model's current item count matches that length, so by
 *              construction the ids resolved from it at `run()` time are
 *              always exactly a permutation of the model's current ids.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const STREAM_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR: Actor = { type: 'user', id: 'user-1' };
const FIXED_OBJECT_TYPE = 'task';

/** Mirrors `checklist-commands.ts`'s private `CHECKLIST_ITEM_LIMIT`, kept
 * independent on purpose (same rationale as `replay-property.test.ts`'s
 * independently re-derived lifecycle table: this test shouldn't just
 * re-import the implementation's constant and trivially agree with it). */
const CHECKLIST_ITEM_LIMIT = 200;

interface ModelItem {
  id: string;
  text: string;
  done: boolean;
  order: number;
}

interface Model {
  items: ModelItem[];
}

class RealSystem {
  events: DomainEvent[] = [];
  private version = 0;
  private clockMs = Date.UTC(2026, 0, 1, 0, 0, 0);

  applyDrafts(drafts: ObjectEventDraft[]): void {
    for (const draft of drafts) {
      this.version += 1;
      this.clockMs += 1_000;
      const versionHex = this.version.toString(16).padStart(11, '0');

      this.events.push({
        id: `55555555-5555-4555-8${versionHex}`,
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

/**
 * `noUncheckedIndexedAccess` guard: every command below only ever indexes
 * `model.items` at a position its own `check()` already proved exists, but
 * TypeScript can't see across that gate — this makes the "must exist"
 * invariant explicit (and throws a real `@luminaos/shared` error, per
 * CLAUDE.md, rather than a bare `throw new Error`, if that invariant is
 * ever violated by a bug in this test file itself).
 */
function assertItemExists(item: ModelItem | undefined, index: number): asserts item is ModelItem {
  if (item === undefined) {
    throw new ValidationError(`model has no checklist item at index ${String(index)}`, { index });
  }
}

/** Asserts the invariants that must hold after EVERY step. */
function assertInvariants(real: RealSystem, model: Model): void {
  const state = real.state;

  expect(state.checklist).toEqual(model.items);
  expect(state.checklist.length).toBeLessThanOrEqual(CHECKLIST_ITEM_LIMIT);
  expect(new Set(state.checklist.map((item) => item.id)).size).toBe(state.checklist.length);
}

class AddChecklistItemCommand implements fc.Command<Model, RealSystem> {
  constructor(
    private readonly itemId: string,
    private readonly text: string,
  ) {}

  check(m: Readonly<Model>): boolean {
    return (
      m.items.length < CHECKLIST_ITEM_LIMIT && !m.items.some((item) => item.id === this.itemId)
    );
  }

  run(m: Model, r: RealSystem): void {
    const drafts = addChecklistItem(r.state, { itemId: this.itemId, text: this.text });
    r.applyDrafts(drafts);

    const order = m.items.length;
    m.items.push({ id: this.itemId, text: this.text, done: false, order });

    assertInvariants(r, m);
  }

  toString(): string {
    return `add(${this.itemId})`;
  }
}

class ToggleChecklistItemCommand implements fc.Command<Model, RealSystem> {
  constructor(private readonly index: number) {}

  check(m: Readonly<Model>): boolean {
    return this.index < m.items.length;
  }

  run(m: Model, r: RealSystem): void {
    const target = m.items[this.index];
    assertItemExists(target, this.index);

    const drafts = toggleChecklistItem(r.state, target.id);
    r.applyDrafts(drafts);
    target.done = !target.done;

    assertInvariants(r, m);
  }

  toString(): string {
    return `toggle(#${String(this.index)})`;
  }
}

class RemoveChecklistItemCommand implements fc.Command<Model, RealSystem> {
  constructor(private readonly index: number) {}

  check(m: Readonly<Model>): boolean {
    return this.index < m.items.length;
  }

  run(m: Model, r: RealSystem): void {
    const target = m.items[this.index];
    assertItemExists(target, this.index);

    const drafts = removeChecklistItem(r.state, target.id);
    r.applyDrafts(drafts);
    m.items = m.items.filter((item) => item.id !== target.id);

    assertInvariants(r, m);
  }

  toString(): string {
    return `remove(#${String(this.index)})`;
  }
}

class ReorderChecklistItemCommand implements fc.Command<Model, RealSystem> {
  constructor(private readonly permutation: number[]) {}

  check(m: Readonly<Model>): boolean {
    return m.items.length === this.permutation.length;
  }

  run(m: Model, r: RealSystem): void {
    const orderedItems = this.permutation.map((index) => {
      const item = m.items[index];
      assertItemExists(item, index);
      return item;
    });
    const orderedItemIds = orderedItems.map((item) => item.id);

    const drafts = reorderChecklistItem(r.state, orderedItemIds);
    r.applyDrafts(drafts);

    m.items = orderedItems.map((item, newOrder) => ({ ...item, order: newOrder }));

    assertInvariants(r, m);
  }

  toString(): string {
    return `reorder([${this.permutation.join(',')}])`;
  }
}

const itemIdArbitrary = fc.integer({ min: 0, max: 999_999 }).map((n) => `item-${String(n)}`);

const nonEmptyTextArbitrary = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((text) => text.trim().length > 0);

/**
 * Permutations of a fixed length in [0, 10]: `check()` only lets a given
 * instance run once the model's current item count equals that length, so
 * the indices it carries always resolve to a genuine permutation of
 * whatever the model's current items happen to be at that point.
 */
const reorderPermutationArbitrary = fc.nat({ max: 10 }).chain((length) => {
  const indices = Array.from({ length }, (_, index) => index);
  return fc.shuffledSubarray(indices, { minLength: length, maxLength: length });
});

const commandArbitraries = [
  fc
    .tuple(itemIdArbitrary, nonEmptyTextArbitrary)
    .map(([itemId, text]) => new AddChecklistItemCommand(itemId, text)),
  fc.nat({ max: 15 }).map((index) => new ToggleChecklistItemCommand(index)),
  fc.nat({ max: 15 }).map((index) => new RemoveChecklistItemCommand(index)),
  reorderPermutationArbitrary.map((permutation) => new ReorderChecklistItemCommand(permutation)),
];

function setup(): { model: Model; real: RealSystem } {
  const real = new RealSystem();
  const drafts = createObject({
    objectId: OBJECT_ID,
    workspaceId: WORKSPACE_ID,
    objectType: FIXED_OBJECT_TYPE,
    title: 'Checklist host task',
    actor: ACTOR,
  });
  real.applyDrafts(drafts);

  const model: Model = { items: [] };
  assertInvariants(real, model);

  return { model, real };
}

describe('replayObject property: checklist add/toggle/remove/reorder fold correctly for any legal sequence', () => {
  it(
    'replayed checklist always deep-equals an independently maintained model, for every legal ' +
      'sequence of addChecklistItem/toggleChecklistItem/removeChecklistItem/reorderChecklistItem',
    () => {
      fc.assert(
        fc.property(fc.commands(commandArbitraries, { maxCommands: 40 }), (cmds) => {
          fc.modelRun(setup, cmds);
        }),
        // This is THE literal acceptance-criterion property for F1-T10 PR2's
        // remaining checkbox (checklist fold correctness) — spending more
        // runs here than the fast-check default (100) is worth the extra CI
        // time for a mission-critical domain fold.
        { numRuns: 150 },
      );
    },
  );
});
