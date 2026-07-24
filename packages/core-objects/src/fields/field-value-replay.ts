import type { DomainEvent } from '@luminaos/shared';

/**
 * Folds ONLY `FieldValueChanged` events (`payload.fieldKey -> payload.value`),
 * silently ignoring every other event type (including `ObjectCreated`/
 * `ObjectRenamed`/etc.) — this runs on the OBJECT's own mixed event stream
 * (per the F1-T2 plan's central architecture decision: field values live in
 * the object's own stream, not a separate one).
 *
 * Deliberately the OPPOSITE discipline from `field-replay.ts`/`replay.ts`:
 * this fold never throws on an unrecognized event type or a malformed
 * `FieldValueChanged` payload — it skips. An event array containing only
 * non-field events (e.g. just `ObjectCreated`) is the normal/expected case,
 * not corruption.
 */
export function replayFieldValues(events: DomainEvent[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const event of events) {
    if (event.type !== 'FieldValueChanged') {
      continue;
    }

    const { fieldKey, value } = event.payload;

    if (typeof fieldKey !== 'string' || fieldKey.length === 0) {
      continue;
    }

    values[fieldKey] = value;
  }

  return values;
}
