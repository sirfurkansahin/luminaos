import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, NewDomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F1-T16 PR4 (RED step), ADR-0015 §a/§b — `ActionProposalProjection`, the
 * read-model projection backing `command_proposals`. Nothing under test here
 * exists yet:
 *   - `./action-proposal.projection.ts` (`ActionProposalProjection`) does not
 *     exist.
 *   - The `command_proposals` table (no schema file, no migration) does not
 *     exist -- every raw-SQL query below against it fails with a Postgres
 *     "relation \"command_proposals\" does not exist" error. This is the
 *     correct RED state; `implementer` must add the schema file + migration
 *     (+ down script) matching the EXACT column shape this file's header
 *     documents below.
 *
 * `ActionProposalProjection` is imported via a DYNAMIC import inside
 * `beforeAll`, through a locally-declared `ActionProposalProjectionContract`
 * interface, mirroring `../ai/ai-usage.service.integration.test.ts`'s exact
 * convention: this contains the resulting `import-x/no-unresolved` finding to
 * a single, isolated import line instead of letting an untyped `any` (from a
 * would-be static import of a nonexistent module) cascade into
 * `@typescript-eslint/no-unsafe-*` findings at every call site below.
 *
 * ============================================================================
 * DESIGNED CONTRACT `implementer` must match precisely:
 *
 *   // apps/server/src/db/schema/command-proposals.ts (NEW FILE) --
 *   // `command_proposals`, mirroring `relations-view.ts`'s conventions:
 *   export const commandProposals = pgTable('command_proposals', {
 *     id: varchar('id', { length: 26 }).primaryKey(),          // proposalId (ULID)
 *     streamId: uuid('stream_id').notNull().unique(),
 *     workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
 *     command: text('command').notNull(),
 *     sourceObjectId: varchar('source_object_id', { length: 26 }),   // nullable
 *     actions: jsonb('actions').notNull(),                            // ProposedAction[]
 *     decisions: jsonb('decisions'),                                  // nullable, populated by ActionsDecided
 *     createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
 *     decidedAt: timestamp('decided_at', { withTimezone: true }),     // nullable
 *   });
 *
 *   // apps/server/src/commands/action-proposal.projection.ts (NEW FILE):
 *   export class ActionProposalProjection implements Projection {
 *     readonly name = 'action-proposal';
 *     readonly handles = ['ActionsProposed', 'ActionsDecided'];
 *     async apply(event, tx): Promise<void> { ... switch (event.type) ... }
 *     async reset(tx): Promise<void> { ... }
 *   }
 *
 *   `apply()`'s `ActionsProposed` case INSERTS a new row (`onConflictDoNothing`
 *   on the primary key `id`, mirroring `AIUsageProjection`'s idempotent-replay
 *   convention -- NOT `RelationsViewProjection`'s partial-index convention,
 *   since `command_proposals.id` has no business-uniqueness concern beyond
 *   "this exact proposalId already landed"), with `decisions: null` /
 *   `decidedAt: null` on first insert.
 *
 *   `apply()`'s `ActionsDecided` case UPDATES the existing row (matched by
 *   `proposalId`, i.e. `command_proposals.id`), setting `decisions` (the raw
 *   payload array) and `decidedAt: event.occurredAt` -- mirroring
 *   `RelationsViewProjection`'s "switch on event.type, one event type per
 *   entity's LIFECYCLE STAGE, same table" shape (NOT `AIUsageProjection`'s
 *   "one insert only" shape, since a proposal genuinely has two stages
 *   writing to the SAME row).
 * ============================================================================
 */

interface RawCommandProposalRow {
  id: string;
  stream_id: string;
  workspace_id: string;
  command: string;
  source_object_id: string | null;
  actions: unknown;
  decisions: unknown;
  created_at: Date;
  decided_at: Date | null;
}

const ACTION_PROPOSAL_STREAM_TYPE = 'action-proposal';
const COMMAND_PARSER_ACTOR = { type: 'agent', id: 'command-parser' } as const;

/**
 * The public contract `ActionProposalProjection` must satisfy, declared
 * locally (see this file's header for why) rather than imported statically.
 */
interface ActionProposalProjectionContract extends Projection {
  apply(event: DomainEvent, tx: ProjectionTx): Promise<void>;
  reset(tx: ProjectionTx): Promise<void>;
}

type ActionProposalProjectionConstructor = new () => ActionProposalProjectionContract;

describe('ActionProposalProjection (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let projection: ActionProposalProjectionContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Deliberately unresolvable until `implementer` creates
    // `./action-proposal.projection.ts` -- see this file's header. The
    // eslint-disable below only silences the STATIC-ANALYSIS finding for this
    // one line (the module genuinely does not exist yet, the whole point of
    // this RED commit); it does not affect the runtime behavior at all -- the
    // dynamic `import()` below still throws a real "Cannot find module" error
    // at test-run time, which is the correct RED failure reason. Remove this
    // comment once `implementer` adds the file and the import resolves.
     
    const importedModule: unknown = await import('./action-proposal.projection.js');
    const ActionProposalProjectionCtor = (
      importedModule as { ActionProposalProjection: ActionProposalProjectionConstructor }
    ).ActionProposalProjection;
    projection = new ActionProposalProjectionCtor();
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

  function baseProposedPayload(
    workspaceId: string,
    proposalId: string,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      proposalId,
      workspaceId,
      command: 'create a follow-up task',
      actions: [
        {
          actionId: crypto.randomUUID(),
          type: 'createTask',
          intent: 'Create a follow-up task',
          rationale: 'The user asked for one',
          resources: [],
          rollbackNote: 'Delete the created task',
          params: { title: 'Follow up' },
        },
      ],
      ...overrides,
    };
  }

  /** Builds an `ActionsProposed` `NewDomainEvent` on a fresh stream (version 0 -> 1). */
  function buildActionsProposedEvent(
    workspaceId: string,
    proposalId: string,
    payloadOverrides: Record<string, unknown> = {},
  ): { streamId: string; event: NewDomainEvent } {
    const streamId = crypto.randomUUID();

    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: ACTION_PROPOSAL_STREAM_TYPE,
      workspaceId,
      type: 'ActionsProposed',
      payload: baseProposedPayload(workspaceId, proposalId, payloadOverrides),
      actor: COMMAND_PARSER_ACTOR,
      occurredAt: new Date(),
    };

    return { streamId, event };
  }

  /** Builds an `ActionsDecided` `NewDomainEvent`, meant to be appended at version 1 -> 2 on an EXISTING proposal's stream. */
  function buildActionsDecidedEvent(
    workspaceId: string,
    proposalId: string,
    payloadOverrides: Record<string, unknown> = {},
  ): NewDomainEvent {
    return {
      id: crypto.randomUUID(),
      streamType: ACTION_PROPOSAL_STREAM_TYPE,
      workspaceId,
      type: 'ActionsDecided',
      payload: {
        proposalId,
        decisions: [{ actionId: crypto.randomUUID(), decision: 'approved' }],
        ...payloadOverrides,
      },
      actor: { type: 'user', id: 'deciding-user-1' },
      occurredAt: new Date(),
    };
  }

  /**
   * Builds a full, standalone `DomainEvent` (synthetic `streamId`/`version`)
   * WITHOUT ever calling `eventStore.append` -- used exclusively by the
   * malformed-payload tests below, so a deliberately-invalid event never sits
   * unprocessed past `projectionRunner.catchUp`'s shared, monotonically
   * advancing checkpoint (the "poison event" bug class `AIUsageProjection`'s
   * own integration test file already documents and avoids the same way).
   */
  function buildStandaloneEvent(
    type: 'ActionsProposed' | 'ActionsDecided',
    workspaceId: string,
    payload: Record<string, unknown>,
  ): DomainEvent {
    return {
      id: crypto.randomUUID(),
      streamId: crypto.randomUUID(),
      streamType: ACTION_PROPOSAL_STREAM_TYPE,
      workspaceId,
      type,
      version: 1,
      payload,
      actor: COMMAND_PARSER_ACTOR,
      occurredAt: new Date(),
    };
  }

  async function appendEvent(
    streamId: string,
    expectedVersion: number,
    event: NewDomainEvent,
  ): Promise<void> {
    await eventStore.append(streamId, expectedVersion, [event]);
  }

  async function getRow(proposalId: string): Promise<RawCommandProposalRow | undefined> {
    const result = await db.$client.query<RawCommandProposalRow>(
      'select id, stream_id, workspace_id, command, source_object_id, actions, decisions, created_at, decided_at from command_proposals where id = $1',
      [proposalId],
    );
    return result.rows[0];
  }

  async function countRows(): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      'select count(*)::text as count from command_proposals',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // ---------------------------------------------------------------------
  // AC1 -- ActionsProposed inserts a new row
  // ---------------------------------------------------------------------

  describe('AC1: ActionsProposed inserts a new command_proposals row', () => {
    it('row has the exact workspaceId/command/actions, and decisions/decidedAt are NULL', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac1');
      const proposalId = crypto.randomUUID();
      const { streamId, event } = buildActionsProposedEvent(workspaceId, proposalId);

      await appendEvent(streamId, 0, event);
      await projectionRunner.catchUp(projection);

      const row = await getRow(proposalId);
      expect(row).toBeDefined();
      expect(row?.workspace_id).toBe(workspaceId);
      expect(row?.stream_id).toBe(streamId);
      expect(row?.command).toBe('create a follow-up task');
      expect(Array.isArray(row?.actions)).toBe(true);
      expect((row?.actions as unknown[]).length).toBe(1);
      expect(row?.decisions).toBeNull();
      expect(row?.decided_at).toBeNull();
    });

    it('sourceObjectId, when present in the payload, is persisted onto the source_object_id column', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac1-source');
      const proposalId = crypto.randomUUID();
      const { streamId, event } = buildActionsProposedEvent(workspaceId, proposalId, {
        sourceObjectId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      });

      await appendEvent(streamId, 0, event);
      await projectionRunner.catchUp(projection);

      const row = await getRow(proposalId);
      expect(row?.source_object_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });

    it('sourceObjectId, when ABSENT from the payload, leaves source_object_id NULL', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac1-no-source');
      const proposalId = crypto.randomUUID();
      const { streamId, event } = buildActionsProposedEvent(workspaceId, proposalId);

      await appendEvent(streamId, 0, event);
      await projectionRunner.catchUp(projection);

      const row = await getRow(proposalId);
      expect(row?.source_object_id).toBeNull();
    });

    it('is idempotent: re-processing the same ActionsProposed event (rebuild) never duplicates or errors', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac1-idempotent');
      const proposalId = crypto.randomUUID();
      const { streamId, event } = buildActionsProposedEvent(workspaceId, proposalId);

      await appendEvent(streamId, 0, event);
      await projectionRunner.catchUp(projection);
      await expect(projectionRunner.rebuild(projection)).resolves.toBeUndefined();

      const row = await getRow(proposalId);
      expect(row).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- ActionsDecided updates the existing row
  // ---------------------------------------------------------------------

  describe('AC2: ActionsDecided updates the matching command_proposals row (matched by proposalId)', () => {
    it('decisions and decidedAt are populated after ActionsDecided lands on the SAME stream at version 2', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac2');
      const proposalId = crypto.randomUUID();
      const { streamId, event: proposedEvent } = buildActionsProposedEvent(workspaceId, proposalId);

      await appendEvent(streamId, 0, proposedEvent);
      await projectionRunner.catchUp(projection);

      const decidedEvent = buildActionsDecidedEvent(workspaceId, proposalId);
      await appendEvent(streamId, 1, decidedEvent);
      await projectionRunner.catchUp(projection);

      const row = await getRow(proposalId);
      expect(row?.decisions).not.toBeNull();
      expect(Array.isArray(row?.decisions)).toBe(true);
      expect((row?.decisions as { decision: string }[])[0]?.decision).toBe('approved');
      expect(row?.decided_at).not.toBeNull();
    });

    it('an ActionsDecided for a proposalId with no matching row is a no-op (does not throw, inserts nothing)', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac2-orphan');
      const orphanProposalId = crypto.randomUUID();
      const streamId = crypto.randomUUID();
      const decidedEvent = buildActionsDecidedEvent(workspaceId, orphanProposalId);

      const countBefore = await countRows();
      await appendEvent(streamId, 0, decidedEvent);
      await expect(projectionRunner.catchUp(projection)).resolves.toBeUndefined();

      expect(await countRows()).toBe(countBefore);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- malformed ActionsProposed payloads are rejected
  // ---------------------------------------------------------------------

  describe('AC3: malformed ActionsProposed payloads throw InvalidObjectStateError and insert nothing', () => {
    it('missing proposalId', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac3-proposalid');
      const payload = baseProposedPayload(workspaceId, 'placeholder', {});
      delete payload['proposalId'];
      const event = buildStandaloneEvent('ActionsProposed', workspaceId, payload);

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
    });

    it('missing workspaceId', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac3-workspaceid');
      const payload = baseProposedPayload(workspaceId, crypto.randomUUID(), {});
      delete payload['workspaceId'];
      const event = buildStandaloneEvent('ActionsProposed', workspaceId, payload);

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
    });

    it('missing command', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac3-command');
      const payload = baseProposedPayload(workspaceId, crypto.randomUUID(), {});
      delete payload['command'];
      const event = buildStandaloneEvent('ActionsProposed', workspaceId, payload);

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
    });

    it('actions present but not an array', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac3-actions');
      const proposalId = crypto.randomUUID();
      const payload = baseProposedPayload(workspaceId, proposalId, { actions: 'not-an-array' });
      const event = buildStandaloneEvent('ActionsProposed', workspaceId, payload);

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
      expect(await getRow(proposalId)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- malformed ActionsDecided payloads are rejected
  // ---------------------------------------------------------------------

  describe('AC4: malformed ActionsDecided payloads throw InvalidObjectStateError', () => {
    it('missing proposalId', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac4-proposalid');
      const event = buildStandaloneEvent('ActionsDecided', workspaceId, {
        decisions: [{ actionId: crypto.randomUUID(), decision: 'approved' }],
      });

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
    });

    it('missing decisions', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac4-decisions');
      const event = buildStandaloneEvent('ActionsDecided', workspaceId, {
        proposalId: crypto.randomUUID(),
      });

      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await projection.apply(event, tx as unknown as ProjectionTx);
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidObjectStateError);
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- reset() empties the table
  // ---------------------------------------------------------------------

  describe('AC5: reset() empties command_proposals', () => {
    it('after inserting a row via catchUp, reset(tx) leaves the table empty', async () => {
      const workspaceId = await createWorkspace('action-proposal-ac5');
      const proposalId = crypto.randomUUID();
      const { streamId, event } = buildActionsProposedEvent(workspaceId, proposalId);

      await appendEvent(streamId, 0, event);
      await projectionRunner.catchUp(projection);

      expect(await countRows()).toBeGreaterThan(0);

      await db.transaction(async (tx) => {
        await projection.reset(tx as unknown as ProjectionTx);
      });

      expect(await countRows()).toBe(0);
    });
  });
});
