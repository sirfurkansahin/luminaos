import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent } from '@luminaos/shared';

import type { Relation, RelationKind } from './relation.js';

const KNOWN_RELATION_KINDS: readonly RelationKind[] = ['parentChild', 'reference', 'dependency'];

function isKnownRelationKind(kind: unknown): kind is RelationKind {
  return typeof kind === 'string' && (KNOWN_RELATION_KINDS as readonly string[]).includes(kind);
}

/**
 * Per F1-T3 plan: a pure fold mirroring `replay.ts`'s / `field-replay.ts`'s
 * discipline — the stream must start with `RelationCreated`, and every
 * payload field it reads is validated (`typeof`/known-`RelationKind` guards)
 * rather than trusted blindly (F1-T1 PR-A security-review hardening,
 * repeated here for F1-T3). An unrecognized event type after the first is a
 * no-op (forward compatibility, same as `replayObject`'s /
 * `replayFieldDefinition`'s `default: return state` branch).
 */
export function replayRelation(events: DomainEvent[]): Relation {
  const [first, ...rest] = events;

  if (!first || first.type !== 'RelationCreated') {
    throw new InvalidObjectStateError('a relation event stream must start with RelationCreated');
  }

  let state = applyRelationCreated(first);

  for (const event of rest) {
    state = applyEvent(state, event);
  }

  return state;
}

function applyRelationCreated(event: DomainEvent): Relation {
  const { relationId, workspaceId, fromId, toId, kind } = event.payload;

  if (typeof relationId !== 'string' || relationId.length === 0) {
    throw new InvalidObjectStateError('RelationCreated event is missing a valid relationId');
  }

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new InvalidObjectStateError('RelationCreated event is missing a valid workspaceId');
  }

  if (typeof fromId !== 'string' || fromId.length === 0) {
    throw new InvalidObjectStateError('RelationCreated event is missing a valid fromId');
  }

  if (typeof toId !== 'string' || toId.length === 0) {
    throw new InvalidObjectStateError('RelationCreated event is missing a valid toId');
  }

  if (!isKnownRelationKind(kind)) {
    throw new InvalidObjectStateError('RelationCreated event has an invalid or unknown kind');
  }

  return {
    id: relationId,
    workspaceId,
    fromId,
    toId,
    kind,
    status: 'active',
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

function applyEvent(state: Relation, event: DomainEvent): Relation {
  switch (event.type) {
    case 'RelationRemoved':
      return applyRelationRemoved(state, event);
    default:
      return state;
  }
}

function applyRelationRemoved(state: Relation, event: DomainEvent): Relation {
  const { relationId } = event.payload;

  if (typeof relationId !== 'string' || relationId.length === 0) {
    throw new InvalidObjectStateError('RelationRemoved event is missing a valid relationId');
  }

  return { ...state, status: 'removed', updatedAt: event.occurredAt };
}
