import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { NewDomainEvent } from '@luminaos/shared';

import { computePairKey } from './federation-link-state.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { federationLinks } from '../db/schema/federation-links.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';

/**
 * F3-T14 PR2 (RED step), ADR-0048 §h — `FederationAuditService`
 * (`./federation-audit.service.ts`, does NOT exist yet):
 * `recordAccessedFailClosed`/`recordRequestedBestEffort`, the fail-closed/
 * best-effort asymmetry ADR-0048 §h pins, each writing to the CALLER-SIDE's
 * OWN per-link audit stream (`federationLinks.initiatorAuditStreamId`/
 * `counterpartAuditStreamId`, never a shared `linkId`-as-`streamId`, per
 * Bağlam madde 5's cross-workspace `events_stream_id_version_key` finding).
 *
 * ============================================================================
 * HARNESS CHOICE: a REAL Testcontainers Postgres + a REAL, statically
 * imported `EventStoreService` (already exists, F0-T6) for every
 * SUCCESS-path assertion below (real `append`/`readStream` round-trips,
 * verifying the actual persisted event's `type`/`streamId`/`workspaceId`/
 * `payload`) -- combined with a HAND-MOCKED `EventStoreService`-shaped
 * collaborator (`vi.fn()`-based, `EventStoreServiceLike`) for the two
 * failure-injection tests, mirroring `../mcp-server/mcp-token-auth.guard.test.ts`'s
 * own "real Postgres for the one genuinely stateful dependency + mocked
 * collaborator for a dependency that has its OWN dedicated test file
 * elsewhere (`../event-store/event-store.service.test.ts`)" pattern. Forcing
 * a REAL Postgres append failure deterministically (e.g. dropping the
 * connection mid-transaction) would be flaky/non-portable across CI
 * runners; injecting the failure at the `EventStoreService` boundary is the
 * same fail-closed CONTRACT test, without the flake.
 *
 * `FederationAuditService`'s constructor shape is a JUDGMENT CALL (not
 * pinned by ADR-0048's own code draft, which only shows the two call sites
 * inside `FederationMcpController`, not the class's own constructor):
 * assumed `constructor(@Inject(DATABASE_CONNECTION) db: Database,
 * eventStore: EventStoreService)`, mirroring `RelationsService`'s identical
 * `(db, eventStore)` shape -- the most direct precedent for "a domain
 * service that both looks up rows via `db` AND appends via `EventStoreService`".
 * If `implementer` chooses a different shape, only this file's `buildService`
 * helper needs revisiting.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./federation-audit.service.ts` does not exist.
 * `beforeAll`'s dynamic `import('./federation-audit.service.js')` rejects
 * with a "Cannot find module" resolution error, failing every test in this
 * file at setup -- this is the correct red, not a test-logic bug.
 * ============================================================================
 */

interface RecordAccessedParams {
  linkId: string;
  hostWorkspaceId: string;
  credentialId: string;
  granteeWorkspaceId: string;
  objectId: string;
}

interface RecordRequestedParams {
  linkId: string;
  granteeWorkspaceId: string;
  hostWorkspaceId: string;
  credentialId: string;
  objectId: string;
}

interface FederationAuditServiceContract {
  recordAccessedFailClosed(params: RecordAccessedParams): Promise<void>;
  recordRequestedBestEffort(params: RecordRequestedParams): Promise<void>;
}

interface EventStoreServiceLike {
  append(
    streamId: string,
    expectedVersion: number,
    newEvents: NewDomainEvent[],
  ): Promise<StoredEvent[]>;
  readStream(streamId: string): Promise<StoredEvent[]>;
}

interface FederationAuditServiceConstructor {
  new (db: Database, eventStore: EventStoreServiceLike): FederationAuditServiceContract;
}

describe('FederationAuditService (real Postgres + real EventStoreService, ADR-0048 §h)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let realEventStore: EventStoreService;
  let FederationAuditServiceCtor: FederationAuditServiceConstructor;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://federation-audit-service-test-placeholder:6379';

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    realEventStore = new EventStoreService(db);

    // Deliberately unresolvable until `implementer` creates
    // `./federation-audit.service.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained
    // to this one line.
    const importedModule: unknown = await import('./federation-audit.service.js');
    FederationAuditServiceCtor = (
      importedModule as { FederationAuditService: FederationAuditServiceConstructor }
    ).FederationAuditService;
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `federation-audit-test-${label}-${unique}`, slug: unique })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new Error(`Failed to insert fixture workspace "${label}"`);
    }

    return workspace.id;
  }

  async function createUser(label: string): Promise<string> {
    const unique = crypto.randomUUID();
    const [user] = await db
      .insert(users)
      .values({
        email: `federation-audit-test-${label}-${unique}@example.com`,
        passwordHash: 'not-a-real-hash-fixture-only',
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error(`Failed to insert fixture user "${label}"`);
    }

    return user.id;
  }

  async function createActiveLink(label: string): Promise<{
    linkId: string;
    initiatorWorkspaceId: string;
    counterpartWorkspaceId: string;
    initiatorAuditStreamId: string;
    counterpartAuditStreamId: string;
  }> {
    const initiatorWorkspaceId = await createWorkspace(`${label}-initiator`);
    const counterpartWorkspaceId = await createWorkspace(`${label}-counterpart`);
    const initiatedByUserId = await createUser(`${label}-initiator`);
    const pairKey = computePairKey(initiatorWorkspaceId, counterpartWorkspaceId);

    const [row] = await db
      .insert(federationLinks)
      .values({
        initiatorWorkspaceId,
        counterpartWorkspaceId,
        pairKey,
        status: 'active',
        initiatedByUserId,
        acceptedAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error('Failed to insert fixture federation link');
    }

    return {
      linkId: row.id,
      initiatorWorkspaceId,
      counterpartWorkspaceId,
      initiatorAuditStreamId: row.initiatorAuditStreamId,
      counterpartAuditStreamId: row.counterpartAuditStreamId,
    };
  }

  function buildServiceWithRealEventStore(): FederationAuditServiceContract {
    return new FederationAuditServiceCtor(db, realEventStore);
  }

  function buildServiceWithMockEventStore(): {
    service: FederationAuditServiceContract;
    append: ReturnType<typeof vi.fn<EventStoreServiceLike['append']>>;
    readStream: ReturnType<typeof vi.fn<EventStoreServiceLike['readStream']>>;
  } {
    const append = vi.fn<EventStoreServiceLike['append']>();
    const readStream = vi.fn<EventStoreServiceLike['readStream']>();
    const mockEventStore: EventStoreServiceLike = { append, readStream };
    return { service: new FederationAuditServiceCtor(db, mockEventStore), append, readStream };
  }

  it('1. recordAccessedFailClosed writes a "FederatedContextAccessed" event to the HOST side\'s own audit stream (host = initiator here), with the exact payload fields ADR-0048 §h pins', async () => {
    const link = await createActiveLink('accessed-host-initiator');
    const credentialId = crypto.randomUUID();
    const objectId = crypto.randomUUID();

    const service = buildServiceWithRealEventStore();
    await service.recordAccessedFailClosed({
      linkId: link.linkId,
      hostWorkspaceId: link.initiatorWorkspaceId,
      credentialId,
      granteeWorkspaceId: link.counterpartWorkspaceId,
      objectId,
    });

    const storedEvents = await realEventStore.readStream(link.initiatorAuditStreamId);
    expect(storedEvents).toHaveLength(1);
    const [event] = storedEvents;
    expect(event?.type).toBe('FederatedContextAccessed');
    expect(event?.workspaceId).toBe(link.initiatorWorkspaceId);
    expect(event?.payload).toMatchObject({
      linkId: link.linkId,
      credentialId,
      granteeWorkspaceId: link.counterpartWorkspaceId,
      objectId,
    });

    // Nothing should have landed on the counterpart's own stream.
    const counterpartEvents = await realEventStore.readStream(link.counterpartAuditStreamId);
    expect(counterpartEvents).toHaveLength(0);
  });

  it('2. recordAccessedFailClosed, host = COUNTERPART this time -> writes to counterpartAuditStreamId, proving the stream is derived from hostWorkspaceId, not hardcoded to "initiator"', async () => {
    const link = await createActiveLink('accessed-host-counterpart');
    const credentialId = crypto.randomUUID();
    const objectId = crypto.randomUUID();

    const service = buildServiceWithRealEventStore();
    await service.recordAccessedFailClosed({
      linkId: link.linkId,
      hostWorkspaceId: link.counterpartWorkspaceId,
      credentialId,
      granteeWorkspaceId: link.initiatorWorkspaceId,
      objectId,
    });

    const storedEvents = await realEventStore.readStream(link.counterpartAuditStreamId);
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]?.type).toBe('FederatedContextAccessed');
    expect(storedEvents[0]?.workspaceId).toBe(link.counterpartWorkspaceId);

    const initiatorEvents = await realEventStore.readStream(link.initiatorAuditStreamId);
    expect(initiatorEvents).toHaveLength(0);
  });

  it('3. recordRequestedBestEffort writes a "FederatedContextRequested" event to the GRANTEE side\'s own audit stream, with the exact payload fields ADR-0048 §h pins', async () => {
    const link = await createActiveLink('requested-grantee-counterpart');
    const credentialId = crypto.randomUUID();
    const objectId = crypto.randomUUID();

    const service = buildServiceWithRealEventStore();
    await service.recordRequestedBestEffort({
      linkId: link.linkId,
      granteeWorkspaceId: link.counterpartWorkspaceId,
      hostWorkspaceId: link.initiatorWorkspaceId,
      credentialId,
      objectId,
    });

    const storedEvents = await realEventStore.readStream(link.counterpartAuditStreamId);
    expect(storedEvents).toHaveLength(1);
    const [event] = storedEvents;
    expect(event?.type).toBe('FederatedContextRequested');
    expect(event?.workspaceId).toBe(link.counterpartWorkspaceId);
    expect(event?.payload).toMatchObject({
      linkId: link.linkId,
      credentialId,
      hostWorkspaceId: link.initiatorWorkspaceId,
      objectId,
    });

    const initiatorEvents = await realEventStore.readStream(link.initiatorAuditStreamId);
    expect(initiatorEvents).toHaveLength(0);
  });

  it('4. recordRequestedBestEffort, grantee = INITIATOR this time -> writes to initiatorAuditStreamId, proving the stream is derived from granteeWorkspaceId, not hardcoded to "counterpart"', async () => {
    const link = await createActiveLink('requested-grantee-initiator');
    const credentialId = crypto.randomUUID();
    const objectId = crypto.randomUUID();

    const service = buildServiceWithRealEventStore();
    await service.recordRequestedBestEffort({
      linkId: link.linkId,
      granteeWorkspaceId: link.initiatorWorkspaceId,
      hostWorkspaceId: link.counterpartWorkspaceId,
      credentialId,
      objectId,
    });

    const storedEvents = await realEventStore.readStream(link.initiatorAuditStreamId);
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]?.type).toBe('FederatedContextRequested');
    expect(storedEvents[0]?.workspaceId).toBe(link.initiatorWorkspaceId);
  });

  it('5. FAIL-CLOSED: recordAccessedFailClosed PROPAGATES the error when the underlying event-store append fails -- the caller (FederationMcpController, PR2) must be able to catch this and abort the read entirely', async () => {
    const link = await createActiveLink('accessed-fail-closed');
    const { service, append, readStream } = buildServiceWithMockEventStore();
    readStream.mockResolvedValue([]);
    append.mockRejectedValue(new Error('simulated event-store append failure'));

    await expect(
      service.recordAccessedFailClosed({
        linkId: link.linkId,
        hostWorkspaceId: link.initiatorWorkspaceId,
        credentialId: crypto.randomUUID(),
        granteeWorkspaceId: link.counterpartWorkspaceId,
        objectId: crypto.randomUUID(),
      }),
    ).rejects.toThrow('simulated event-store append failure');
  });

  it('6. BEST-EFFORT: recordRequestedBestEffort does NOT throw when the underlying event-store append fails -- only fail-closed writes may ever abort the caller', async () => {
    const link = await createActiveLink('requested-best-effort');
    const { service, append, readStream } = buildServiceWithMockEventStore();
    readStream.mockResolvedValue([]);
    append.mockRejectedValue(new Error('simulated event-store append failure'));

    await expect(
      service.recordRequestedBestEffort({
        linkId: link.linkId,
        granteeWorkspaceId: link.counterpartWorkspaceId,
        hostWorkspaceId: link.initiatorWorkspaceId,
        credentialId: crypto.randomUUID(),
        objectId: crypto.randomUUID(),
      }),
    ).resolves.toBeUndefined();

    expect(append).toHaveBeenCalled();
  });
});
