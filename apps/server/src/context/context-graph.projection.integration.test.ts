import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, isNull, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';
import type { Actor, NewDomainEvent, ProjectionTx } from '@luminaos/shared';

import { ContextGraphProjection } from './context-graph.projection.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { contextGraphEdges } from '../db/schema/context-graph-edges.js';
import { contextGraphNodes } from '../db/schema/context-graph-nodes.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F2-T1 (RED step). `context_graph_nodes`/`context_graph_edges`/
 * `ContextGraphProjection` do NOT exist yet as of this commit -- every import
 * above pointing at `./context-graph.projection.js`,
 * `../db/schema/context-graph-nodes.js`, `../db/schema/context-graph-edges.js`
 * is EXPECTED to fail to resolve (module-not-found), and this whole file is
 * expected to fail to even compile/run until `implementer` lands:
 *
 *   - `apps/server/src/db/schema/context-graph-nodes.ts` (`contextGraphNodes`)
 *   - `apps/server/src/db/schema/context-graph-edges.ts` (`contextGraphEdges`)
 *   - `apps/server/src/context/context-graph.projection.ts`
 *     (`ContextGraphProjection`)
 *   - a matching Drizzle migration pair for both new tables
 *
 * This is the FIRST direct test file for the bag-of-decisions ADR-0017 lands
 * (Karar a-h): node/edge schema, topic derivation (rule-based, Karar b),
 * field-type awareness kept INTERNAL to this projection (no cross-projection
 * read of `field_definitions`, Karar c), `entity-topic` delete-then-add full
 * refresh on `FieldValueChanged` (Karar d), day-granularity time buckets
 * (Karar e), materialized (not view) storage (Karar f), `person` nodes only
 * for `actor.type === 'user'` while `entity`/`entity-time` still fold for
 * `agent`/`system` actors (Karar g), and the exact `handles` list + single-PR
 * scope (Karar h: no live service wiring in this PR, only
 * `projectionRunner.catchUp`/`rebuild` driven directly by these tests).
 *
 * Mirrors `event-store/projections/projection-rebuild.integration.test.ts`'s
 * LIGHTWEIGHT Testcontainers harness exactly (no full Nest app boot, direct
 * `new EventStoreService(db)` / `new ProjectionRunner(db, eventStore)` /
 * `new ContextGraphProjection()`, local `createWorkspace` + event-building
 * helpers) and `ai/ai-usage.projection.integration.test.ts`'s doc-comment
 * style for flagging the designed-but-not-yet-implemented contract.
 *
 * Real payload shapes below were verified against existing producers, NOT
 * guessed:
 *   - `ObjectCreated`/`ObjectSoftDeleted`/`ObjectRestored`/`FieldValueChanged`:
 *     `apps/server/src/objects/objects-view.projection.ts` (the cases at
 *     ~line 306-400). Notably `ObjectRestored`'s payload carries ONLY
 *     `objectId` -- no `objectType` -- which is why the restore test below
 *     only asserts the entity node exists again, not that its `objectType`
 *     column is repopulated or that its old edges come back (ADR-0017's own
 *     accepted restore limitation).
 *   - `RelationCreated`/`RelationRemoved`: `apps/server/src/relations/
 *     relations.projection.ts` plus `packages/core-objects/src/relations/
 *     relation-commands.ts`'s `removeRelation` -- confirms `RelationRemoved`'s
 *     payload is `{ relationId }` ONLY (no `fromId`/`toId`). Since
 *     `context_graph_edges` has no `relationId` column in ADR-0017's pinned
 *     schema, whatever internal bookkeeping `ContextGraphProjection` uses to
 *     resolve "which entity-entity edge does this relationId correspond to"
 *     is entirely `implementer`'s choice (mirrors Karar c's "storage
 *     mechanism is an implementer-level detail" allowance for field-type
 *     awareness) -- the test below only asserts the OBSERVABLE outcome (the
 *     edge between two independently-verified entity nodes is gone), never
 *     an internal tracking column.
 *   - `FieldDefined`/`FieldArchived`: `apps/server/src/fields/
 *     field-definitions.projection.ts`.
 *
 * Several `describe` blocks below are INTENTIONALLY STATEFUL/sequential
 * (later `it`s build on rows an earlier `it` in the same block created) --
 * same convention `event-store/projections/projection-rebuild.integration.test.ts`'s
 * "AC4" chain and `ai/ai-usage.projection.integration.test.ts` already use.
 * Vitest runs `it`s within one file in declaration order by default (no
 * `test.concurrent` is used anywhere here), which this file relies on --
 * most importantly, the LAST `describe` block (rebuild determinism) is
 * placed last on purpose, so it snapshots the cumulative graph every earlier
 * block already built.
 */

const OBJECT_STREAM_TYPE = 'lumina-object';
const RELATION_STREAM_TYPE = 'relation';
const FIELD_DEFINITION_STREAM_TYPE = 'field-definition';

const EDIT_ALL_PERMISSIONS = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
} as const;

describe('ContextGraphProjection (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let projection: ContextGraphProjection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);
    projection = new ContextGraphProjection();
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(name: string): Promise<string> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name, slug: crypto.randomUUID() })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  /** Builds a `NewDomainEvent` for a fresh (or existing) stream. `occurredAt` defaults to "now" when the test doesn't care about time-bucketing. */
  function buildEvent(params: {
    workspaceId: string;
    streamType: string;
    type: string;
    payload: Record<string, unknown>;
    actor: Actor;
    occurredAt?: Date;
  }): NewDomainEvent {
    return {
      id: crypto.randomUUID(),
      streamType: params.streamType,
      workspaceId: params.workspaceId,
      type: params.type,
      payload: params.payload,
      actor: params.actor,
      occurredAt: params.occurredAt ?? new Date(),
    } satisfies NewDomainEvent;
  }

  /** Drives this file's single, shared `ContextGraphProjection` instance's incremental catch-up. */
  async function catchUp(): Promise<void> {
    await projectionRunner.catchUp(projection);
  }

  async function findNode(
    workspaceId: string,
    nodeType: string,
    naturalKey: string,
  ): Promise<typeof contextGraphNodes.$inferSelect | undefined> {
    const rows = await db
      .select()
      .from(contextGraphNodes)
      .where(
        and(
          eq(contextGraphNodes.workspaceId, workspaceId),
          eq(contextGraphNodes.nodeType, nodeType),
          eq(contextGraphNodes.naturalKey, naturalKey),
        ),
      );
    return rows[0];
  }

  async function findEdge(
    workspaceId: string,
    edgeType: string,
    fromNodeId: string,
    toNodeId: string,
    sourceFieldKey: string | null,
  ): Promise<typeof contextGraphEdges.$inferSelect | undefined> {
    const rows = await db
      .select()
      .from(contextGraphEdges)
      .where(
        and(
          eq(contextGraphEdges.workspaceId, workspaceId),
          eq(contextGraphEdges.edgeType, edgeType),
          eq(contextGraphEdges.fromNodeId, fromNodeId),
          eq(contextGraphEdges.toNodeId, toNodeId),
          sourceFieldKey === null
            ? isNull(contextGraphEdges.sourceFieldKey)
            : eq(contextGraphEdges.sourceFieldKey, sourceFieldKey),
        ),
      );
    return rows[0];
  }

  async function countNodes(workspaceId: string): Promise<number> {
    const rows = await db
      .select({ id: contextGraphNodes.id })
      .from(contextGraphNodes)
      .where(eq(contextGraphNodes.workspaceId, workspaceId));
    return rows.length;
  }

  async function countEdges(workspaceId: string): Promise<number> {
    const rows = await db
      .select({ id: contextGraphEdges.id })
      .from(contextGraphEdges)
      .where(eq(contextGraphEdges.workspaceId, workspaceId));
    return rows.length;
  }

  /**
   * Full-graph snapshot keyed by LOGICAL identity (node: workspace+type+
   * naturalKey; edge: workspace+type+endpoints' logical identity+
   * sourceFieldKey) rather than raw ULID `id` columns -- ids are regenerated
   * on `rebuild` (fresh `INSERT`s), so comparing them directly would always
   * fail even for a perfectly deterministic rebuild. Used by the rebuild
   * determinism block at the bottom of this file.
   */
  async function snapshotGraph(): Promise<{ nodeKeys: string[]; edgeKeys: string[] }> {
    const nodes = await db.select().from(contextGraphNodes);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    const nodeKeys = nodes
      .map((node) => `${node.workspaceId}|${node.nodeType}|${node.naturalKey}`)
      .sort();

    const edges = await db.select().from(contextGraphEdges);
    const edgeKeys = edges
      .map((edge) => {
        const from = nodeById.get(edge.fromNodeId);
        const to = nodeById.get(edge.toNodeId);
        return `${edge.workspaceId}|${edge.edgeType}|${from?.nodeType ?? '?'}:${from?.naturalKey ?? '?'}->${to?.nodeType ?? '?'}:${to?.naturalKey ?? '?'}|${edge.sourceFieldKey ?? ''}`;
      })
      .sort();

    return { nodeKeys, edgeKeys };
  }

  describe('ObjectCreated: entity/person/time/topic(type-based) derivation (ADR-0017 Karar a, b, e, g)', () => {
    let workspaceId: string;

    beforeAll(async () => {
      workspaceId = await createWorkspace('context-graph-object-created');
    });

    it('creates an entity node with nodeType="entity", naturalKey=objectId, objectType=payload.objectType', async () => {
      const objectId = newObjectId();
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'task', title: 'Write ADR' },
          actor: { type: 'user', id: 'user-alice' },
          occurredAt: new Date('2026-03-15T10:00:00Z'),
        }),
      ]);
      await catchUp();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      expect(entityNode).toBeDefined();
      expect(entityNode?.objectType).toBe('task');
    });

    it('creates a person node + entity-person edge when actor.type is "user"', async () => {
      const objectId = newObjectId();
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'task', title: 'x' },
          actor: { type: 'user', id: 'user-bob' },
        }),
      ]);
      await catchUp();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      const personNode = await findNode(workspaceId, 'person', 'user-bob');
      expect(personNode).toBeDefined();

      const edge =
        entityNode && personNode
          ? await findEdge(workspaceId, 'entity-person', entityNode.id, personNode.id, null)
          : undefined;
      expect(edge).toBeDefined();
    });

    it('does NOT create a person node/edge for actor.type "agent", but still creates entity/time/topic nodes', async () => {
      const objectId = newObjectId();
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'task', title: 'x' },
          actor: { type: 'agent', id: 'agent-command-parser' },
          occurredAt: new Date('2026-03-16T12:00:00Z'),
        }),
      ]);
      await catchUp();

      expect(await findNode(workspaceId, 'person', 'agent-command-parser')).toBeUndefined();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      const timeNode = await findNode(workspaceId, 'time', '2026-03-16');
      const topicNode = await findNode(workspaceId, 'topic', 'task');
      expect(entityNode).toBeDefined();
      expect(timeNode).toBeDefined();
      expect(topicNode).toBeDefined();

      const timeEdge =
        entityNode && timeNode
          ? await findEdge(workspaceId, 'entity-time', entityNode.id, timeNode.id, null)
          : undefined;
      expect(timeEdge).toBeDefined();
    });

    it('does NOT create a person node/edge for actor.type "system", but still creates entity/time/topic nodes', async () => {
      const objectId = newObjectId();
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'doc', title: 'x' },
          actor: { type: 'system', id: 'formula-engine' },
          occurredAt: new Date('2026-03-17T08:00:00Z'),
        }),
      ]);
      await catchUp();

      expect(await findNode(workspaceId, 'person', 'formula-engine')).toBeUndefined();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      const timeNode = await findNode(workspaceId, 'time', '2026-03-17');
      const topicNode = await findNode(workspaceId, 'topic', 'doc');
      expect(entityNode).toBeDefined();
      expect(timeNode).toBeDefined();
      expect(topicNode).toBeDefined();
    });

    it('buckets the time node to the UTC calendar day of occurredAt and creates an entity-time edge', async () => {
      const objectId = newObjectId();
      const streamId = crypto.randomUUID();
      const occurredAt = new Date('2026-03-18T23:59:59Z');

      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'task', title: 'x' },
          actor: { type: 'user', id: 'user-carol' },
          occurredAt,
        }),
      ]);
      await catchUp();

      const timeNode = await findNode(workspaceId, 'time', '2026-03-18');
      expect(timeNode).toBeDefined();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      const edge =
        entityNode && timeNode
          ? await findEdge(workspaceId, 'entity-time', entityNode.id, timeNode.id, null)
          : undefined;
      expect(edge).toBeDefined();
    });

    it('two objects created on the same UTC day share a single time node', async () => {
      const objectIdA = newObjectId();
      const objectIdB = newObjectId();
      const streamA = crypto.randomUUID();
      const streamB = crypto.randomUUID();

      await eventStore.append(streamA, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: objectIdA, objectType: 'note', title: 'a' },
          actor: { type: 'user', id: 'user-dave' },
          occurredAt: new Date('2026-04-01T01:00:00Z'),
        }),
      ]);
      await eventStore.append(streamB, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: objectIdB, objectType: 'note', title: 'b' },
          actor: { type: 'user', id: 'user-dave' },
          occurredAt: new Date('2026-04-01T22:00:00Z'),
        }),
      ]);
      await catchUp();

      const timeNodesForDay = await db
        .select()
        .from(contextGraphNodes)
        .where(
          and(
            eq(contextGraphNodes.workspaceId, workspaceId),
            eq(contextGraphNodes.nodeType, 'time'),
            eq(contextGraphNodes.naturalKey, '2026-04-01'),
          ),
        );
      expect(timeNodesForDay).toHaveLength(1);
    });

    it('creates a type-based topic node (naturalKey=objectType) + entity-topic edge with sourceFieldKey NULL', async () => {
      const objectId = newObjectId();
      const streamId = crypto.randomUUID();

      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'timeblock', title: 'x' },
          actor: { type: 'user', id: 'user-erin' },
        }),
      ]);
      await catchUp();

      const topicNode = await findNode(workspaceId, 'topic', 'timeblock');
      expect(topicNode).toBeDefined();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      const edge =
        entityNode && topicNode
          ? await findEdge(workspaceId, 'entity-topic', entityNode.id, topicNode.id, null)
          : undefined;
      expect(edge).toBeDefined();
    });

    it('is idempotent: folding the identical ObjectCreated event twice does not duplicate rows or throw', async () => {
      const objectId = newObjectId();
      const streamId = crypto.randomUUID();
      const event = buildEvent({
        workspaceId,
        streamType: OBJECT_STREAM_TYPE,
        type: 'ObjectCreated',
        payload: { objectId, objectType: 'task', title: 'dup' },
        actor: { type: 'user', id: 'user-frank' },
      });

      const [stored] = await eventStore.append(streamId, 0, [event]);
      if (!stored) {
        throw new Error('append returned no stored event');
      }

      let caught: unknown;
      await db.transaction(async (tx) => {
        try {
          // `ProjectionTx` is intentionally opaque at the `packages/shared`
          // level (framework-free); this cast mirrors every concrete
          // projection's own `asDbTransaction`-style cast (see
          // `relations.projection.ts`) and the SAME pattern already used by
          // `search-index.projection.integration.test.ts`/
          // `ai-usage.projection.integration.test.ts`'s direct-`apply()`
          // tests. NOTE (RED-state artifact): because `ContextGraphProjection`
          // does not exist yet, this cast currently resolves through an
          // unresolved-module error type, which makes ESLint's
          // `no-unnecessary-type-assertion` autofixer (incorrectly) strip
          // this exact cast on every `eslint --fix` pass until `implementer`
          // creates the real `context-graph.projection.ts` — at which point
          // the cast becomes genuinely necessary again (a real
          // `PgTransaction` is not assignable to `ProjectionTx` without it)
          // and this disable comment stops the same autofixer from
          // re-stripping it once real types are in place.

          await projection.apply(stored, tx as unknown as ProjectionTx);

          await projection.apply(stored, tx as unknown as ProjectionTx);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeUndefined();

      const entityNodes = await db
        .select()
        .from(contextGraphNodes)
        .where(
          and(
            eq(contextGraphNodes.workspaceId, workspaceId),
            eq(contextGraphNodes.nodeType, 'entity'),
            eq(contextGraphNodes.naturalKey, objectId),
          ),
        );
      expect(entityNodes).toHaveLength(1);
    });
  });

  describe('ADR-0017 Karar c: FieldDefined/FieldArchived produce no observable node/edge rows by themselves', () => {
    let workspaceId: string;

    beforeAll(async () => {
      workspaceId = await createWorkspace('context-graph-field-defined');
    });

    it('FieldDefined alone (no ObjectCreated/FieldValueChanged in this workspace) creates zero context_graph rows', async () => {
      const streamId = crypto.randomUUID();
      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: FIELD_DEFINITION_STREAM_TYPE,
          type: 'FieldDefined',
          payload: {
            fieldDefinitionId: newObjectId(),
            workspaceId,
            objectType: 'task',
            key: 'status',
            fieldType: 'select',
            label: 'Status',
            permissions: EDIT_ALL_PERMISSIONS,
          },
          actor: { type: 'user', id: 'user-grace' },
        }),
      ]);
      await catchUp();

      expect(await countNodes(workspaceId)).toBe(0);
      expect(await countEdges(workspaceId)).toBe(0);
    });

    it('FieldArchived does not throw and produces no observable node/edge change (accepted ADR-0017 limitation: no stale entity-topic cleanup)', async () => {
      const streamId = crypto.randomUUID();
      await eventStore.append(streamId, 0, [
        buildEvent({
          workspaceId,
          streamType: FIELD_DEFINITION_STREAM_TYPE,
          type: 'FieldArchived',
          payload: { fieldDefinitionId: newObjectId() },
          actor: { type: 'user', id: 'user-grace' },
        }),
      ]);

      await expect(catchUp()).resolves.not.toThrow();

      expect(await countNodes(workspaceId)).toBe(0);
      expect(await countEdges(workspaceId)).toBe(0);
    });
  });

  describe('FieldValueChanged (select/multiSelect): topic derivation + full-refresh semantics (ADR-0017 Karar b, c, d)', () => {
    let workspaceId: string;
    let objectId: string;
    let entityNodeId: string;

    beforeAll(async () => {
      workspaceId = await createWorkspace('context-graph-field-value-changed');

      // Field-type awareness precondition (Karar c): `FieldDefined` must be
      // folded BEFORE a `FieldValueChanged` that depends on it, so this
      // projection's own internal (workspaceId, objectType, key) -> fieldType
      // knowledge is populated by the time `FieldValueChanged` arrives.
      const statusFieldStream = crypto.randomUUID();
      await eventStore.append(statusFieldStream, 0, [
        buildEvent({
          workspaceId,
          streamType: FIELD_DEFINITION_STREAM_TYPE,
          type: 'FieldDefined',
          payload: {
            fieldDefinitionId: newObjectId(),
            workspaceId,
            objectType: 'task',
            key: 'status',
            fieldType: 'select',
            label: 'Status',
            permissions: EDIT_ALL_PERMISSIONS,
          },
          actor: { type: 'user', id: 'user-field-admin' },
        }),
      ]);

      const priorityFieldStream = crypto.randomUUID();
      await eventStore.append(priorityFieldStream, 0, [
        buildEvent({
          workspaceId,
          streamType: FIELD_DEFINITION_STREAM_TYPE,
          type: 'FieldDefined',
          payload: {
            fieldDefinitionId: newObjectId(),
            workspaceId,
            objectType: 'task',
            key: 'priority',
            fieldType: 'multiSelect',
            label: 'Priority',
            permissions: EDIT_ALL_PERMISSIONS,
          },
          actor: { type: 'user', id: 'user-field-admin' },
        }),
      ]);

      const notesFieldStream = crypto.randomUUID();
      await eventStore.append(notesFieldStream, 0, [
        buildEvent({
          workspaceId,
          streamType: FIELD_DEFINITION_STREAM_TYPE,
          type: 'FieldDefined',
          payload: {
            fieldDefinitionId: newObjectId(),
            workspaceId,
            objectType: 'task',
            key: 'notes',
            fieldType: 'text',
            label: 'Notes',
            permissions: EDIT_ALL_PERMISSIONS,
          },
          actor: { type: 'user', id: 'user-field-admin' },
        }),
      ]);

      objectId = newObjectId();
      const objectStream = crypto.randomUUID();
      await eventStore.append(objectStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'task', title: 'Ship it' },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);

      await catchUp();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      if (!entityNode) {
        throw new Error('entity node not found after ObjectCreated catchUp (setup)');
      }
      entityNodeId = entityNode.id;
    });

    it('a select FieldValueChanged creates one topic node + entity-topic edge with sourceFieldKey=fieldKey', async () => {
      const stream = crypto.randomUUID();
      await eventStore.append(stream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'status', value: 'bug' },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const topicNode = await findNode(workspaceId, 'topic', 'bug');
      expect(topicNode).toBeDefined();

      const edge = topicNode
        ? await findEdge(workspaceId, 'entity-topic', entityNodeId, topicNode.id, 'status')
        : undefined;
      expect(edge).toBeDefined();
    });

    it('a multiSelect FieldValueChanged creates one topic node + edge PER array value, all sharing the same sourceFieldKey', async () => {
      const stream = crypto.randomUUID();
      await eventStore.append(stream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'priority', value: ['urgent', 'blocked'] },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const urgentNode = await findNode(workspaceId, 'topic', 'urgent');
      const blockedNode = await findNode(workspaceId, 'topic', 'blocked');
      expect(urgentNode).toBeDefined();
      expect(blockedNode).toBeDefined();

      const urgentEdge = urgentNode
        ? await findEdge(workspaceId, 'entity-topic', entityNodeId, urgentNode.id, 'priority')
        : undefined;
      const blockedEdge = blockedNode
        ? await findEdge(workspaceId, 'entity-topic', entityNodeId, blockedNode.id, 'priority')
        : undefined;
      expect(urgentEdge).toBeDefined();
      expect(blockedEdge).toBeDefined();
    });

    it('a SECOND select FieldValueChanged with a different value replaces the entity-topic edge (Karar d full-refresh): old value edge gone, new value edge present', async () => {
      const firstStream = crypto.randomUUID();
      await eventStore.append(firstStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'status', value: 'bug' },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const secondStream = crypto.randomUUID();
      await eventStore.append(secondStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'status', value: 'feature' },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const bugNode = await findNode(workspaceId, 'topic', 'bug');
      const featureNode = await findNode(workspaceId, 'topic', 'feature');
      expect(featureNode).toBeDefined();

      const staleEdge = bugNode
        ? await findEdge(workspaceId, 'entity-topic', entityNodeId, bugNode.id, 'status')
        : undefined;
      expect(staleEdge).toBeUndefined();

      const freshEdge = featureNode
        ? await findEdge(workspaceId, 'entity-topic', entityNodeId, featureNode.id, 'status')
        : undefined;
      expect(freshEdge).toBeDefined();
    });

    it("removing a value from a multiSelect array removes ONLY that value's edge, keeping the rest", async () => {
      const firstStream = crypto.randomUUID();
      await eventStore.append(firstStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'priority', value: ['urgent', 'blocked'] },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const secondStream = crypto.randomUUID();
      await eventStore.append(secondStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'priority', value: ['urgent'] },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const urgentNode = await findNode(workspaceId, 'topic', 'urgent');
      const blockedNode = await findNode(workspaceId, 'topic', 'blocked');

      const urgentEdge = urgentNode
        ? await findEdge(workspaceId, 'entity-topic', entityNodeId, urgentNode.id, 'priority')
        : undefined;
      const blockedEdge = blockedNode
        ? await findEdge(workspaceId, 'entity-topic', entityNodeId, blockedNode.id, 'priority')
        : undefined;

      expect(urgentEdge).toBeDefined();
      expect(blockedEdge).toBeUndefined();
    });

    it("changing one select field does not affect a DIFFERENT select/multiSelect field's existing entity-topic edges (per-fieldKey refresh scope)", async () => {
      const priorityStream = crypto.randomUUID();
      await eventStore.append(priorityStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'priority', value: ['urgent'] },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const priorityUrgentNode = await findNode(workspaceId, 'topic', 'urgent');
      const priorityEdgeBefore = priorityUrgentNode
        ? await findEdge(
            workspaceId,
            'entity-topic',
            entityNodeId,
            priorityUrgentNode.id,
            'priority',
          )
        : undefined;
      expect(priorityEdgeBefore).toBeDefined();

      const statusStream = crypto.randomUUID();
      await eventStore.append(statusStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'status', value: 'in-review' },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);
      await catchUp();

      const priorityEdgeAfter = priorityUrgentNode
        ? await findEdge(
            workspaceId,
            'entity-topic',
            entityNodeId,
            priorityUrgentNode.id,
            'priority',
          )
        : undefined;
      expect(priorityEdgeAfter).toBeDefined();
    });

    it('a FieldValueChanged on a non-select/multiSelect field (fieldType="text") produces no topic node/edge (no-op, does not throw)', async () => {
      const stream = crypto.randomUUID();
      await eventStore.append(stream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'notes', value: 'plain text value, not a topic' },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);

      await expect(catchUp()).resolves.not.toThrow();

      const topicNode = await findNode(workspaceId, 'topic', 'plain text value, not a topic');
      expect(topicNode).toBeUndefined();
    });

    it('a FieldValueChanged for a fieldKey with NO prior FieldDefined produces no topic node/edge (no-op, does not throw)', async () => {
      const stream = crypto.randomUUID();
      await eventStore.append(stream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'unknownField', value: 'mystery' },
          actor: { type: 'user', id: 'user-owner' },
        }),
      ]);

      await expect(catchUp()).resolves.not.toThrow();

      const topicNode = await findNode(workspaceId, 'topic', 'mystery');
      expect(topicNode).toBeUndefined();
    });
  });

  describe('RelationCreated/RelationRemoved -> entity-entity edges (ADR-0017 Karar a, h; spec AC3)', () => {
    let workspaceId: string;

    beforeAll(async () => {
      workspaceId = await createWorkspace('context-graph-relations');
    });

    async function createObjectPair(label: string): Promise<{
      fromObjectId: string;
      toObjectId: string;
      fromEntityId: string;
      toEntityId: string;
    }> {
      const fromObjectId = newObjectId();
      const toObjectId = newObjectId();
      const fromStream = crypto.randomUUID();
      const toStream = crypto.randomUUID();

      await eventStore.append(fromStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: fromObjectId, objectType: 'task', title: `${label}-from` },
          actor: { type: 'user', id: 'user-rel' },
        }),
      ]);
      await eventStore.append(toStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: toObjectId, objectType: 'task', title: `${label}-to` },
          actor: { type: 'user', id: 'user-rel' },
        }),
      ]);
      await catchUp();

      const fromNode = await findNode(workspaceId, 'entity', fromObjectId);
      const toNode = await findNode(workspaceId, 'entity', toObjectId);
      if (!fromNode || !toNode) {
        throw new Error(`entity nodes not found for pair "${label}" (setup)`);
      }

      return { fromObjectId, toObjectId, fromEntityId: fromNode.id, toEntityId: toNode.id };
    }

    it('RelationCreated creates an entity-entity edge between the corresponding entity nodes', async () => {
      const pair = await createObjectPair('created-pair');
      const relationId = newObjectId();
      const relationStream = crypto.randomUUID();

      await eventStore.append(relationStream, 0, [
        buildEvent({
          workspaceId,
          streamType: RELATION_STREAM_TYPE,
          type: 'RelationCreated',
          payload: {
            relationId,
            workspaceId,
            fromId: pair.fromObjectId,
            toId: pair.toObjectId,
            kind: 'parentChild',
          },
          actor: { type: 'user', id: 'user-rel' },
        }),
      ]);
      await catchUp();

      const edge = await findEdge(
        workspaceId,
        'entity-entity',
        pair.fromEntityId,
        pair.toEntityId,
        null,
      );
      expect(edge).toBeDefined();
    });

    it('RelationRemoved hard-deletes the corresponding entity-entity edge', async () => {
      const pair = await createObjectPair('removed-pair');
      const relationId = newObjectId();
      const relationStream = crypto.randomUUID();

      await eventStore.append(relationStream, 0, [
        buildEvent({
          workspaceId,
          streamType: RELATION_STREAM_TYPE,
          type: 'RelationCreated',
          payload: {
            relationId,
            workspaceId,
            fromId: pair.fromObjectId,
            toId: pair.toObjectId,
            kind: 'reference',
          },
          actor: { type: 'user', id: 'user-rel' },
        }),
      ]);
      await catchUp();

      const edgeBefore = await findEdge(
        workspaceId,
        'entity-entity',
        pair.fromEntityId,
        pair.toEntityId,
        null,
      );
      expect(edgeBefore).toBeDefined();

      // Real payload verified against `packages/core-objects/src/relations/
      // relation-commands.ts`'s `removeRelation`: `{ relationId }` only.
      await eventStore.append(relationStream, 1, [
        buildEvent({
          workspaceId,
          streamType: RELATION_STREAM_TYPE,
          type: 'RelationRemoved',
          payload: { relationId },
          actor: { type: 'user', id: 'user-rel' },
        }),
      ]);
      await catchUp();

      const edgeAfter = await findEdge(
        workspaceId,
        'entity-entity',
        pair.fromEntityId,
        pair.toEntityId,
        null,
      );
      expect(edgeAfter).toBeUndefined();
    });
  });

  describe('ObjectSoftDeleted/ObjectRestored: entity hard-delete + cascade, minimal restore guarantee (ADR-0017 Karar a, h)', () => {
    let workspaceId: string;

    beforeAll(async () => {
      workspaceId = await createWorkspace('context-graph-soft-delete');
    });

    it('ObjectSoftDeleted hard-deletes the entity node AND every edge touching it (entity-person, entity-time, entity-topic, entity-entity)', async () => {
      const fieldDefStream = crypto.randomUUID();
      await eventStore.append(fieldDefStream, 0, [
        buildEvent({
          workspaceId,
          streamType: FIELD_DEFINITION_STREAM_TYPE,
          type: 'FieldDefined',
          payload: {
            fieldDefinitionId: newObjectId(),
            workspaceId,
            objectType: 'task',
            key: 'status',
            fieldType: 'select',
            label: 'Status',
            permissions: EDIT_ALL_PERMISSIONS,
          },
          actor: { type: 'user', id: 'user-admin' },
        }),
      ]);

      const objectId = newObjectId();
      const counterpartObjectId = newObjectId();
      const objectStream = crypto.randomUUID();
      const counterpartStream = crypto.randomUUID();
      const relationStream = crypto.randomUUID();

      await eventStore.append(objectStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'task', title: 'To be deleted' },
          actor: { type: 'user', id: 'user-owner-2' },
        }),
      ]);
      await eventStore.append(counterpartStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: counterpartObjectId, objectType: 'task', title: 'Counterpart' },
          actor: { type: 'user', id: 'user-owner-2' },
        }),
      ]);
      await catchUp();

      await eventStore.append(relationStream, 0, [
        buildEvent({
          workspaceId,
          streamType: RELATION_STREAM_TYPE,
          type: 'RelationCreated',
          payload: {
            relationId: newObjectId(),
            workspaceId,
            fromId: objectId,
            toId: counterpartObjectId,
            kind: 'reference',
          },
          actor: { type: 'user', id: 'user-owner-2' },
        }),
      ]);
      await eventStore.append(objectStream, 1, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: 'status', value: 'blocked' },
          actor: { type: 'user', id: 'user-owner-2' },
        }),
      ]);
      await catchUp();

      const entityNode = await findNode(workspaceId, 'entity', objectId);
      if (!entityNode) {
        throw new Error('entity node not found before soft-delete (setup)');
      }
      const entityNodeId = entityNode.id;

      const edgesBefore = await db
        .select()
        .from(contextGraphEdges)
        .where(
          and(
            eq(contextGraphEdges.workspaceId, workspaceId),
            or(
              eq(contextGraphEdges.fromNodeId, entityNodeId),
              eq(contextGraphEdges.toNodeId, entityNodeId),
            ),
          ),
        );
      // At minimum: entity-person, entity-time, entity-topic (type-based) +
      // entity-topic (status=blocked) + entity-entity (relation).
      expect(edgesBefore.length).toBeGreaterThanOrEqual(4);

      await eventStore.append(objectStream, 2, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectSoftDeleted',
          payload: { objectId },
          actor: { type: 'user', id: 'user-owner-2' },
        }),
      ]);
      await catchUp();

      expect(await findNode(workspaceId, 'entity', objectId)).toBeUndefined();

      const edgesAfter = await db
        .select()
        .from(contextGraphEdges)
        .where(
          and(
            eq(contextGraphEdges.workspaceId, workspaceId),
            or(
              eq(contextGraphEdges.fromNodeId, entityNodeId),
              eq(contextGraphEdges.toNodeId, entityNodeId),
            ),
          ),
        );
      expect(edgesAfter).toHaveLength(0);
    });

    it("ObjectRestored re-creates the entity node (minimal guarantee only -- no claim about edge re-creation, per ADR-0017's accepted restore limitation)", async () => {
      const objectId = newObjectId();
      const objectStream = crypto.randomUUID();

      await eventStore.append(objectStream, 0, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId, objectType: 'note', title: 'Restore me' },
          actor: { type: 'user', id: 'user-owner-3' },
        }),
      ]);
      await catchUp();
      expect(await findNode(workspaceId, 'entity', objectId)).toBeDefined();

      await eventStore.append(objectStream, 1, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectSoftDeleted',
          payload: { objectId },
          actor: { type: 'user', id: 'user-owner-3' },
        }),
      ]);
      await catchUp();
      expect(await findNode(workspaceId, 'entity', objectId)).toBeUndefined();

      // Real payload verified against `objects-view.projection.ts`'s
      // `ObjectRestored` case: `{ objectId }` only, no `objectType`.
      await eventStore.append(objectStream, 2, [
        buildEvent({
          workspaceId,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectRestored',
          payload: { objectId },
          actor: { type: 'user', id: 'user-owner-3' },
        }),
      ]);
      await catchUp();

      expect(await findNode(workspaceId, 'entity', objectId)).toBeDefined();
    });
  });

  describe('Workspace isolation (spec AC1; security-reviewer focus: cross-workspace leakage)', () => {
    it('two workspaces with an identical select-field value produce independent, non-leaking topic nodes/edges', async () => {
      const workspaceA = await createWorkspace('context-graph-isolation-a');
      const workspaceB = await createWorkspace('context-graph-isolation-b');

      for (const wsId of [workspaceA, workspaceB]) {
        const fieldDefStream = crypto.randomUUID();
        await eventStore.append(fieldDefStream, 0, [
          buildEvent({
            workspaceId: wsId,
            streamType: FIELD_DEFINITION_STREAM_TYPE,
            type: 'FieldDefined',
            payload: {
              fieldDefinitionId: newObjectId(),
              workspaceId: wsId,
              objectType: 'task',
              key: 'status',
              fieldType: 'select',
              label: 'Status',
              permissions: EDIT_ALL_PERMISSIONS,
            },
            actor: { type: 'user', id: 'user-iso' },
          }),
        ]);
      }

      const objectIdA = newObjectId();
      const objectIdB = newObjectId();
      const objectStreamA = crypto.randomUUID();
      const objectStreamB = crypto.randomUUID();

      await eventStore.append(objectStreamA, 0, [
        buildEvent({
          workspaceId: workspaceA,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: objectIdA, objectType: 'task', title: 'A' },
          actor: { type: 'user', id: 'user-iso' },
        }),
      ]);
      await eventStore.append(objectStreamB, 0, [
        buildEvent({
          workspaceId: workspaceB,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: objectIdB, objectType: 'task', title: 'B' },
          actor: { type: 'user', id: 'user-iso' },
        }),
      ]);
      await catchUp();

      await eventStore.append(objectStreamA, 1, [
        buildEvent({
          workspaceId: workspaceA,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId: objectIdA, fieldKey: 'status', value: 'bug' },
          actor: { type: 'user', id: 'user-iso' },
        }),
      ]);
      await eventStore.append(objectStreamB, 1, [
        buildEvent({
          workspaceId: workspaceB,
          streamType: OBJECT_STREAM_TYPE,
          type: 'FieldValueChanged',
          payload: { objectId: objectIdB, fieldKey: 'status', value: 'bug' },
          actor: { type: 'user', id: 'user-iso' },
        }),
      ]);
      await catchUp();

      const topicNodesNamedBug = await db
        .select()
        .from(contextGraphNodes)
        .where(
          and(eq(contextGraphNodes.nodeType, 'topic'), eq(contextGraphNodes.naturalKey, 'bug')),
        );
      const relevantTopicNodes = topicNodesNamedBug.filter(
        (node) => node.workspaceId === workspaceA || node.workspaceId === workspaceB,
      );
      expect(relevantTopicNodes).toHaveLength(2);
      expect(new Set(relevantTopicNodes.map((node) => node.workspaceId)).size).toBe(2);

      const entityA = await findNode(workspaceA, 'entity', objectIdA);
      const entityB = await findNode(workspaceB, 'entity', objectIdB);
      const topicA = await findNode(workspaceA, 'topic', 'bug');
      const topicB = await findNode(workspaceB, 'topic', 'bug');
      if (!entityA || !entityB || !topicA || !topicB) {
        throw new Error('setup nodes missing for workspace isolation test');
      }

      // Cross-workspace edges must never exist.
      expect(
        await findEdge(workspaceA, 'entity-topic', entityA.id, topicB.id, 'status'),
      ).toBeUndefined();
      expect(
        await findEdge(workspaceB, 'entity-topic', entityB.id, topicA.id, 'status'),
      ).toBeUndefined();

      // Each workspace only sees its own topic edge.
      expect(
        await findEdge(workspaceA, 'entity-topic', entityA.id, topicA.id, 'status'),
      ).toBeDefined();
      expect(
        await findEdge(workspaceB, 'entity-topic', entityB.id, topicB.id, 'status'),
      ).toBeDefined();
    });

    it('ObjectSoftDeleted in workspace A does not cascade-delete an independently-created entity (same objectType) and its edges in workspace B (security-reviewer regression)', async () => {
      const workspaceA = await createWorkspace('context-graph-isolation-soft-delete-a');
      const workspaceB = await createWorkspace('context-graph-isolation-soft-delete-b');

      const objectIdA = newObjectId();
      const objectIdB = newObjectId();
      const streamA = crypto.randomUUID();
      const streamB = crypto.randomUUID();

      await eventStore.append(streamA, 0, [
        buildEvent({
          workspaceId: workspaceA,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: objectIdA, objectType: 'task', title: 'to-delete-A' },
          actor: { type: 'user', id: 'user-iso-delete' },
        }),
      ]);
      await eventStore.append(streamB, 0, [
        buildEvent({
          workspaceId: workspaceB,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectCreated',
          payload: { objectId: objectIdB, objectType: 'task', title: 'independent-B' },
          actor: { type: 'user', id: 'user-iso-delete' },
        }),
      ]);
      await catchUp();

      const entityB = await findNode(workspaceB, 'entity', objectIdB);
      const personB = await findNode(workspaceB, 'person', 'user-iso-delete');
      if (!entityB || !personB) {
        throw new Error('workspace B setup nodes missing (setup)');
      }

      const edgeBBefore = await findEdge(workspaceB, 'entity-person', entityB.id, personB.id, null);
      expect(edgeBBefore).toBeDefined();

      await eventStore.append(streamA, 1, [
        buildEvent({
          workspaceId: workspaceA,
          streamType: OBJECT_STREAM_TYPE,
          type: 'ObjectSoftDeleted',
          payload: { objectId: objectIdA },
          actor: { type: 'user', id: 'user-iso-delete' },
        }),
      ]);
      await catchUp();

      // A's entity is gone (sanity: the delete actually happened)...
      expect(await findNode(workspaceA, 'entity', objectIdA)).toBeUndefined();

      // ...but B's independently-created entity (same objectType) and its
      // entity-person edge must remain untouched.
      expect(await findNode(workspaceB, 'entity', objectIdB)).toBeDefined();
      const edgeBAfter = await findEdge(workspaceB, 'entity-person', entityB.id, personB.id, null);
      expect(edgeBAfter).toBeDefined();
    });

    it('RelationRemoved in workspace A does not affect the corresponding entity-entity edge in workspace B (security-reviewer regression)', async () => {
      const workspaceA = await createWorkspace('context-graph-isolation-relation-a');
      const workspaceB = await createWorkspace('context-graph-isolation-relation-b');

      async function createPairAndRelation(
        wsId: string,
        label: string,
      ): Promise<{
        fromEntityId: string;
        toEntityId: string;
        relationId: string;
        relationStream: string;
      }> {
        const fromObjectId = newObjectId();
        const toObjectId = newObjectId();
        const fromStream = crypto.randomUUID();
        const toStream = crypto.randomUUID();

        await eventStore.append(fromStream, 0, [
          buildEvent({
            workspaceId: wsId,
            streamType: OBJECT_STREAM_TYPE,
            type: 'ObjectCreated',
            payload: { objectId: fromObjectId, objectType: 'task', title: `${label}-from` },
            actor: { type: 'user', id: 'user-iso-rel' },
          }),
        ]);
        await eventStore.append(toStream, 0, [
          buildEvent({
            workspaceId: wsId,
            streamType: OBJECT_STREAM_TYPE,
            type: 'ObjectCreated',
            payload: { objectId: toObjectId, objectType: 'task', title: `${label}-to` },
            actor: { type: 'user', id: 'user-iso-rel' },
          }),
        ]);
        await catchUp();

        const fromNode = await findNode(wsId, 'entity', fromObjectId);
        const toNode = await findNode(wsId, 'entity', toObjectId);
        if (!fromNode || !toNode) {
          throw new Error(`entity nodes not found for pair "${label}" (setup)`);
        }

        const relationId = newObjectId();
        const relationStream = crypto.randomUUID();
        await eventStore.append(relationStream, 0, [
          buildEvent({
            workspaceId: wsId,
            streamType: RELATION_STREAM_TYPE,
            type: 'RelationCreated',
            payload: {
              relationId,
              workspaceId: wsId,
              fromId: fromObjectId,
              toId: toObjectId,
              kind: 'reference',
            },
            actor: { type: 'user', id: 'user-iso-rel' },
          }),
        ]);
        await catchUp();

        return { fromEntityId: fromNode.id, toEntityId: toNode.id, relationId, relationStream };
      }

      const pairA = await createPairAndRelation(workspaceA, 'iso-rel-a');
      const pairB = await createPairAndRelation(workspaceB, 'iso-rel-b');

      const edgeBBefore = await findEdge(
        workspaceB,
        'entity-entity',
        pairB.fromEntityId,
        pairB.toEntityId,
        null,
      );
      expect(edgeBBefore).toBeDefined();

      await eventStore.append(pairA.relationStream, 1, [
        buildEvent({
          workspaceId: workspaceA,
          streamType: RELATION_STREAM_TYPE,
          type: 'RelationRemoved',
          payload: { relationId: pairA.relationId },
          actor: { type: 'user', id: 'user-iso-rel' },
        }),
      ]);
      await catchUp();

      // A's relation edge is gone (sanity: the removal actually happened)...
      const edgeAAfter = await findEdge(
        workspaceA,
        'entity-entity',
        pairA.fromEntityId,
        pairA.toEntityId,
        null,
      );
      expect(edgeAAfter).toBeUndefined();

      // ...but B's independently-created relation edge must remain untouched.
      const edgeBAfter = await findEdge(
        workspaceB,
        'entity-entity',
        pairB.fromEntityId,
        pairB.toEntityId,
        null,
      );
      expect(edgeBAfter).toBeDefined();
    });
  });

  describe('AC6 / F0-T6 AC4: rebuild produces a logically identical graph to the original catch-up', () => {
    it('rebuild (truncate own state + checkpoint reset to 0 + full replay) reproduces the exact same node/edge SET, compared by logical identity rather than raw ULIDs', async () => {
      const before = await snapshotGraph();
      // Sanity: every earlier `describe` block in this file populated real
      // rows, so a trivially-empty-both-sides pass would be a false positive.
      expect(before.nodeKeys.length).toBeGreaterThan(0);
      expect(before.edgeKeys.length).toBeGreaterThan(0);

      await projectionRunner.rebuild(projection);

      const after = await snapshotGraph();
      expect(after.nodeKeys).toEqual(before.nodeKeys);
      expect(after.edgeKeys).toEqual(before.edgeKeys);
    });
  });
});
