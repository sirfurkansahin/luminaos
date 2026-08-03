import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { TaskRecurrenceService as TaskRecurrenceServiceModuleExport } from './task-recurrence.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';

import type { Database } from '../db/client.js';

/**
 * F1-T10 PR3 (RED step) — `TaskRecurrenceService`: the cross-stream
 * orchestration ADR-0010 places at `apps/server/src/recurrence/
 * task-recurrence.service.ts` (ADR-0010 §"(d) Orkestrasyon yeri"), covering
 * this task's remaining open acceptance criterion (spec
 * `docs/specs/F1-E3/F1-T10-gorev-deneyimi.md`, bullet 3):
 *
 *   "status alanı isDone=true seçeneğine geçince tam olarak bir yeni
 *   yinelenen görev üretildiği, önceki göreve recurrence-of ilişkisiyle
 *   bağlandığı testli; aynı tamamlanma olayının iki kez işlenmesi ikinci
 *   nesneyi üretmediği (idempotency) testli."
 *
 * `TaskRecurrenceService` does NOT exist yet — the import of
 * `./task-recurrence.service.js` above is expected to fail module resolution
 * ("Cannot find module") the instant this file loads, BEFORE any `describe`/
 * `it` block runs. That is the correct red state; `implementer` must create
 * `./task-recurrence.service.ts` matching the contract pinned below to turn
 * this green.
 *
 * ============================================================================
 * SCOPE BOUNDARY (deliberately narrow, matches ADR-0010 §(d)'s "TEK, dar,
 * açık bir metot çağrısı" framing):
 *
 * This file tests `TaskRecurrenceService` IN ISOLATION — it does NOT drive
 * the trigger through `ObjectsService.setFieldValues`'s real `status` ->
 * `isDone` transition-detection (that wiring, and the `isDone` false->true
 * comparison itself, is `ObjectsService`'s job per ADR-0010 §(f) and is a
 * SEPARATE, later PR's concern/test file). This file assumes that detection
 * has already happened and pins ONLY what `TaskRecurrenceService` itself must
 * guarantee once called: given a source task id, the id of the
 * `FieldValueChanged` event that carried the `isDone` transition
 * (`causationEventId`), and the already-computed "next occurrence" payload
 * (title + copied field values, `status` already reset by the caller to a
 * non-`isDone` option — ADR-0010 §(g)), it writes EXACTLY one new `task`
 * object and EXACTLY one `recurrenceOf` relation, and is idempotent when
 * invoked twice with the same `causationEventId` (ADR-0010 §(c) Layer B:
 * deterministic stream/event ids riding on `EventStoreService.append`'s own
 * `tryLoadIdempotentReplay`).
 *
 * Not covered here (out of scope for this PR's test, flagged explicitly):
 *   - The `status`/`isDone` false->true transition DETECTION itself.
 *   - `Relation.causationEventId`'s DB-level partial-unique-index
 *     (ADR-0010 §(c) Layer A, `relations_view` — a projection/migration
 *     concern) — this file exercises Layer B (deterministic-id event-store
 *     replay) only, via `EventStoreService` directly, mirroring
 *     `../event-store/event-store.integration.test.ts`'s own "construct
 *     directly against a real Database, no Nest DI/HTTP" convention (this
 *     service, like `EventStoreService` itself, has no controller/HTTP
 *     surface of its own).
 *   - `packages/core-objects`'s `RelationKind` union does not include
 *     `'recurrenceOf'` yet, and `Relation` has no `causationEventId` field
 *     yet (ADR-0010 §(a)/(b)) — `implementer` must extend both
 *     (`relation.ts`, `relation-commands.ts`'s `KNOWN_RELATION_KINDS`,
 *     `relation-replay.ts`'s `KNOWN_RELATION_KINDS`) as part of turning this
 *     green; this test file relies on that extension but does not itself
 *     re-test `createRelation`/`replayRelation`'s own cycle/uniqueness rules
 *     (already covered by `relation-commands.test.ts`/`relation-replay.test.ts`).
 *
 * ============================================================================
 * CONTRACT PINNED HERE (implementer must match exactly —
 * `./task-recurrence.service.ts` does not exist yet):
 *
 *   export interface GenerateNextOccurrenceInput {
 *     workspaceId: string;
 *     actor: Actor;
 *     sourceObjectId: string;   // the task that just transitioned to isDone
 *     causationEventId: string; // id of the triggering FieldValueChanged event
 *     nextOccurrence: {
 *       title: string;                          // copied from source, ADR-0010 (g)
 *       fieldValues: Record<string, unknown>;    // copied custom field values,
 *                                                 // status ALREADY reset by the
 *                                                 // caller (this service does
 *                                                 // no isDone-aware logic itself)
 *     };
 *   }
 *
 *   export interface GenerateNextOccurrenceResult {
 *     object: LuminaObject;               // type: 'task', checklist: [] (ADR-0010 g)
 *     fieldValues: Record<string, unknown>; // == input.nextOccurrence.fieldValues
 *     relation: Relation;                 // kind: 'recurrenceOf', fromId: sourceObjectId,
 *                                          // toId: object.id, causationEventId: input.causationEventId
 *   }
 *
 *   export class TaskRecurrenceService {
 *     constructor(eventStore: EventStoreService);
 *     generateNextOccurrence(input: GenerateNextOccurrenceInput): Promise<GenerateNextOccurrenceResult>;
 *   }
 *
 * - Exactly ONE new `task` LuminaObject and exactly ONE `recurrenceOf`
 *   `Relation` are produced per DISTINCT `causationEventId` — never more,
 *   regardless of how many times `generateNextOccurrence` is called with that
 *   SAME `causationEventId` (sequential retries or a concurrent race, per
 *   ADR-0010 §(c) Layer B + §(e)'s "yeniden çağrılırsa idempotenttir"
 *   guarantee).
 * - A second (or Nth) call with the SAME `causationEventId` (and otherwise
 *   identical input) resolves to a result carrying the IDENTICAL
 *   `object.id`/`relation.id` as the first call — never a fresh pair.
 * - A DIFFERENT `causationEventId` (e.g. a recurring task completed again
 *   later in its life, ADR-0010 §(a): "bir kaynak görev... birden çok kez
 *   tamamlanıp her seferinde yeni bir yinelenen görev üretebilir") always
 *   produces its OWN new object + relation, independent of any prior call.
 * - `implementer` is free to choose the actual deterministic-id derivation
 *   algorithm (ADR-0010 §(c) Layer B says "ör. bir sabit tuzla `uuidv5`, ya
 *   da eşdeğer deterministik türetme") — this test file never asserts a
 *   specific id VALUE, only the observable idempotency/uniqueness behavior
 *   above, verified via `EventStoreService.readByWorkspace` (raw event-count
 *   assertions), not via any assumed streamId-derivation formula.
 *
 * LINT NOTE (mirrors `../health/health.service.test.ts`'s own note): since
 * `./task-recurrence.service.ts` doesn't exist yet, its named export resolves
 * to `any`, which would otherwise cascade `@typescript-eslint/no-unsafe-*`
 * errors through every line touching `recurrenceService`/its result, on top
 * of the one genuinely-expected `import-x/no-unresolved` error this file is
 * supposed to fail with. The local `TaskRecurrenceService*`/
 * `GenerateNextOccurrence*` interfaces below + the single
 * `as unknown as TaskRecurrenceServiceConstructor` cast are the narrow escape
 * hatch (mirrors `db/client.ts`'s `as unknown as Pool['query']` pattern) —
 * once the real `task-recurrence.service.ts` exists with this exact shape,
 * the cast becomes a no-op and can be deleted along with these local types in
 * favor of importing the real ones (`LuminaObject`/`Relation` from
 * `@luminaos/core-objects`).
 * ============================================================================
 */

interface LuminaObjectLike {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lifecycle: string;
  checklist: unknown[];
}

interface RelationLike {
  id: string;
  workspaceId: string;
  fromId: string;
  toId: string;
  kind: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  causationEventId?: string;
}

interface GenerateNextOccurrenceInput {
  workspaceId: string;
  actor: Actor;
  sourceObjectId: string;
  causationEventId: string;
  nextOccurrence: {
    title: string;
    fieldValues: Record<string, unknown>;
  };
}

interface GenerateNextOccurrenceResult {
  object: LuminaObjectLike;
  fieldValues: Record<string, unknown>;
  relation: RelationLike;
}

interface TaskRecurrenceServiceInstance {
  generateNextOccurrence: (
    input: GenerateNextOccurrenceInput,
  ) => Promise<GenerateNextOccurrenceResult>;
}

interface TaskRecurrenceServiceConstructor {
  new (eventStore: EventStoreService): TaskRecurrenceServiceInstance;
}

const TaskRecurrenceService =
  TaskRecurrenceServiceModuleExport as unknown as TaskRecurrenceServiceConstructor;

function buildActor(): Actor {
  return { type: 'system', id: 'task-recurrence-engine' };
}

describe('TaskRecurrenceService (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let recurrenceService: TaskRecurrenceServiceInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    recurrenceService = new TaskRecurrenceService(eventStore);
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

  function buildInput(
    overrides: Partial<GenerateNextOccurrenceInput> = {},
  ): GenerateNextOccurrenceInput {
    return {
      workspaceId: 'placeholder',
      actor: buildActor(),
      sourceObjectId: crypto.randomUUID(),
      causationEventId: crypto.randomUUID(),
      nextOccurrence: {
        title: 'Weekly report',
        fieldValues: { status: 'todo', priority: 'high' },
      },
      ...overrides,
    };
  }

  async function countEventsByType(workspaceId: string, type: string): Promise<number> {
    const events = await eventStore.readByWorkspace(workspaceId, 0);
    return events.filter((event) => event.type === type).length;
  }

  describe('AC: exactly one new task is generated and linked via a recurrenceOf relation', () => {
    it('creates a new `task`-type object carrying the given title, copied field values, and an EMPTY checklist', async () => {
      const workspaceId = await createWorkspace('single-trigger-object');
      const sourceObjectId = crypto.randomUUID();
      const causationEventId = crypto.randomUUID();

      const result = await recurrenceService.generateNextOccurrence(
        buildInput({
          workspaceId,
          sourceObjectId,
          causationEventId,
          nextOccurrence: {
            title: 'Weekly report',
            fieldValues: { status: 'todo', priority: 'high' },
          },
        }),
      );

      expect(result.object.type).toBe('task');
      expect(result.object.title).toBe('Weekly report');
      expect(result.object.workspaceId).toBe(workspaceId);
      expect(result.object.checklist).toEqual([]);
      expect(result.fieldValues).toEqual({ status: 'todo', priority: 'high' });
    });

    it('links the new object back to the source via a `recurrenceOf` relation carrying the causationEventId', async () => {
      const workspaceId = await createWorkspace('single-trigger-relation');
      const sourceObjectId = crypto.randomUUID();
      const causationEventId = crypto.randomUUID();

      const result = await recurrenceService.generateNextOccurrence(
        buildInput({ workspaceId, sourceObjectId, causationEventId }),
      );

      expect(result.relation.kind).toBe('recurrenceOf');
      expect(result.relation.fromId).toBe(sourceObjectId);
      expect(result.relation.toId).toBe(result.object.id);
      expect(result.relation.workspaceId).toBe(workspaceId);
      expect(result.relation.causationEventId).toBe(causationEventId);
    });

    it('writes exactly one ObjectCreated event and exactly one RelationCreated event to the workspace log for a single trigger', async () => {
      const workspaceId = await createWorkspace('single-trigger-event-count');

      await recurrenceService.generateNextOccurrence(buildInput({ workspaceId }));

      expect(await countEventsByType(workspaceId, 'ObjectCreated')).toBe(1);
      expect(await countEventsByType(workspaceId, 'RelationCreated')).toBe(1);
    });
  });

  describe('AC: idempotency — the same completion event processed twice never produces a second object', () => {
    it('a second call with the IDENTICAL causationEventId resolves to the SAME object id and relation id as the first call', async () => {
      const workspaceId = await createWorkspace('idempotent-same-ids');
      const input = buildInput({ workspaceId });

      const first = await recurrenceService.generateNextOccurrence(input);
      const second = await recurrenceService.generateNextOccurrence(input);

      expect(second.object.id).toBe(first.object.id);
      expect(second.relation.id).toBe(first.relation.id);
    });

    it('processing the same causationEventId twice (sequentially) leaves exactly ONE ObjectCreated and ONE RelationCreated event in the log — never two', async () => {
      const workspaceId = await createWorkspace('idempotent-sequential-count');
      const input = buildInput({ workspaceId });

      await recurrenceService.generateNextOccurrence(input);
      await recurrenceService.generateNextOccurrence(input);

      expect(await countEventsByType(workspaceId, 'ObjectCreated')).toBe(1);
      expect(await countEventsByType(workspaceId, 'RelationCreated')).toBe(1);
    });

    it('processing the same causationEventId twice CONCURRENTLY (a race) still leaves exactly ONE ObjectCreated and ONE RelationCreated event, and both calls resolve to the same ids', async () => {
      const workspaceId = await createWorkspace('idempotent-concurrent');
      const input = buildInput({ workspaceId });

      const [first, second] = await Promise.all([
        recurrenceService.generateNextOccurrence(input),
        recurrenceService.generateNextOccurrence(input),
      ]);

      expect(second.object.id).toBe(first.object.id);
      expect(second.relation.id).toBe(first.relation.id);
      expect(await countEventsByType(workspaceId, 'ObjectCreated')).toBe(1);
      expect(await countEventsByType(workspaceId, 'RelationCreated')).toBe(1);
    });
  });

  describe('AC (boundary, not idempotency): a DIFFERENT causationEventId always generates its own new occurrence', () => {
    it('two distinct causationEventIds for the same sourceObjectId each produce their OWN new task + recurrenceOf relation (never collapsed together)', async () => {
      const workspaceId = await createWorkspace('distinct-causation-events');
      const sourceObjectId = crypto.randomUUID();

      const first = await recurrenceService.generateNextOccurrence(
        buildInput({ workspaceId, sourceObjectId, causationEventId: crypto.randomUUID() }),
      );
      const second = await recurrenceService.generateNextOccurrence(
        buildInput({ workspaceId, sourceObjectId, causationEventId: crypto.randomUUID() }),
      );

      expect(second.object.id).not.toBe(first.object.id);
      expect(second.relation.id).not.toBe(first.relation.id);
      expect(first.relation.fromId).toBe(sourceObjectId);
      expect(second.relation.fromId).toBe(sourceObjectId);

      expect(await countEventsByType(workspaceId, 'ObjectCreated')).toBe(2);
      expect(await countEventsByType(workspaceId, 'RelationCreated')).toBe(2);
    });
  });

  describe('security-reviewer regression: input hardening', () => {
    it('throws ValidationError for an empty workspaceId', async () => {
      await expect(
        recurrenceService.generateNextOccurrence(buildInput({ workspaceId: '' })),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for an empty sourceObjectId', async () => {
      await expect(
        recurrenceService.generateNextOccurrence(buildInput({ sourceObjectId: '' })),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for an empty causationEventId', async () => {
      await expect(
        recurrenceService.generateNextOccurrence(buildInput({ causationEventId: '' })),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when a fieldValues key is an unsafe prototype-pollution key', async () => {
      await expect(
        recurrenceService.generateNextOccurrence(
          buildInput({
            nextOccurrence: {
              title: 'Weekly report',
              // Computed key, not the `__proto__:` literal shorthand — the
              // latter sets the object's actual prototype instead of adding
              // an own enumerable key, which would defeat this regression
              // test (it must exercise `Object.keys` seeing `__proto__`).
              fieldValues: { ['__proto__']: 'polluted' },
            },
          }),
        ),
      ).rejects.toThrow(ValidationError);
    });
  });
});
