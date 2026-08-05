import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { DocumentReconstructionService } from '../docs/document-reconstruction.service.js';
import { DocumentSnapshotsProjection } from '../docs/document-snapshots.projection.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T11 PR2 (RED step) — ADR-0011 §(f) "Kalıcılık şeması — ayrı
 * `document_snapshots` tablosu" and §"Olay tipleri".
 *
 * Mirrors `objects/checklist-recurrence-projection.integration.test.ts`'s
 * Testcontainers harness EXACTLY (same `postgres:16` + `redis:7`, same
 * DATABASE_URL/REDIS_URL env, same dynamic `import('../app.module.js')` after
 * env is set, same `EventStoreService`/`ProjectionRunner` resolution, same
 * "read stream for expectedVersion, then append" helper).
 *
 * NONE of the two `../docs/*.js` modules imported above exist yet, so every
 * `it` fails at IMPORT time (module not found) — the correct red state.
 *
 * ============================================================================
 * DESIGNED CONTRACT the implementer must match precisely:
 *
 *   // ../docs/document-snapshots.projection.ts
 *   class DocumentSnapshotsProjection implements Projection {
 *     name = 'document-snapshots';
 *     handles = ['DocumentContentSnapshotted'];   // NOT 'DocumentEdited'
 *     // apply(event, tx): INSERT one row keyed by
 *     //   (object_id = event.payload.docId, version = event.version)
 *     //   with the base64-DECODED snapshot bytes (bytea) and
 *     //   created_at = event.occurredAt. Must be IDEMPOTENT — re-applying the
 *     //   same (object_id, version) must NOT throw a duplicate-key error and
 *     //   must NOT create a second row (e.g. onConflictDoNothing).
 *     // reset(tx): truncate `document_snapshots`.
 *   }
 *
 *   // ../docs/document-reconstruction.service.ts
 *   class DocumentReconstructionService {
 *     getLatestSnapshot(objectId: string):
 *       Promise<{ version: number; snapshot: Buffer } | null>;
 *     // returns the row with the highest `version` for objectId, snapshot
 *     // decoded back to a Buffer byte-equal to the original; null if none.
 *   }
 *
 *   // `document_snapshots` table (ADR-0011 §(f)): object_id (ULID), version
 *   //   (int, = DomainEvent envelope version / stream position), snapshot
 *   //   (bytea), created_at. NO hard FK to `objects_view` — the snapshot
 *   //   projection is an INDEPENDENT consumer of the log and must persist a
 *   //   snapshot even if the `objects_view` projection has not caught up yet
 *   //   (this test deliberately never runs `ObjectsViewProjection`).
 *
 * NOTE on `version`: the table's `version` column is the DomainEvent ENVELOPE
 * version (stream position assigned by `EventStoreService.append`), NOT the
 * `version` field inside the `DocumentContentSnapshotted` payload. All
 * assertions below pin the envelope version returned by `appendEvent`.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface WorkspaceEnvelope {
  workspace: { id: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `document-snapshots-projection-test-user-${String(emailCounter)}@example.com`;
}

let docCounter = 0;

/** Distinct ULID-shaped (26-char Crockford base32) docIds, one per test. */
function freshDocId(): string {
  docCounter += 1;
  return `01ARZ3NDEKTSV4RRFFQ69G${String(docCounter).padStart(4, '0')}`;
}

/** The actor recorded on every event this file appends directly (bypassing HTTP — PR2 adds no writer route for these types). */
const DIRECT_APPEND_ACTOR: Actor = { type: 'system', id: 'document-snapshots-projection-test' };

describe('F1-T11 PR2 (RED step): document_snapshots persistence (real Postgres, via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let reconstruction: DocumentReconstructionService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the established
    // convention in every other integration test file here.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());

    eventStore = app.get(EventStoreService);
    projectionRunner = app.get(ProjectionRunner);
    reconstruction = app.get(DocumentReconstructionService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerUser(): Promise<string> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    return toCookieHeader(response.get('Set-Cookie'));
  }

  async function createWorkspace(cookie: string): Promise<string> {
    const response = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Document snapshots projection test ${String(emailCounter)}` });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function freshWorkspaceId(): Promise<string> {
    const cookie = await registerUser();
    return createWorkspace(cookie);
  }

  /**
   * Appends one event directly to `streamId` via `EventStoreService`, reading
   * the stream first to compute the correct `expectedVersion` (mirrors the
   * checklist integration harness), and RETURNS the envelope version the store
   * assigned to it (the value the `document_snapshots.version` column pins to).
   */
  async function appendEvent(
    streamId: string,
    workspaceId: string,
    type: string,
    payload: Record<string, unknown>,
    occurredAt: Date = new Date(),
  ): Promise<number> {
    const priorEvents = await eventStore.readStream(streamId);
    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: 'lumina-object',
      workspaceId,
      type,
      payload,
      actor: DIRECT_APPEND_ACTOR,
      occurredAt,
    };

    const [stored] = await eventStore.append(streamId, priorEvents.length, [event]);
    if (!stored) {
      throw new Error(`append returned no stored event for stream ${streamId}`);
    }
    return stored.version;
  }

  /**
   * Creates a fresh `doc` object stream: a random UUID `streamId` whose first
   * event (version 1) is `ObjectCreated { objectType: 'doc' }`. Returns the
   * ULID `docId` (== the object's own id) and the `streamId`.
   */
  async function createDocStream(
    workspaceId: string,
  ): Promise<{ docId: string; streamId: string }> {
    const docId = freshDocId();
    const streamId = crypto.randomUUID();
    await appendEvent(streamId, workspaceId, 'ObjectCreated', {
      objectId: docId,
      objectType: 'doc',
      title: 'Untitled doc',
    });
    return { docId, streamId };
  }

  async function countSnapshotRows(objectId: string): Promise<number> {
    const result = await rawDb.$client.query<{ count: string }>(
      'select count(*)::text as count from document_snapshots where object_id = $1',
      [objectId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  describe('AC1: round-trip — a DocumentContentSnapshotted event is decoded and persisted', () => {
    it('getLatestSnapshot returns the envelope version + a Buffer byte-equal to the original snapshot bytes', async () => {
      const workspaceId = await freshWorkspaceId();
      const { docId, streamId } = await createDocStream(workspaceId);

      const someBytes = Buffer.from('yjs-update-round-trip-payload', 'utf8');
      const snapshotVersion = await appendEvent(
        streamId,
        workspaceId,
        'DocumentContentSnapshotted',
        {
          docId,
          snapshot: someBytes.toString('base64'),
          version: 1,
        },
      );

      await projectionRunner.catchUp(new DocumentSnapshotsProjection());

      const latest = await reconstruction.getLatestSnapshot(docId);

      expect(latest).not.toBeNull();
      expect(latest?.version).toBe(snapshotVersion);
      expect(Buffer.isBuffer(latest?.snapshot)).toBe(true);
      expect(latest?.snapshot.equals(someBytes)).toBe(true);
    });
  });

  describe('AC2: latest wins — highest envelope version is returned', () => {
    it('after two snapshots, getLatestSnapshot returns the second one byte-equal to its bytes', async () => {
      const workspaceId = await freshWorkspaceId();
      const { docId, streamId } = await createDocStream(workspaceId);

      const firstBytes = Buffer.from('yjs-update-first', 'utf8');
      const secondBytes = Buffer.from('yjs-update-second-and-longer', 'utf8');

      await appendEvent(streamId, workspaceId, 'DocumentContentSnapshotted', {
        docId,
        snapshot: firstBytes.toString('base64'),
        version: 1,
      });
      const secondVersion = await appendEvent(streamId, workspaceId, 'DocumentContentSnapshotted', {
        docId,
        snapshot: secondBytes.toString('base64'),
        version: 2,
      });

      await projectionRunner.catchUp(new DocumentSnapshotsProjection());

      const latest = await reconstruction.getLatestSnapshot(docId);

      expect(latest?.version).toBe(secondVersion);
      expect(latest?.snapshot.equals(secondBytes)).toBe(true);
    });
  });

  describe('AC3: idempotency — replaying the log does not duplicate rows or throw', () => {
    it('a rebuild (full replay) leaves exactly one row and the same latest snapshot, no duplicate-key error', async () => {
      const workspaceId = await freshWorkspaceId();
      const { docId, streamId } = await createDocStream(workspaceId);

      const someBytes = Buffer.from('yjs-update-idempotent', 'utf8');
      const snapshotVersion = await appendEvent(
        streamId,
        workspaceId,
        'DocumentContentSnapshotted',
        {
          docId,
          snapshot: someBytes.toString('base64'),
          version: 1,
        },
      );

      await projectionRunner.catchUp(new DocumentSnapshotsProjection());
      expect(await countSnapshotRows(docId)).toBe(1);

      // Re-run the projection from scratch (reset checkpoint + replay entire
      // log). Re-applying the SAME (object_id, version) must be a no-op, never
      // a duplicate-key error.
      await expect(
        projectionRunner.rebuild(new DocumentSnapshotsProjection()),
      ).resolves.toBeUndefined();

      expect(await countSnapshotRows(docId)).toBe(1);

      const latest = await reconstruction.getLatestSnapshot(docId);
      expect(latest?.version).toBe(snapshotVersion);
      expect(latest?.snapshot.equals(someBytes)).toBe(true);
    });
  });

  describe('AC4: no snapshot → null', () => {
    it('getLatestSnapshot returns null for a doc that has ObjectCreated but no snapshot event', async () => {
      const workspaceId = await freshWorkspaceId();
      const { docId } = await createDocStream(workspaceId);

      await projectionRunner.catchUp(new DocumentSnapshotsProjection());

      expect(await reconstruction.getLatestSnapshot(docId)).toBeNull();
    });
  });

  describe('AC5: DocumentEdited is not persisted by this projection', () => {
    it('a DocumentEdited event creates no document_snapshots row and getLatestSnapshot stays null', async () => {
      const workspaceId = await freshWorkspaceId();
      const { docId, streamId } = await createDocStream(workspaceId);

      await appendEvent(streamId, workspaceId, 'DocumentEdited', {
        docId,
        actorId: DIRECT_APPEND_ACTOR.id,
        at: new Date().toISOString(),
      });

      await projectionRunner.catchUp(new DocumentSnapshotsProjection());

      expect(await countSnapshotRows(docId)).toBe(0);
      expect(await reconstruction.getLatestSnapshot(docId)).toBeNull();
    });
  });

  describe('DocumentSnapshotsProjection static contract', () => {
    it('name === "document-snapshots" and handles === ["DocumentContentSnapshotted"]', () => {
      const projection = new DocumentSnapshotsProjection();
      expect(projection.name).toBe('document-snapshots');
      expect(projection.handles).toEqual(['DocumentContentSnapshotted']);
    });
  });
});
