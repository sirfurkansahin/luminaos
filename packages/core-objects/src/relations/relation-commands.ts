import { ConflictError, InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import { findDependencyCycle, findParentCycle } from './relation-graph.js';

import type { Relation, RelationKind } from './relation.js';

const KNOWN_RELATION_KINDS: readonly RelationKind[] = [
  'parentChild',
  'reference',
  'dependency',
  'recurrenceOf',
];

function isKnownRelationKind(kind: string): kind is RelationKind {
  return (KNOWN_RELATION_KINDS as readonly string[]).includes(kind);
}

/**
 * A draft of a relation domain event, not yet wrapped into the F0-T6
 * `NewDomainEvent` envelope — same shape as F1-T1's `ObjectEventDraft` /
 * F1-T2's `FieldEventDraft` (that wrapping is the server layer's job).
 */
export interface RelationEventDraft {
  type: string;
  payload: Record<string, unknown>;
}

export interface CreateRelationInput {
  relationId: string;
  workspaceId: string;
  fromId: string;
  toId: string;
  kind: RelationKind;
  causationEventId?: string;
}

export function createRelation(
  input: CreateRelationInput,
  existingRelations: Relation[],
): RelationEventDraft[] {
  if (input.fromId === input.toId) {
    throw new ValidationError('a relation cannot connect an object to itself', {
      fromId: input.fromId,
      toId: input.toId,
    });
  }

  const kind: string = input.kind;

  if (!isKnownRelationKind(kind)) {
    throw new ValidationError('unknown relation kind', { kind });
  }

  if (kind === 'parentChild') {
    const existingParent = existingRelations.find(
      (relation) =>
        relation.status === 'active' &&
        relation.kind === 'parentChild' &&
        relation.toId === input.toId,
    );

    if (existingParent) {
      throw new ConflictError('this object already has an active parent');
    }

    const cycle = findParentCycle(
      existingRelations.filter((relation) => relation.kind === 'parentChild'),
      input.fromId,
      input.toId,
    );

    if (cycle) {
      throw new ValidationError('this parentChild relation would create a cycle', { cycle });
    }
  }

  if (kind === 'dependency') {
    const cycle = findDependencyCycle(
      existingRelations.filter((relation) => relation.kind === 'dependency'),
      input.fromId,
      input.toId,
    );

    if (cycle) {
      throw new ValidationError('this dependency relation would create a cycle', { cycle });
    }
  }

  if (kind === 'reference') {
    const duplicate = existingRelations.find(
      (relation) =>
        relation.status === 'active' &&
        relation.kind === 'reference' &&
        ((relation.fromId === input.fromId && relation.toId === input.toId) ||
          (relation.fromId === input.toId && relation.toId === input.fromId)),
    );

    if (duplicate) {
      throw new ConflictError('a reference relation between these objects already exists');
    }
  }

  return [
    {
      type: 'RelationCreated',
      payload: {
        relationId: input.relationId,
        workspaceId: input.workspaceId,
        fromId: input.fromId,
        toId: input.toId,
        kind: input.kind,
        ...(input.causationEventId !== undefined
          ? { causationEventId: input.causationEventId }
          : {}),
      },
    },
  ];
}

export function removeRelation(state: Relation): RelationEventDraft[] {
  if (state.status === 'removed') {
    throw new InvalidObjectStateError('relation is already removed', {
      relationId: state.id,
      status: state.status,
      attemptedAction: 'remove',
    });
  }

  return [{ type: 'RelationRemoved', payload: { relationId: state.id } }];
}
