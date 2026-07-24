import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';

import {
  archiveObject,
  createObject,
  newObjectId,
  renameObject,
  replayObject,
  restoreObject,
  softDeleteObject,
} from '@luminaos/core-objects';
import type { LuminaObject, ObjectEventDraft, ObjectType } from '@luminaos/core-objects';
import { NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { ObjectsViewProjection } from './objects-view.projection.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { objectsView } from '../db/schema/objects-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const STREAM_TYPE = 'lumina-object';

@Injectable()
export class ObjectsService {
  /**
   * A single, stable `ObjectsViewProjection` instance for this service's
   * lifetime — `ProjectionRunner.catchUp` checkpoints by `projection.name`,
   * not by instance identity, but reusing one instance (rather than
   * constructing a fresh one per call) avoids any doubt about that and
   * matches the "stable instance" requirement.
   */
  private readonly projection = new ObjectsViewProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async create(
    workspaceId: string,
    actor: Actor,
    input: { objectType: ObjectType; title: string },
  ): Promise<LuminaObject> {
    const objectId = newObjectId();
    const streamId = randomUUID();

    const drafts = createObject({
      objectId,
      workspaceId,
      objectType: input.objectType,
      title: input.title,
      actor,
    });

    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, 0, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replayObject(appended);
  }

  async rename(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    input: { title: string },
  ): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => renameObject(state, input));
  }

  async archive(workspaceId: string, objectId: string, actor: Actor): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => archiveObject(state));
  }

  async restore(workspaceId: string, objectId: string, actor: Actor): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => restoreObject(state));
  }

  async softDelete(workspaceId: string, objectId: string, actor: Actor): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => softDeleteObject(state));
  }

  async get(workspaceId: string, objectId: string): Promise<LuminaObject> {
    const [row] = await this.db
      .select()
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Lumina Object not found');
    }

    return this.toLuminaObject(row);
  }

  async list(workspaceId: string): Promise<LuminaObject[]> {
    const rows = await this.db
      .select()
      .from(objectsView)
      .where(and(eq(objectsView.workspaceId, workspaceId), ne(objectsView.lifecycle, 'deleted')));

    return rows
      .map((row) => this.toLuminaObject(row))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * The shared write path for every command except `create`: resolves
   * `objectId -> streamId` via `objects_view` (existence + workspace-scope
   * in one lookup, per ADR-0003), replays the authoritative state from the
   * real event stream (never from the projection), invokes the given domain
   * command, appends the resulting draft(s), synchronously catches the
   * `objects_view` projection up, and returns the freshly replayed state.
   */
  private async applyCommand(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    command: (state: LuminaObject) => ObjectEventDraft[],
  ): Promise<LuminaObject> {
    const streamId = await this.lookupStreamId(workspaceId, objectId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replayObject(priorEvents);

    const drafts = command(state);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replayObject([...priorEvents, ...appended]);
  }

  private async lookupStreamId(workspaceId: string, objectId: string): Promise<string> {
    const [row] = await this.db
      .select({ streamId: objectsView.streamId })
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Lumina Object not found');
    }

    return row.streamId;
  }

  private wrapDrafts(
    drafts: ObjectEventDraft[],
    workspaceId: string,
    actor: Actor,
  ): NewDomainEvent[] {
    const occurredAt = new Date();

    return drafts.map((draft) => ({
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId,
      type: draft.type,
      payload: draft.payload,
      actor,
      occurredAt,
    }));
  }

  private toLuminaObject(row: typeof objectsView.$inferSelect): LuminaObject {
    return {
      id: row.id,
      type: row.type as ObjectType,
      workspaceId: row.workspaceId,
      title: row.title,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lifecycle: row.lifecycle as LuminaObject['lifecycle'],
    };
  }
}
