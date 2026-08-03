import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent } from '@luminaos/shared';

import type { SavedView, ViewType } from './saved-view.js';

const KNOWN_VIEW_TYPES: readonly ViewType[] = ['list', 'board', 'table', 'calendar', 'timeline'];

function isKnownViewType(viewType: unknown): viewType is ViewType {
  return typeof viewType === 'string' && (KNOWN_VIEW_TYPES as readonly string[]).includes(viewType);
}

function isValidOwnerId(ownerId: unknown): ownerId is string | null {
  return ownerId === null || typeof ownerId === 'string';
}

/**
 * Per F1-T9 plan: a pure fold mirroring `relation-replay.ts`'s /
 * `field-replay.ts`'s discipline — the stream must start with
 * `SavedViewCreated`, and every payload field it reads is validated
 * (`typeof`/known-`ViewType` guards) rather than trusted blindly (F1-T1
 * PR-A security-review hardening, repeated here). An unrecognized event
 * type after the first is a no-op (forward compatibility, same as
 * `replayRelation`'s / `replayFieldDefinition`'s `default: return state`
 * branch).
 */
export function replaySavedView(events: DomainEvent[]): SavedView {
  const [first, ...rest] = events;

  if (!first || first.type !== 'SavedViewCreated') {
    throw new InvalidObjectStateError('a saved-view event stream must start with SavedViewCreated');
  }

  let state = applySavedViewCreated(first);

  for (const event of rest) {
    state = applyEvent(state, event);
  }

  return state;
}

function applySavedViewCreated(event: DomainEvent): SavedView {
  const { savedViewId, workspaceId, objectType, name, icon, viewType, querySpec, ownerId } =
    event.payload;

  if (typeof savedViewId !== 'string' || savedViewId.length === 0) {
    throw new InvalidObjectStateError('SavedViewCreated event is missing a valid savedViewId');
  }

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new InvalidObjectStateError('SavedViewCreated event is missing a valid workspaceId');
  }

  if (typeof objectType !== 'string' || objectType.length === 0) {
    throw new InvalidObjectStateError('SavedViewCreated event is missing a valid objectType');
  }

  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidObjectStateError('SavedViewCreated event is missing a valid name');
  }

  if (typeof icon !== 'string' || icon.length === 0) {
    throw new InvalidObjectStateError('SavedViewCreated event is missing a valid icon');
  }

  if (!isKnownViewType(viewType)) {
    throw new InvalidObjectStateError('SavedViewCreated event has an invalid or unknown viewType');
  }

  if (typeof querySpec !== 'object' || querySpec === null) {
    throw new InvalidObjectStateError('SavedViewCreated event is missing a valid querySpec');
  }

  if (!isValidOwnerId(ownerId)) {
    throw new InvalidObjectStateError('SavedViewCreated event has an invalid ownerId');
  }

  const { dateField, startField, endField } = event.payload;

  return {
    id: savedViewId,
    workspaceId,
    objectType,
    name,
    icon,
    viewType,
    querySpec: querySpec as SavedView['querySpec'],
    dateField: typeof dateField === 'string' ? dateField : undefined,
    startField: typeof startField === 'string' ? startField : undefined,
    endField: typeof endField === 'string' ? endField : undefined,
    ownerId,
    lifecycle: 'active',
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

function applyEvent(state: SavedView, event: DomainEvent): SavedView {
  switch (event.type) {
    case 'SavedViewUpdated':
      return applySavedViewUpdated(state, event);
    case 'SavedViewDeleted':
      return applySavedViewDeleted(state, event);
    default:
      return state;
  }
}

function applySavedViewUpdated(state: SavedView, event: DomainEvent): SavedView {
  const { savedViewId, name, icon, querySpec, dateField, startField, endField } = event.payload;

  if (typeof savedViewId !== 'string' || savedViewId.length === 0) {
    throw new InvalidObjectStateError('SavedViewUpdated event is missing a valid savedViewId');
  }

  let next = state;

  if (name !== undefined) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidObjectStateError('SavedViewUpdated event has an invalid name');
    }
    next = { ...next, name };
  }

  if (icon !== undefined) {
    if (typeof icon !== 'string' || icon.length === 0) {
      throw new InvalidObjectStateError('SavedViewUpdated event has an invalid icon');
    }
    next = { ...next, icon };
  }

  if (querySpec !== undefined) {
    if (typeof querySpec !== 'object' || querySpec === null) {
      throw new InvalidObjectStateError('SavedViewUpdated event has an invalid querySpec');
    }
    next = { ...next, querySpec: querySpec as SavedView['querySpec'] };
  }

  if (dateField !== undefined) {
    if (typeof dateField !== 'string') {
      throw new InvalidObjectStateError('SavedViewUpdated event has an invalid dateField');
    }
    next = { ...next, dateField };
  }

  if (startField !== undefined) {
    if (typeof startField !== 'string') {
      throw new InvalidObjectStateError('SavedViewUpdated event has an invalid startField');
    }
    next = { ...next, startField };
  }

  if (endField !== undefined) {
    if (typeof endField !== 'string') {
      throw new InvalidObjectStateError('SavedViewUpdated event has an invalid endField');
    }
    next = { ...next, endField };
  }

  return { ...next, updatedAt: event.occurredAt };
}

function applySavedViewDeleted(state: SavedView, event: DomainEvent): SavedView {
  const { savedViewId } = event.payload;

  if (typeof savedViewId !== 'string' || savedViewId.length === 0) {
    throw new InvalidObjectStateError('SavedViewDeleted event is missing a valid savedViewId');
  }

  return { ...state, lifecycle: 'deleted', updatedAt: event.occurredAt };
}
