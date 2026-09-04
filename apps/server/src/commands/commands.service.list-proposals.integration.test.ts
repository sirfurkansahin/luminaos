import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { monotonicFactory } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ForbiddenError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { commandProposals } from '../db/schema/command-proposals.js';
import { memberships } from '../db/schema/memberships.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F2-T16 PR3 (RED step), ADR-0033 §b/§g -- `CommandsService.listProposals`:
 * the FIRST general "list proposals" read endpoint on top of ADR-0015's
 * öner→onayla (propose→decide) flow. `implementer` has not added this method
 * yet.
 *
 * `CommandsService` is imported via a DYNAMIC import inside `beforeAll`,
 * through a locally-declared `CommandsServiceContract`/`CommandsServiceConstructor`
 * pair -- mirrors `./commands.service.integration.test.ts`'s (PR4) and
 * `./commands.service.decide.integration.test.ts`'s (PR5) own exact
 * convention. This is DELIBERATE, not an oversight: a STATIC import + a
 * direct `service.listProposals(...)` call against the REAL class would
 * still correctly fail today (the method doesn't exist), but the resulting
 * TypeScript error type cascades into a wall of unrelated
 * `@typescript-eslint/no-unsafe-*` findings at every call site below (every
 * `.proposals`/`.nextCursor`/`.id` access on an error-typed expression) --
 * exactly the failure mode PR4/PR5's own header comments already document
 * and avoid. Declaring the contract locally keeps every call site in this
 * file fully and safely typed against OUR OWN interface; the only place the
 * "this doesn't exist yet" reality surfaces is the single cast in
 * `beforeAll` below. At runtime this still produces the correct RED failure:
 * `TypeError: service.listProposals is not a function` (the real
 * `CommandsService` class has no such method today).
 *
 * ============================================================================
 * HARNESS CHOICE (test-writer judgment call): unlike
 * `./commands.service.decide.integration.test.ts` (which needs the REAL
 * `ObjectsService`/`RelationsService`/`WorkspaceMembershipService`/
 * `AIUsageService`/`AIProvider` because `decide()` actually exercises all of
 * them, and therefore boots the full `AppModule`), `listProposals` is a PURE
 * read against `command_proposals` -- it needs only a real `db` (to query the
 * table) and touches NONE of `CommandsService`'s other five constructor
 * dependencies. This file therefore mirrors PR4's LIGHTWEIGHT harness (real
 * Postgres via Testcontainers, `CommandsService` manually `new`'d, no full
 * Nest app boot, no Redis), but goes one step further: the five dependencies
 * `listProposals` never touches (`aiUsageService`, `aiProvider`,
 * `objectsService`, `relationsService`, `workspaceMembershipService`) are
 * typed as plain `unknown` in the locally-declared constructor type and
 * passed as empty stub objects -- never exercised, so never need to be real.
 *
 * Fixtures are seeded via a RAW `db.insert(commandProposals)` helper
 * (`seedProposal` below) rather than going through the real
 * `parse()`/`decide()` flow -- this file's own judgment call (explicitly
 * allowed by the task): it gives precise, deterministic control over
 * `decidedAt` (pending vs. decided) and over `id` ordering (via `ulid`'s
 * `monotonicFactory`, guaranteeing strictly increasing, never-tied ids
 * regardless of real wall-clock timing) for the pagination tests below,
 * without needing a scripted AI provider at all.
 *
 * RBAC fixtures (`guest`/`member`/`owner` callers) are likewise raw-inserted
 * directly into `memberships` (+ a throwaway `users` row) -- this file never
 * boots HTTP/auth, so there is no session/cookie to mint a real membership
 * through; `callerRole` is passed straight into `listProposals` as a plain
 * `MembershipRole` string, exactly like `AutomationTriggersService.list`'s own
 * signature.
 * ============================================================================
 *
 * ----------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   listProposals(
 *     workspaceId: string,
 *     callerRole: MembershipRole,
 *     filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
 *   ): Promise<{ proposals: CommandProposalSummary[]; nextCursor?: string }>
 *
 *   - `member`+ required, else `ForbiddenError` (ADR-0033 §g: DELIBERATELY
 *     DIFFERENT from `WebhookSubscriptionsService.list`'s `admin`+-both-ways
 *     rule from PR1 -- a proposal's automation history is "not more sensitive
 *     than seeing a trigger DEFINITION", per ADR-0033 §g's own wording, so
 *     this method mirrors `AutomationTriggersService.list`'s member-read
 *     precedent instead).
 *   - Always scoped by `workspaceId` (never cross-workspace, even for an
 *     admin/owner of a DIFFERENT workspace).
 *   - `filter.pendingOnly: true` -> only rows where `decidedAt IS NULL`.
 *   - Ordered newest-first by `id` (ULID, lexicographic DESC).
 *   - `filter.limit` caps page size; `nextCursor` (the last returned row's
 *     `id`) is present iff more rows exist beyond the current page; passing
 *     `cursor` back in a follow-up call continues from there (no overlap, no
 *     gaps).
 *   - A sensible default `limit` applies when `filter`/`filter.limit` is
 *     omitted; a very large `filter.limit` (e.g. 1000) must not crash/hang,
 *     it just returns however many rows actually exist.
 * ----------------------------------------------------------------------------
 */

interface CommandProposalSummary {
  id: string;
  workspaceId: string;
  command: string;
  sourceObjectId: string | null;
  actions: unknown;
  decisions: unknown;
  createdAt: Date;
  decidedAt: Date | null;
}

interface ListProposalsFilter {
  pendingOnly?: boolean;
  limit?: number;
  // `string | undefined` (not just `string`) so that passing
  // `firstPage.nextCursor` (itself `string | undefined`, from an optional
  // property) straight through at the AC4 pagination round-trip below
  // type-checks under `exactOptionalPropertyTypes: true` -- the real
  // `CommandsService.listProposals`'s own filter param is likewise optional,
  // not "always string when present".
  cursor?: string | undefined;
}

/**
 * The public contract `CommandsService.listProposals` must satisfy once
 * `implementer` adds it -- declared locally (see this file's header for why)
 * rather than imported statically. Only `listProposals` is declared here;
 * this file never calls `parse()`/`decide()`.
 */
interface CommandsServiceContract {
  listProposals(
    workspaceId: string,
    callerRole: MembershipRole,
    filter?: ListProposalsFilter,
  ): Promise<{ proposals: CommandProposalSummary[]; nextCursor?: string }>;
}

/**
 * The real `CommandsService` constructor's 8-parameter shape (`db`/
 * `eventStore`/`projectionRunner`/`aiUsageService`/`aiProvider`/
 * `objectsService`/`relationsService`/`workspaceMembershipService`, in that
 * exact order per `./commands.service.decide.integration.test.ts`'s own
 * pinned contract) -- the last 5 are typed `unknown` here since
 * `listProposals` never touches them (see this file's header).
 */
type CommandsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  aiUsageService: unknown,
  aiProvider: unknown,
  objectsService: unknown,
  relationsService: unknown,
  workspaceMembershipService: unknown,
) => CommandsServiceContract;

describe('CommandsService.listProposals() (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: CommandsServiceContract;
  const nextId = monotonicFactory();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    // BUG FIX (discovered via ci/wire-integration-tests): `CommandsService`
    // (dynamically imported below) statically imports the real
    // `AIUsageService`, which imports `env` from `../config/env.js` at
    // module scope -- that module-level `readEnv()` call fatally
    // `process.exit(1)`s if `DATABASE_URL`/`REDIS_URL` aren't already set.
    // This test's own `db`/`eventStore`/`projectionRunner` are constructed
    // directly from `connectionString`, never through `env.databaseUrl`, so
    // these are placeholders satisfying `readEnv()`'s presence check only --
    // mirrors `ai-usage.service.integration.test.ts`'s own identical
    // "process.env.* set BEFORE the dynamic import" convention, which this
    // file's header comment already claims to follow but never actually did.
    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://commands-service-list-proposals-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Deliberately unresolvable-to-`listProposals` until `implementer` adds
    // it -- see this file's header for why this is a dynamic import through
    // a locally-declared contract rather than a static one.

    const commandsModule: unknown = await import('./commands.service.js');
    const CommandsServiceCtor = (commandsModule as { CommandsService: CommandsServiceConstructor })
      .CommandsService;

    // Empty stubs for the five dependencies `listProposals` never touches --
    // see this file's header for why these are safe to leave unreal.
    service = new CommandsServiceCtor(db, eventStore, projectionRunner, {}, {}, {}, {}, {});
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(name: string): Promise<string> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name, slug: randomUUID() })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  /** Raw-inserts a throwaway user + membership row at the given role -- the
   * only way, in this lightweight (no-HTTP) harness, to get a `callerRole`
   * that isn't hand-typed as a bare string with no backing membership row. */
  async function createMemberWithRole(workspaceId: string, role: MembershipRole): Promise<void> {
    const [user] = await db
      .insert(users)
      .values({
        email: `list-proposals-${randomUUID()}@example.com`,
        passwordHash: 'not-a-real-hash',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error('Failed to insert fixture user');
    }

    await db.insert(memberships).values({ workspaceId, userId: user.id, role });
  }

  /** Raw-inserts a `command_proposals` row -- see this file's header for why. */
  async function seedProposal(
    workspaceId: string,
    overrides: {
      id?: string;
      command?: string;
      sourceObjectId?: string | null;
      actions?: unknown[];
      decisions?: unknown[] | null;
      decidedAt?: Date | null;
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const id = overrides.id ?? nextId();

    await db.insert(commandProposals).values({
      id,
      streamId: randomUUID(),
      workspaceId,
      command: overrides.command ?? `seeded command ${id}`,
      sourceObjectId: overrides.sourceObjectId ?? null,
      actions: overrides.actions ?? [],
      decisions: overrides.decisions ?? null,
      createdAt: overrides.createdAt ?? new Date(),
      decidedAt: overrides.decidedAt ?? null,
    });

    return id;
  }

  // ---------------------------------------------------------------------
  // AC1 -- RBAC: member+ required (ADR-0033 §g)
  // ---------------------------------------------------------------------

  describe("AC1: RBAC -- member+ required, deliberately DIFFERENT from WebhookSubscriptionsService.list's admin+ rule (ADR-0033 §g)", () => {
    it('a "guest" caller is rejected with ForbiddenError', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac1-guest');
      await createMemberWithRole(workspaceId, 'guest');

      await expect(service.listProposals(workspaceId, 'guest')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('a "member" caller succeeds (ADR-0033 §g: a proposal is "not more sensitive than seeing a trigger definition", so this mirrors AutomationTriggersService.list\'s member-read precedent, NOT WebhookSubscriptionsService.list\'s admin+-both-ways rule from PR1)', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac1-member');
      await createMemberWithRole(workspaceId, 'member');
      const proposalId = await seedProposal(workspaceId);

      const result = await service.listProposals(workspaceId, 'member');

      expect(result.proposals.some((proposal) => proposal.id === proposalId)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // AC2 -- cross-workspace isolation
  // ---------------------------------------------------------------------

  describe('AC2: cross-workspace isolation -- always scoped by workspaceId, never cross-workspace even for an admin/owner of a different workspace', () => {
    it("a proposal seeded in workspace A never appears in workspace B's listProposals(), even called as workspace B's owner", async () => {
      const workspaceA = await createWorkspace('list-proposals-ac2-a');
      const workspaceB = await createWorkspace('list-proposals-ac2-b');
      const proposalIdA = await seedProposal(workspaceA);

      const resultB = await service.listProposals(workspaceB, 'owner');

      expect(resultB.proposals.some((proposal) => proposal.id === proposalIdA)).toBe(false);
      expect(resultB.proposals).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // AC3 -- pendingOnly filter
  // ---------------------------------------------------------------------

  describe('AC3: filter.pendingOnly -- only decidedAt IS NULL rows', () => {
    it('pendingOnly: true excludes an already-decided proposal', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac3');
      const pendingId = await seedProposal(workspaceId, { decidedAt: null });
      const decidedId = await seedProposal(workspaceId, {
        decisions: [{ actionId: 'a1', decision: 'approved' }],
        decidedAt: new Date(),
      });

      const result = await service.listProposals(workspaceId, 'member', { pendingOnly: true });

      const ids = result.proposals.map((proposal) => proposal.id);
      expect(ids).toContain(pendingId);
      expect(ids).not.toContain(decidedId);
    });

    it('pendingOnly omitted (or false) includes both pending and decided proposals', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac3-both');
      const pendingId = await seedProposal(workspaceId, { decidedAt: null });
      const decidedId = await seedProposal(workspaceId, {
        decisions: [{ actionId: 'a1', decision: 'approved' }],
        decidedAt: new Date(),
      });

      const result = await service.listProposals(workspaceId, 'member');

      const ids = result.proposals.map((proposal) => proposal.id);
      expect(ids).toContain(pendingId);
      expect(ids).toContain(decidedId);
    });
  });

  // ---------------------------------------------------------------------
  // AC4 -- pagination: newest-first ordering, limit, cursor round-trip
  // ---------------------------------------------------------------------

  describe('AC4: pagination -- newest-first by id, filter.limit caps page size, nextCursor continues without overlap/gaps', () => {
    it('a limit smaller than the total row count returns the newest page + a nextCursor; passing that cursor back returns the remaining rows exactly once, then nextCursor is absent', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac4');
      // Seeded oldest-to-newest; monotonicFactory guarantees strictly
      // increasing ids regardless of real wall-clock timing.
      const oldestId = await seedProposal(workspaceId);
      const middleId = await seedProposal(workspaceId);
      const newestId = await seedProposal(workspaceId);

      const firstPage = await service.listProposals(workspaceId, 'member', { limit: 2 });

      expect(firstPage.proposals.map((proposal) => proposal.id)).toEqual([newestId, middleId]);
      expect(firstPage.nextCursor).toBe(middleId);

      const secondPage = await service.listProposals(workspaceId, 'member', {
        limit: 2,
        cursor: firstPage.nextCursor,
      });

      expect(secondPage.proposals.map((proposal) => proposal.id)).toEqual([oldestId]);
      expect(secondPage.nextCursor).toBeUndefined();

      // No overlap, no gaps: the two pages together cover every seeded id
      // exactly once.
      const combinedIds = [...firstPage.proposals, ...secondPage.proposals].map(
        (proposal) => proposal.id,
      );
      expect(new Set(combinedIds).size).toBe(3);
      expect(combinedIds.sort()).toEqual([oldestId, middleId, newestId].sort());
    });

    it('a limit exactly equal to the total row count returns everything with no nextCursor', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac4-exact');
      const firstId = await seedProposal(workspaceId);
      const secondId = await seedProposal(workspaceId);

      const result = await service.listProposals(workspaceId, 'member', { limit: 2 });

      expect(result.proposals.map((proposal) => proposal.id).sort()).toEqual(
        [firstId, secondId].sort(),
      );
      expect(result.nextCursor).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC5 -- default limit + large-limit safety
  // ---------------------------------------------------------------------

  describe('AC5: a sensible default limit applies when omitted; a very large limit does not crash', () => {
    it('no filter at all still returns every seeded proposal without crashing', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac5-default');
      const ids = [
        await seedProposal(workspaceId),
        await seedProposal(workspaceId),
        await seedProposal(workspaceId),
      ];

      const result = await service.listProposals(workspaceId, 'member');

      expect(result.proposals.map((proposal) => proposal.id).sort()).toEqual([...ids].sort());
    });

    it('filter.limit: 1000 (far larger than the seeded row count) does not crash/hang and just returns however many rows actually exist', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac5-large-limit');
      const ids = [await seedProposal(workspaceId), await seedProposal(workspaceId)];

      const result = await service.listProposals(workspaceId, 'member', { limit: 1000 });

      expect(result.proposals.map((proposal) => proposal.id).sort()).toEqual([...ids].sort());
      expect(result.nextCursor).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // AC6 -- full row-shape round-trip
  // ---------------------------------------------------------------------

  describe('AC6: CommandProposalSummary carries the full row shape', () => {
    it('id/workspaceId/command/sourceObjectId/actions/decisions/createdAt/decidedAt all round-trip exactly', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac6');
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const decidedAt = new Date('2026-01-02T00:00:00.000Z');
      const actions = [{ actionId: 'a1', type: 'createTask', params: { title: 'x' } }];
      const decisions = [{ actionId: 'a1', decision: 'approved' }];

      const proposalId = await seedProposal(workspaceId, {
        command: 'do the thing',
        sourceObjectId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        actions,
        decisions,
        createdAt,
        decidedAt,
      });

      const result = await service.listProposals(workspaceId, 'member');
      const found = result.proposals.find((proposal) => proposal.id === proposalId);

      expect(found).toBeDefined();
      expect(found?.workspaceId).toBe(workspaceId);
      expect(found?.command).toBe('do the thing');
      expect(found?.sourceObjectId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(found?.actions).toEqual(actions);
      expect(found?.decisions).toEqual(decisions);
      expect(new Date(found?.createdAt ?? 0).toISOString()).toBe(createdAt.toISOString());
      expect(new Date(found?.decidedAt ?? 0).toISOString()).toBe(decidedAt.toISOString());
    });
  });

  // ---------------------------------------------------------------------
  // AC7 -- an implicit filter object doesn't required (function overload smoke test)
  // ---------------------------------------------------------------------

  describe('AC7: filter argument is fully optional at every level', () => {
    it('an empty filter object ({}) behaves identically to omitting the argument entirely', async () => {
      const workspaceId = await createWorkspace('list-proposals-ac7');
      const proposalId = await seedProposal(workspaceId);

      const emptyFilter: ListProposalsFilter = {};
      const result = await service.listProposals(workspaceId, 'member', emptyFilter);

      expect(result.proposals.some((proposal) => proposal.id === proposalId)).toBe(true);
    });
  });
});
