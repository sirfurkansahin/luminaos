import { z } from 'zod';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import type { ObjectEventDraft } from './commands.js';
import type { LuminaObject, RecurrenceRule } from './lumina-object.js';

/**
 * Same `YYYY-MM-DD` shape check as `./fields/field-type-registry.ts`'s
 * `date` field type (`z.iso.date()`), reused here for consistency.
 */
const endDateSchema = z.iso.date();

const VALID_FREQUENCIES: ReadonlySet<string> = new Set(['daily', 'weekly', 'monthly']);

function assertNotDeleted(state: LuminaObject, attemptedAction: string): void {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError(`cannot ${attemptedAction} on a deleted object`, {
      objectId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction,
    });
  }
}

export function setRecurrenceRule(state: LuminaObject, input: RecurrenceRule): ObjectEventDraft[] {
  assertNotDeleted(state, 'setRecurrenceRule');

  const frequency: string = input.frequency;

  if (!VALID_FREQUENCIES.has(frequency)) {
    throw new ValidationError('recurrenceRule frequency must be one of daily, weekly, monthly', {
      objectId: state.id,
      frequency: input.frequency,
    });
  }

  if (!Number.isInteger(input.interval) || input.interval < 1) {
    throw new ValidationError('recurrenceRule interval must be an integer >= 1', {
      objectId: state.id,
      interval: input.interval,
    });
  }

  if (
    input.byWeekday !== undefined &&
    (!Array.isArray(input.byWeekday) ||
      !input.byWeekday.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))
  ) {
    throw new ValidationError(
      'recurrenceRule byWeekday must be an array of integers in the range [0, 6]',
      { objectId: state.id },
    );
  }

  if (input.endDate !== undefined && !endDateSchema.safeParse(input.endDate).success) {
    throw new ValidationError('recurrenceRule endDate must be a YYYY-MM-DD-shaped string', {
      objectId: state.id,
    });
  }

  const payload: Record<string, unknown> = {
    objectId: state.id,
    frequency: input.frequency,
    interval: input.interval,
  };

  if (input.byWeekday !== undefined) {
    payload.byWeekday = input.byWeekday;
  }

  if (input.endDate !== undefined) {
    payload.endDate = input.endDate;
  }

  return [{ type: 'RecurrenceRuleSet', payload }];
}

export function clearRecurrenceRule(state: LuminaObject): ObjectEventDraft[] {
  assertNotDeleted(state, 'clearRecurrenceRule');

  if (state.recurrenceRule === undefined) {
    throw new ValidationError('no recurrenceRule to clear', { objectId: state.id });
  }

  return [{ type: 'RecurrenceRuleCleared', payload: { objectId: state.id } }];
}
