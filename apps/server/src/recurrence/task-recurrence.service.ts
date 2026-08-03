import { Injectable } from '@nestjs/common';

import {
  createObject,
  createRelation,
  newObjectId,
  type LuminaObject,
  type Relation,
} from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { deterministicUuid } from './deterministic-uuid.js';
import { TaskRecurrenceConsistencyError } from './task-recurrence-consistency.error.js';
import { EventStoreService } from '../event-store/event-store.service.js';

/**
 * Object-prototype keys that must never be accepted as a `fieldKey` — this
 * service (unlike `setFieldValue`) writes `FieldValueChanged` payloads
 * without a `FieldDefinition` allow-list, so a caller-supplied key landing on
 * `Object.prototype` would silently pollute any later `values[fieldKey] =
 * value` assignment in `field-value-replay.ts`'s consumer.
 */
const UNSAFE_FIELD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertValidInput(input: GenerateNextOccurrenceInput): void {
  if (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '') {
    throw new ValidationError('workspaceId must be a non-empty string');
  }

  if (typeof input.sourceObjectId !== 'string' || input.sourceObjectId.trim() === '') {
    throw new ValidationError('sourceObjectId must be a non-empty string');
  }

  if (typeof input.causationEventId !== 'string' || input.causationEventId.trim() === '') {
    throw new ValidationError('causationEventId must be a non-empty string');
  }

  for (const fieldKey of Object.keys(input.nextOccurrence.fieldValues)) {
    if (UNSAFE_FIELD_KEYS.has(fieldKey)) {
      throw new ValidationError('unsafe fieldKey in nextOccurrence.fieldValues', { fieldKey });
    }
  }
}

const STREAM_TYPE = 'lumina-object';

/**
 * `TaskRecurrenceService`'s fixed RFC 4122 v5 namespace salt (ADR-0010
 * §"(c) Layer B"). This MUST NEVER CHANGE once anything has been generated
 * with it in a real environment: changing it would re-derive different
 * stream/event ids for a `causationEventId` that already produced a
 * recurrence, breaking replay-idempotency for everything generated before
 * the change. Any valid UUID string works as the v5 namespace input — this
 * one carries no other meaning.
 */
const RECURRENCE_NAMESPACE_SALT = '9b4f6a2e-7c1d-4e5f-8a3b-2d6c9e1f4a70';

export interface GenerateNextOccurrenceInput {
  workspaceId: string;
  actor: Actor;
  /** The task that just transitioned to `isDone` (ADR-0010 §(f)). */
  sourceObjectId: string;
  /** The id of the triggering `FieldValueChanged` event (ADR-0010 §(c) Layer B). */
  causationEventId: string;
  nextOccurrence: {
    /** Copied from the source task, per ADR-0010 §(g). */
    title: string;
    /**
     * Copied custom field values (priority included), `status` already reset
     * by the caller to a non-`isDone` option — this service performs no
     * `isDone`-aware logic itself (ADR-0010 §(f)/(g)).
     */
    fieldValues: Record<string, unknown>;
  };
}

export interface GenerateNextOccurrenceResult {
  object: LuminaObject;
  fieldValues: Record<string, unknown>;
  relation: Relation;
}

/**
 * The cross-stream orchestration ADR-0010 §"(d) Orkestrasyon yeri" places
 * here, deliberately OUTSIDE `ObjectsService` — a `task`-specific business
 * rule ("status -> isDone yields a new task"), not a general
 * object-type-agnostic mechanism.
 *
 * Given a source task id, the id of the `FieldValueChanged` event that
 * carried the `isDone` transition, and an already-computed "next occurrence"
 * payload, writes EXACTLY one new `task` object (its own stream) and EXACTLY
 * one `recurrenceOf` relation (its own, separate stream) — idempotent when
 * invoked twice (sequentially or concurrently) with the same
 * `causationEventId`, per ADR-0010 §(c) Layer B: every stream id and event id
 * involved is deterministically derived from `causationEventId`, so a
 * repeated call rides `EventStoreService.append`'s own idempotent-replay
 * detection "for free" — no new idempotency-key infrastructure is invented.
 *
 * Does NOT itself detect the `status`/`isDone` false->true transition, does
 * not touch `relations_view`/`objects_view` projections, and is not wired
 * into `ObjectsService`/`RelationsService` yet — all separate, later-PR
 * concerns (ADR-0010 §(d), (f); this class's own test file's header note).
 */
@Injectable()
export class TaskRecurrenceService {
  constructor(private readonly eventStore: EventStoreService) {}

  async generateNextOccurrence(
    input: GenerateNextOccurrenceInput,
  ): Promise<GenerateNextOccurrenceResult> {
    assertValidInput(input);

    // `workspaceId` is folded into every derivation's name string (not just
    // `causationEventId` alone) so that a `causationEventId` collision across
    // two DIFFERENT workspaces (upstream bug, or a future less-trusted
    // caller) can never derive the same stream/event id and be silently
    // treated as an idempotent replay of the wrong workspace's data.
    const derivationScope = `${input.workspaceId}:${input.causationEventId}`;

    const objectStreamId = deterministicUuid(
      RECURRENCE_NAMESPACE_SALT,
      `recurrence-object:${derivationScope}`,
    );
    const relationStreamId = deterministicUuid(
      RECURRENCE_NAMESPACE_SALT,
      `recurrence-relation:${derivationScope}`,
    );
    const objectCreatedEventId = deterministicUuid(
      RECURRENCE_NAMESPACE_SALT,
      `recurrence-object-created:${derivationScope}`,
    );
    const relationCreatedEventId = deterministicUuid(
      RECURRENCE_NAMESPACE_SALT,
      `recurrence-relation-created:${derivationScope}`,
    );

    // Only a CANDIDATE value, used to build this call's own drafts. On a
    // replay (a second call with the same `causationEventId`), the ORIGINAL
    // stored events -- whose `objectId` may differ from this fresh candidate
    // -- are what `append` actually returns; the real result is always read
    // back from that response, never from this local variable (see below).
    const candidateObjectId = newObjectId();
    const now = new Date();

    const objectCreatedDrafts = createObject({
      objectId: candidateObjectId,
      workspaceId: input.workspaceId,
      objectType: 'task',
      title: input.nextOccurrence.title,
      actor: input.actor,
    });

    const objectCreatedEnvelopes: NewDomainEvent[] = objectCreatedDrafts.map((draft) => ({
      id: objectCreatedEventId,
      streamType: STREAM_TYPE,
      workspaceId: input.workspaceId,
      type: draft.type,
      payload: draft.payload,
      actor: input.actor,
      occurredAt: now,
    }));

    // One deterministic event id per field entry, independently derived from
    // `fieldKey` -- `Object.entries` guarantees stable insertion order for
    // string keys, which is what keeps these ids lined up on replay.
    const fieldValueEnvelopes: NewDomainEvent[] = Object.entries(
      input.nextOccurrence.fieldValues,
    ).map(([fieldKey, value]) => ({
      id: deterministicUuid(
        RECURRENCE_NAMESPACE_SALT,
        `recurrence-field:${derivationScope}:${fieldKey}`,
      ),
      streamType: STREAM_TYPE,
      workspaceId: input.workspaceId,
      type: 'FieldValueChanged',
      payload: { objectId: candidateObjectId, fieldKey, value },
      actor: input.actor,
      occurredAt: now,
    }));

    const appendedObjectEvents = await this.eventStore.append(objectStreamId, 0, [
      ...objectCreatedEnvelopes,
      ...fieldValueEnvelopes,
    ]);

    const objectCreatedStoredEvent = appendedObjectEvents[0];

    if (!objectCreatedStoredEvent) {
      throw new TaskRecurrenceConsistencyError(
        'EventStoreService.append returned no events for the recurring task object stream.',
      );
    }

    if (objectCreatedStoredEvent.workspaceId !== input.workspaceId) {
      // Only reachable if a `causationEventId`/`workspaceId` derivation
      // collided with another workspace's stream — see the `derivationScope`
      // comment above. Trusting `objectCreatedStoredEvent` past this point
      // would leak a foreign workspace's object into this result.
      throw new TaskRecurrenceConsistencyError(
        'Recurring task object stream resolved to an unexpected workspace.',
      );
    }

    const objectIdPayload = objectCreatedStoredEvent.payload;

    if (typeof objectIdPayload.objectId !== 'string' || objectIdPayload.objectId.length === 0) {
      throw new TaskRecurrenceConsistencyError(
        'Recurring task ObjectCreated event is missing a valid objectId.',
      );
    }

    const objectId = objectIdPayload.objectId;

    const relationDrafts = createRelation(
      {
        relationId: newObjectId(),
        workspaceId: input.workspaceId,
        fromId: input.sourceObjectId,
        toId: objectId,
        kind: 'recurrenceOf',
        causationEventId: input.causationEventId,
      },
      [],
    );

    const relationEnvelopes: NewDomainEvent[] = relationDrafts.map((draft) => ({
      id: relationCreatedEventId,
      streamType: STREAM_TYPE,
      workspaceId: input.workspaceId,
      type: draft.type,
      payload: draft.payload,
      actor: input.actor,
      occurredAt: now,
    }));

    const appendedRelationEvents = await this.eventStore.append(
      relationStreamId,
      0,
      relationEnvelopes,
    );
    const relationCreatedStoredEvent = appendedRelationEvents[0];

    if (!relationCreatedStoredEvent) {
      throw new TaskRecurrenceConsistencyError(
        'EventStoreService.append returned no events for the recurring task relation stream.',
      );
    }

    if (relationCreatedStoredEvent.workspaceId !== input.workspaceId) {
      throw new TaskRecurrenceConsistencyError(
        'Recurring task relation stream resolved to an unexpected workspace.',
      );
    }

    const relationEventPayload = relationCreatedStoredEvent.payload;

    if (
      typeof relationEventPayload.relationId !== 'string' ||
      relationEventPayload.relationId.length === 0 ||
      typeof relationEventPayload.fromId !== 'string' ||
      relationEventPayload.fromId.length === 0 ||
      typeof relationEventPayload.toId !== 'string' ||
      relationEventPayload.toId.length === 0
    ) {
      throw new TaskRecurrenceConsistencyError(
        'Recurring task RelationCreated event is missing valid relationId/fromId/toId.',
      );
    }

    const relationPayload = {
      relationId: relationEventPayload.relationId,
      fromId: relationEventPayload.fromId,
      toId: relationEventPayload.toId,
    };

    const object: LuminaObject = {
      id: objectId,
      type: 'task',
      workspaceId: input.workspaceId,
      title: input.nextOccurrence.title,
      createdBy: input.actor.id,
      createdAt: objectCreatedStoredEvent.occurredAt,
      updatedAt: objectCreatedStoredEvent.occurredAt,
      lifecycle: 'active',
      checklist: [],
    };

    const relation: Relation = {
      id: relationPayload.relationId,
      workspaceId: input.workspaceId,
      fromId: relationPayload.fromId,
      toId: relationPayload.toId,
      kind: 'recurrenceOf',
      status: 'active',
      createdAt: relationCreatedStoredEvent.occurredAt,
      updatedAt: relationCreatedStoredEvent.occurredAt,
      causationEventId: input.causationEventId,
    };

    return {
      object,
      fieldValues: input.nextOccurrence.fieldValues,
      relation,
    };
  }
}
