import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, NewDomainEvent, ProjectionTx } from '@luminaos/shared';

import { AIUsageProjection } from './ai-usage.projection.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F1-T14 PR2 (RED step). `ai_usage_records`/`AIUsageProjection` have NO
 * dedicated test file prior to this one (previously only exercised
 * indirectly through `objects.service.ts` integration tests) — this is the
 * FIRST direct test file, written up-front for the schema+projection
 * extension this PR adds: two nullable columns, `model varchar(64)` and
 * `cost_usd numeric(10, 6)`.
 *
 * Mirrors `event-store/projections/projection-rebuild.integration.test.ts`'s
 * LIGHTWEIGHT Testcontainers harness exactly: no full Nest app boot, direct
 * `new EventStoreService(db)` / `new ProjectionRunner(db, eventStore)` /
 * `new AIUsageProjection()`, local `createWorkspace` + event-building
 * helpers.
 *
 * ============================================================================
 * DESIGNED CONTRACT `implementer` must match precisely (NOT yet implemented
 * as of this RED commit — this file is expected to fail until both land):
 *
 *   // apps/server/src/db/schema/ai-usage.ts — `aiUsageRecords` gains:
 *   model: varchar('model', { length: 64 })          // nullable, no .notNull()
 *   costUsd: numeric('cost_usd', { precision: 10, scale: 6 })  // nullable
 *
 *   // A new migration pair (generate via
 *   // `pnpm --filter @luminaos/server db:generate` after the schema edit
 *   // above, mirroring `db/migrations/0013_mixed_skin.sql` +
 *   // `down/0013_mixed_skin.down.sql`'s exact nullable-ADD-COLUMN /
 *   // DROP-COLUMN-IF-EXISTS shape):
 *   //   ALTER TABLE "ai_usage_records" ADD COLUMN "model" varchar(64);
 *   //   ALTER TABLE "ai_usage_records" ADD COLUMN "cost_usd" numeric(10, 6);
 *   // down:
 *   //   ALTER TABLE "ai_usage_records" DROP COLUMN IF EXISTS "model";
 *   //   ALTER TABLE "ai_usage_records" DROP COLUMN IF EXISTS "cost_usd";
 *
 *   // apps/server/src/ai/ai-usage.projection.ts — `apply()` additionally
 *   // reads two OPTIONAL payload fields (NOT via the existing
 *   // `requireStringPayloadField`/`requireIntegerPayloadField` helpers,
 *   // which THROW on absence — these two are optional):
 *   //   'AIUsageRecorded' payload MAY carry `model?: string` and
 *   //   `costUsd?: number`.
 *   //   - ABSENT (old, pre-PR2 events, or callers that haven't adopted the
 *   //     new fields): both persisted as NULL. Must NOT throw.
 *   //   - PRESENT and well-typed: persisted as given (`model` -> varchar,
 *   //     `costUsd` -> numeric).
 *   //   - PRESENT but wrong-typed (`model` not a string, `costUsd` not a
 *   //     finite number): THROWS `InvalidObjectStateError`, same as the
 *   //     existing required fields. Absence is tolerated; malformed presence
 *   //     is not.
 *   // The existing required fields (workspaceId/fieldDefinitionId/objectId/
 *   // inputTokens/outputTokens) are UNCHANGED — still throw when missing or
 *   // wrong-typed (regression-tested below, first direct coverage of this
 *   // already-implemented behavior).
 *
 * `cost_usd` is a Drizzle `numeric(10, 6)` column: Drizzle's default mode for
 * `numeric()` returns a STRING at the JS level (not a JS `number`), fixed to
 * `scale` decimal places by Postgres — e.g. inserting `0.0234` round-trips as
 * the string `'0.023400'`. Assertions below check the raw string shape (via
 * `Number(...)` where an approximate check suffices, and an exact string
 * match where precision matters), NOT a loose numeric comparison against a
 * `number`-typed column.
 *
 * Because `apps/server/src/db/schema/ai-usage.ts` has no `model`/`cost_usd`
 * columns yet, queries below select these two columns via a RAW SQL query
 * (`db.$client.query(...)`) rather than through the Drizzle `aiUsageRecords`
 * schema object — this avoids a compile-time reference to columns that don't
 * exist on the Drizzle table yet (this test file may only touch test files,
 * per the TDD ritual; the schema edit is `implementer`'s job) while still
 * proving the real, expected RED failure: a Postgres "column does not exist"
 * error once these tests run, because the migration/schema change is not in
 * place.
 * ============================================================================
 */

interface RawAIUsageRow {
  id: string;
  workspace_id: string;
  field_definition_id: string;
  object_id: string;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_usd: string | null;
}

const AI_USAGE_STREAM_TYPE = 'ai-usage';

describe('AIUsageProjection: model/cost_usd extension (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let projection: AIUsageProjection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);
    projection = new AIUsageProjection();
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

  /** Builds an `AIUsageRecorded` `NewDomainEvent` on its own fresh stream, merging `payloadOverrides` over a valid baseline payload (so tests can omit/corrupt just the field(s) under test). */
  function buildAIUsageEvent(
    workspaceId: string,
    payloadOverrides: Record<string, unknown>,
  ): { streamId: string; event: NewDomainEvent } {
    const streamId = crypto.randomUUID();
    const basePayload: Record<string, unknown> = {
      workspaceId,
      fieldDefinitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      objectId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      inputTokens: 120,
      outputTokens: 45,
    };

    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: AI_USAGE_STREAM_TYPE,
      workspaceId,
      type: 'AIUsageRecorded',
      payload: { ...basePayload, ...payloadOverrides },
      actor: { type: 'agent', id: 'ai-usage-projection-test' },
      occurredAt: new Date(),
    };

    return { streamId, event };
  }

  /** Appends `event` (version 0 -> 1, fresh stream) and returns its id. */
  async function appendEvent(streamId: string, event: NewDomainEvent): Promise<string> {
    const [stored] = await eventStore.append(streamId, 0, [event]);
    if (!stored) {
      throw new Error(`append returned no stored event for stream ${streamId}`);
    }
    return stored.id;
  }

  /**
   * Builds a full `DomainEvent` (with a synthetic `streamId`/`version`) WITHOUT
   * ever calling `eventStore.append` — `AIUsageProjection.apply()` only reads
   * `event.workspaceId`/`payload`/`type`/`occurredAt`, none of which require
   * the event to have actually been persisted. Used exclusively by the
   * malformed-payload tests (AC3/AC4) below: those events are DELIBERATELY
   * invalid and must NEVER be written to the real event log — if they were
   * (as an earlier draft of this file did via `appendEvent` +
   * `eventStore.readStream`), the malformed event would sit permanently
   * unprocessed past `projectionRunner.catchUp`'s shared, monotonically
   * advancing checkpoint (same class of "poison event" bug already fixed in
   * `search-index.projection.integration.test.ts`), causing EVERY later test
   * in this file that calls `catchUp` normally (e.g. AC5) to hit that
   * malformed event first and fail for the wrong reason. Constructing the
   * event purely in memory sidesteps this entirely — nothing is ever added to
   * the real log, so there is nothing to poison.
   */
  function buildStandaloneAIUsageEvent(
    workspaceId: string,
    payloadOverrides: Record<string, unknown>,
  ): DomainEvent {
    const basePayload: Record<string, unknown> = {
      workspaceId,
      fieldDefinitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      objectId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      inputTokens: 120,
      outputTokens: 45,
    };

    return {
      id: crypto.randomUUID(),
      streamId: crypto.randomUUID(),
      streamType: AI_USAGE_STREAM_TYPE,
      workspaceId,
      type: 'AIUsageRecorded',
      version: 1,
      payload: { ...basePayload, ...payloadOverrides },
      actor: { type: 'agent', id: 'ai-usage-projection-test' },
      occurredAt: new Date(),
    };
  }

  async function getRawRow(eventId: string): Promise<RawAIUsageRow | undefined> {
    const result = await db.$client.query<RawAIUsageRow>(
      'select id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd from ai_usage_records where id = $1',
      [eventId],
    );
    return result.rows[0];
  }

  async function countRows(): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      'select count(*)::text as count from ai_usage_records',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  describe('AC1: a new event carrying model+costUsd persists both, at numeric(10,6) precision', () => {
    it('row has the exact model string and the cost formatted to 6 decimal places', async () => {
      const workspaceId = await createWorkspace('ai-usage-ac1');
      const { streamId, event } = buildAIUsageEvent(workspaceId, {
        model: 'claude-sonnet-5',
        costUsd: 0.0234,
      });

      const eventId = await appendEvent(streamId, event);
      await projectionRunner.catchUp(projection);

      const row = await getRawRow(eventId);
      expect(row).toBeDefined();
      expect(row?.model).toBe('claude-sonnet-5');
      // Drizzle's numeric() default mode returns a string; Postgres fixes it
      // to the column's declared scale (6).
      expect(row?.cost_usd).toBe('0.023400');
      expect(Number(row?.cost_usd)).toBeCloseTo(0.0234, 6);
    });
  });

  describe('AC2 (critical regression prevention): an old-style event with NEITHER model NOR costUsd does not throw, and both columns are NULL', () => {
    it('catchUp succeeds and the row has model = null, cost_usd = null', async () => {
      const workspaceId = await createWorkspace('ai-usage-ac2');
      // No `model`/`costUsd` keys at all — simulates a real pre-PR2 event
      // already sitting in the event log.
      const { streamId, event } = buildAIUsageEvent(workspaceId, {});

      const eventId = await appendEvent(streamId, event);

      await expect(projectionRunner.catchUp(projection)).resolves.toBeUndefined();

      const row = await getRawRow(eventId);
      expect(row).toBeDefined();
      expect(row?.model).toBeNull();
      expect(row?.cost_usd).toBeNull();
    });
  });

  describe('AC3 (regression): existing required-field validation is unchanged', () => {
    it('an event missing inputTokens is rejected by apply(), and no row is inserted', async () => {
      const workspaceId = await createWorkspace('ai-usage-ac3');
      // `undefined` values are dropped by JSON-serialization on the way into
      // a real payload column, so this reliably simulates a payload that
      // never had `inputTokens` at all — but since this event is
      // DELIBERATELY invalid, it is built purely in memory
      // (`buildStandaloneAIUsageEvent`, never `eventStore.append`ed) so it
      // can never poison the shared `catchUp` checkpoint other tests in this
      // file rely on.
      const event = buildStandaloneAIUsageEvent(workspaceId, { inputTokens: undefined });

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
      expect(await getRawRow(event.id)).toBeUndefined();
    });
  });

  describe('AC4: present-but-malformed model/costUsd are rejected, not silently coerced', () => {
    it('model present but not a string is rejected', async () => {
      const workspaceId = await createWorkspace('ai-usage-ac4-model');
      const event = buildStandaloneAIUsageEvent(workspaceId, { model: 123 });

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
      expect(await getRawRow(event.id)).toBeUndefined();
    });

    it('costUsd present but not a valid number is rejected', async () => {
      const workspaceId = await createWorkspace('ai-usage-ac4-cost');
      const event = buildStandaloneAIUsageEvent(workspaceId, { costUsd: 'not-a-number' });

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
      expect(await getRawRow(event.id)).toBeUndefined();
    });
  });

  describe('AC5 (regression): reset() still empties the table', () => {
    it('after inserting rows via catchUp, reset(tx) leaves the table empty', async () => {
      const workspaceId = await createWorkspace('ai-usage-ac5');
      const { streamId, event } = buildAIUsageEvent(workspaceId, {
        model: 'claude-sonnet-5',
        costUsd: 0.01,
      });

      await appendEvent(streamId, event);
      await projectionRunner.catchUp(projection);

      expect(await countRows()).toBeGreaterThan(0);

      await db.transaction(async (tx) => {
        await projection.reset(tx as unknown as ProjectionTx);
      });

      expect(await countRows()).toBe(0);
    });
  });
});
