import { z } from 'zod';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import type { ObjectEventDraft } from './commands.js';
import type { LuminaObject, TimeBlockSchedule } from './lumina-object.js';

/**
 * Same ISO-8601 datetime shape check as `./recurrence-rule-commands.ts`'s
 * `endDateSchema` precedent, but for full datetimes rather than dates.
 */
const isoDateTimeSchema = z.iso.datetime();

function assertNotDeleted(state: LuminaObject, attemptedAction: string): void {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError(`cannot ${attemptedAction} on a deleted object`, {
      objectId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction,
    });
  }
}

export function scheduleTimeBlock(
  state: LuminaObject,
  input: TimeBlockSchedule,
): ObjectEventDraft[] {
  assertNotDeleted(state, 'scheduleTimeBlock');

  if (!isoDateTimeSchema.safeParse(input.start).success) {
    throw new ValidationError('timeBlock start must be a valid ISO-8601 datetime string', {
      objectId: state.id,
    });
  }

  if (!isoDateTimeSchema.safeParse(input.end).success) {
    throw new ValidationError('timeBlock end must be a valid ISO-8601 datetime string', {
      objectId: state.id,
    });
  }

  if (new Date(input.end).getTime() <= new Date(input.start).getTime()) {
    throw new ValidationError('timeBlock end must be strictly after start', {
      objectId: state.id,
      start: input.start,
      end: input.end,
    });
  }

  return [
    {
      type: 'TimeBlockScheduled',
      payload: { objectId: state.id, start: input.start, end: input.end },
    },
  ];
}

export function clearTimeBlockSchedule(state: LuminaObject): ObjectEventDraft[] {
  assertNotDeleted(state, 'clearTimeBlockSchedule');

  if (state.timeBlock === undefined) {
    throw new ValidationError('no timeBlock schedule to clear', { objectId: state.id });
  }

  return [{ type: 'TimeBlockCleared', payload: { objectId: state.id } }];
}
