import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent } from '@luminaos/shared';

import type { Trigger, TriggerSpec } from './trigger.js';

const KNOWN_KINDS: readonly TriggerSpec['kind'][] = ['scheduled', 'condition'];

function isKnownKind(kind: unknown): kind is TriggerSpec['kind'] {
  return typeof kind === 'string' && (KNOWN_KINDS as readonly string[]).includes(kind);
}

/**
 * ADR-0032 Karar (i)/(l) — a pure fold mirroring `replaySavedView`'s
 * discipline: the stream must start with `TriggerCreated`, and every
 * payload field it reads is validated (`typeof`/known-kind guards) rather
 * than trusted blindly. An unrecognized event type after the first is a
 * no-op (forward compatibility).
 */
export function replayTrigger(events: DomainEvent[]): Trigger {
  const [first, ...rest] = events;

  if (!first || first.type !== 'TriggerCreated') {
    throw new InvalidObjectStateError('a trigger event stream must start with TriggerCreated');
  }

  let state = applyTriggerCreated(first);

  for (const event of rest) {
    state = applyEvent(state, event);
  }

  return state;
}

function applyTriggerCreated(event: DomainEvent): Trigger {
  const { triggerId, workspaceId, name, kind, spec } = event.payload;

  if (typeof triggerId !== 'string' || triggerId.length === 0) {
    throw new InvalidObjectStateError('TriggerCreated event is missing a valid triggerId');
  }

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new InvalidObjectStateError('TriggerCreated event is missing a valid workspaceId');
  }

  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidObjectStateError('TriggerCreated event is missing a valid name');
  }

  if (!isKnownKind(kind)) {
    throw new InvalidObjectStateError('TriggerCreated event has an invalid or unknown kind');
  }

  if (typeof spec !== 'object' || spec === null) {
    throw new InvalidObjectStateError('TriggerCreated event is missing a valid spec');
  }

  return {
    id: triggerId,
    workspaceId,
    name,
    kind,
    spec: spec as TriggerSpec,
    lastFiredAt: null,
    lifecycle: 'active',
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

function applyEvent(state: Trigger, event: DomainEvent): Trigger {
  switch (event.type) {
    case 'TriggerUpdated':
      return applyTriggerUpdated(state, event);
    case 'TriggerDeleted':
      return applyTriggerDeleted(state, event);
    default:
      return state;
  }
}

function applyTriggerUpdated(state: Trigger, event: DomainEvent): Trigger {
  const { triggerId, name, spec } = event.payload;

  if (typeof triggerId !== 'string' || triggerId.length === 0) {
    throw new InvalidObjectStateError('TriggerUpdated event is missing a valid triggerId');
  }

  let next = state;

  if (name !== undefined) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidObjectStateError('TriggerUpdated event has an invalid name');
    }
    next = { ...next, name };
  }

  if (spec !== undefined) {
    if (typeof spec !== 'object' || spec === null) {
      throw new InvalidObjectStateError('TriggerUpdated event has an invalid spec');
    }

    const nextSpec = spec as TriggerSpec;

    if (!isKnownKind(nextSpec.kind)) {
      throw new InvalidObjectStateError('TriggerUpdated event has an invalid or unknown spec.kind');
    }

    next = { ...next, spec: nextSpec, kind: nextSpec.kind };
  }

  return { ...next, updatedAt: event.occurredAt };
}

function applyTriggerDeleted(state: Trigger, event: DomainEvent): Trigger {
  const { triggerId } = event.payload;

  if (typeof triggerId !== 'string' || triggerId.length === 0) {
    throw new InvalidObjectStateError('TriggerDeleted event is missing a valid triggerId');
  }

  return { ...state, lifecycle: 'deleted', updatedAt: event.occurredAt };
}
