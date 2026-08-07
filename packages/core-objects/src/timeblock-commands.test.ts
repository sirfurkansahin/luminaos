import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { clearTimeBlockSchedule, scheduleTimeBlock } from './timeblock-commands.js';

import type { LuminaObject } from './lumina-object.js';

/**
 * F1-T12 PR2 (RED step) — `timeblock` object type's embedded `timeBlock`
 * schedule command layer, per this PR's designed contract (mirrors
 * `./recurrence-rule-commands.test.ts`'s own header-comment convention and
 * `./recurrence-rule-commands.ts`'s implementation shape exactly).
 *
 * `./timeblock-commands.ts` does NOT exist yet — the import above is
 * expected to fail module resolution ("Cannot find module") the instant this
 * file loads, before any `describe`/`it` block runs. That is the correct red
 * state; `implementer` must create `./timeblock-commands.ts` (plus the
 * `'timeblock'` `ObjectType` member + `TimeBlockSchedule` interface +
 * `timeBlock?: TimeBlockSchedule` field on `LuminaObject` in
 * `./lumina-object.ts`, the `timeblock: { titleRequired: false }` entry in
 * `./object-type-registry.ts`, and the `TimeBlockScheduled`/`TimeBlockCleared`
 * folding in `./replay.ts` — see `./replay.test.ts`'s "timeblock events"
 * `describe` block for that half of the contract) to turn this green.
 *
 * ============================================================================
 * DESIGNED COMMAND SIGNATURES (implementer must match exactly):
 *
 *   scheduleTimeBlock(state: LuminaObject, input: TimeBlockSchedule): ObjectEventDraft[]
 *     -> single draft, type 'TimeBlockScheduled',
 *        payload { objectId, start, end } (both taken verbatim from `input`).
 *     -> throws ValidationError with { objectId } context if `start` is not
 *        a valid ISO-8601 datetime string (`z.iso.datetime()`-shaped).
 *     -> throws ValidationError with { objectId } context if `end` is not
 *        a valid ISO-8601 datetime string (`z.iso.datetime()`-shaped).
 *     -> throws ValidationError with { objectId, start, end } context if
 *        `end` is not strictly after `start` (parsed as `Date`s) — covers
 *        both `end === start` and `end < start`.
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'
 *        (attemptedAction: 'scheduleTimeBlock'), mirroring every other
 *        command's deleted-object guard; archived objects ARE allowed.
 *     -> no "already scheduled" guard: calling this on a state that already
 *        has `timeBlock` set simply overwrites it with the new schedule
 *        (rescheduling), mirroring `setRecurrenceRule`'s own no-special-check
 *        overwrite behavior.
 *
 *   clearTimeBlockSchedule(state: LuminaObject): ObjectEventDraft[]
 *     -> single draft, type 'TimeBlockCleared', payload { objectId }.
 *     -> throws ValidationError with { objectId } context if
 *        `state.timeBlock` is undefined (nothing to clear).
 *     -> throws InvalidObjectStateError if state.lifecycle === 'deleted'
 *        (attemptedAction: 'clearTimeBlockSchedule').
 * ============================================================================
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

interface TimeBlockSchedule {
  start: string;
  end: string;
}

function buildState(overrides: Record<string, unknown> = {}): LuminaObject {
  return {
    id: OBJECT_ID,
    type: 'timeblock',
    workspaceId: WORKSPACE_ID,
    title: 'Focus time',
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    lifecycle: 'active',
    checklist: [],
    ...overrides,
  } as unknown as LuminaObject;
}

describe('scheduleTimeBlock', () => {
  it('returns a single TimeBlockScheduled draft with the expected payload', () => {
    const drafts = scheduleTimeBlock(buildState(), {
      start: '2026-02-01T09:00:00.000Z',
      end: '2026-02-01T10:00:00.000Z',
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('TimeBlockScheduled');
    expect(drafts[0]?.payload).toEqual({
      objectId: OBJECT_ID,
      start: '2026-02-01T09:00:00.000Z',
      end: '2026-02-01T10:00:00.000Z',
    });
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    expect(() =>
      scheduleTimeBlock(buildState({ lifecycle: 'deleted' }), {
        start: '2026-02-01T09:00:00.000Z',
        end: '2026-02-01T10:00:00.000Z',
      }),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object (same rule as recurrence-rule / checklist commands)', () => {
    expect(() =>
      scheduleTimeBlock(buildState({ lifecycle: 'archived' }), {
        start: '2026-02-01T09:00:00.000Z',
        end: '2026-02-01T10:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('throws ValidationError with { objectId } context when start is not a valid ISO-8601 datetime string', () => {
    expect(() =>
      scheduleTimeBlock(buildState(), {
        start: 'not-a-datetime',
        end: '2026-02-01T10:00:00.000Z',
      }),
    ).toThrow(ValidationError);

    try {
      scheduleTimeBlock(buildState(), { start: 'not-a-datetime', end: '2026-02-01T10:00:00.000Z' });
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ objectId: OBJECT_ID });
    }
  });

  it('throws ValidationError when start is only a date (no time component)', () => {
    expect(() =>
      scheduleTimeBlock(buildState(), { start: '2026-02-01', end: '2026-02-01T10:00:00.000Z' }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError with { objectId } context when end is not a valid ISO-8601 datetime string', () => {
    expect(() =>
      scheduleTimeBlock(buildState(), {
        start: '2026-02-01T09:00:00.000Z',
        end: 'not-a-datetime',
      }),
    ).toThrow(ValidationError);

    try {
      scheduleTimeBlock(buildState(), { start: '2026-02-01T09:00:00.000Z', end: 'not-a-datetime' });
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ objectId: OBJECT_ID });
    }
  });

  it('throws ValidationError with { objectId, start, end } context when end equals start', () => {
    const sameInstant = '2026-02-01T09:00:00.000Z';

    expect(() => scheduleTimeBlock(buildState(), { start: sameInstant, end: sameInstant })).toThrow(
      ValidationError,
    );

    try {
      scheduleTimeBlock(buildState(), { start: sameInstant, end: sameInstant });
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({
        objectId: OBJECT_ID,
        start: sameInstant,
        end: sameInstant,
      });
    }
  });

  it('throws ValidationError with { objectId, start, end } context when end is before start', () => {
    expect(() =>
      scheduleTimeBlock(buildState(), {
        start: '2026-02-01T10:00:00.000Z',
        end: '2026-02-01T09:00:00.000Z',
      }),
    ).toThrow(ValidationError);
  });

  it('rescheduling: overwrites an already-scheduled timeBlock with the new start/end, no special guard', () => {
    const alreadyScheduled = buildState({
      timeBlock: { start: '2026-02-01T09:00:00.000Z', end: '2026-02-01T10:00:00.000Z' },
    });

    const drafts = scheduleTimeBlock(alreadyScheduled, {
      start: '2026-03-01T14:00:00.000Z',
      end: '2026-03-01T15:30:00.000Z',
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('TimeBlockScheduled');
    expect(drafts[0]?.payload).toEqual({
      objectId: OBJECT_ID,
      start: '2026-03-01T14:00:00.000Z',
      end: '2026-03-01T15:30:00.000Z',
    });
  });
});

describe('clearTimeBlockSchedule', () => {
  it('returns a single TimeBlockCleared draft with the expected payload', () => {
    const drafts = clearTimeBlockSchedule(
      buildState({
        timeBlock: { start: '2026-02-01T09:00:00.000Z', end: '2026-02-01T10:00:00.000Z' },
      }),
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('TimeBlockCleared');
    expect(drafts[0]?.payload).toEqual({ objectId: OBJECT_ID });
  });

  it('throws ValidationError with { objectId } context when there is no timeBlock to clear', () => {
    expect(() => clearTimeBlockSchedule(buildState({ timeBlock: undefined }))).toThrow(
      ValidationError,
    );

    try {
      clearTimeBlockSchedule(buildState({ timeBlock: undefined }));
      expect.unreachable('expected ValidationError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toMatchObject({ objectId: OBJECT_ID });
    }
  });

  it('throws InvalidObjectStateError when the object is deleted', () => {
    expect(() =>
      clearTimeBlockSchedule(
        buildState({
          timeBlock: { start: '2026-02-01T09:00:00.000Z', end: '2026-02-01T10:00:00.000Z' },
          lifecycle: 'deleted',
        }),
      ),
    ).toThrow(InvalidObjectStateError);
  });

  it('succeeds on an archived object', () => {
    expect(() =>
      clearTimeBlockSchedule(
        buildState({
          timeBlock: { start: '2026-02-01T09:00:00.000Z', end: '2026-02-01T10:00:00.000Z' },
          lifecycle: 'archived',
        }),
      ),
    ).not.toThrow();
  });
});

// Prevents an unused-type-only-import lint error in strict configs; also
// documents that `TimeBlockSchedule` is the local test-side mirror of the
// eventual `./lumina-object.js` export of the same name/shape.
void (null as unknown as TimeBlockSchedule);
