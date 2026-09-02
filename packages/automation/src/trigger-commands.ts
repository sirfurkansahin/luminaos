import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { assertSafeRegexPattern } from './regex-safety.js';

import type { Trigger, TriggerEventDraft, TriggerSpec } from './trigger.js';

/**
 * Validates a `TriggerSpec` shared by `createTrigger` and `updateTrigger`
 * (ADR-0032 Karar l — kind-level discriminated union). Throws
 * `ValidationError` on any violation.
 */
function assertValidSpec(spec: TriggerSpec): void {
  switch (spec.kind) {
    case 'scheduled': {
      if (!Number.isInteger(spec.intervalMinutes) || spec.intervalMinutes <= 0) {
        throw new ValidationError('scheduled trigger intervalMinutes must be a positive integer', {
          intervalMinutes: spec.intervalMinutes,
        });
      }
      return;
    }
    case 'condition': {
      if (spec.objectType.trim().length === 0) {
        throw new ValidationError('condition trigger objectType must not be empty', {
          objectType: spec.objectType,
        });
      }

      if (spec.fieldKey.trim().length === 0) {
        throw new ValidationError('condition trigger fieldKey must not be empty', {
          fieldKey: spec.fieldKey,
        });
      }

      assertSafeRegexPattern(spec.pattern, spec.flags);
      return;
    }
    default: {
      throw new ValidationError('unknown trigger spec kind', {
        kind: (spec as { kind: unknown }).kind,
      });
    }
  }
}

export interface CreateTriggerInput {
  triggerId: string;
  workspaceId: string;
  name: string;
  spec: TriggerSpec;
}

export function createTrigger(input: CreateTriggerInput): TriggerEventDraft[] {
  if (input.name.trim().length === 0) {
    throw new ValidationError('trigger name must not be empty', { name: input.name });
  }

  assertValidSpec(input.spec);

  return [
    {
      type: 'TriggerCreated',
      payload: {
        triggerId: input.triggerId,
        workspaceId: input.workspaceId,
        name: input.name,
        kind: input.spec.kind,
        spec: input.spec,
      },
    },
  ];
}

export interface UpdateTriggerInput {
  name?: string;
  spec?: TriggerSpec;
}

export function updateTrigger(state: Trigger, input: UpdateTriggerInput): TriggerEventDraft[] {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError('cannot update a deleted trigger', {
      triggerId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction: 'update',
    });
  }

  if (input.name !== undefined && input.name.trim().length === 0) {
    throw new ValidationError('trigger name must not be empty', { name: input.name });
  }

  if (input.spec !== undefined) {
    if (input.spec.kind !== state.kind) {
      throw new ValidationError("a trigger's kind is immutable once created", {
        currentKind: state.kind,
        attemptedKind: input.spec.kind,
      });
    }

    assertValidSpec(input.spec);
  }

  const payload: Record<string, unknown> = { triggerId: state.id };

  if (input.name !== undefined) {
    payload.name = input.name;
  }

  if (input.spec !== undefined) {
    payload.spec = input.spec;
  }

  return [{ type: 'TriggerUpdated', payload }];
}

export function deleteTrigger(state: Trigger): TriggerEventDraft[] {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError('trigger is already deleted', {
      triggerId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction: 'delete',
    });
  }

  return [{ type: 'TriggerDeleted', payload: { triggerId: state.id } }];
}
