import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockMeetingBotClient } from '@luminaos/integrations';
import type { NewDomainEvent, Projection } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { EventStoreService } from '../event-store/event-store.service.js';
import type { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T14 PR5 (RED step, part 2 of 2) — `pendingProposal` on
 * `GET /workspaces/:workspaceId/meetings/:meetingId` (ADR-0031 §h/§j).
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `MeetingsService.getMeetingDetails` gains a new, OPTIONAL
 * `meeting.pendingProposal` field: when a `command_proposals` row exists
 * whose `sourceObjectId` equals this meeting's own object id AND that row is
 * NOT yet decided (`decided_at IS NULL`, i.e. no `ActionsDecided` event has
 * landed for it), the response's `meeting.pendingProposal` is
 * `{ proposalId: string; actions: ProposedAction[] }` (`actions` being the
 * row's own stored `actions` array).
 *
 * When there is no such undecided proposal for this meeting (no proposal at
 * all, OR one that already has `decided_at` set), `meeting.pendingProposal`
 * is OMITTED from the response object entirely -- `'pendingProposal' in
 * response.meeting` must be `false`, never a visible `null`/`undefined`
 * value (same "omit the key, don't null it" discipline as
 * `meeting.transcriptText`'s own ADR-0030 §h gate).
 *
 * `pendingProposal` is gated by the EXACT SAME role check as
 * `transcriptText`: `hasAtLeastRole(callerRole, 'member')`. A `guest` caller
 * must never see `pendingProposal` even when an undecided proposal genuinely
 * exists for that meeting; `member`/`admin`/owner callers do.
 *
 * Cross-workspace isolation: a proposal belonging to a meeting in a
 * DIFFERENT workspace must never leak into another meeting's
 * `pendingProposal` -- mirrors this sibling file's own already-established
 * cross-workspace GET pattern (`meeting-invite.controller.integration.test.ts`'s
 * test 8).
 *
 * ============================================================================
 * HARNESS NOTE: mirrors `./meeting-invite.controller.integration.test.ts`'s
 * EXACT Testcontainers Postgres 16 + Redis 7 + dynamic-`AppModule`-import +
 * `.overrideProvider(MEETING_BOT_CLIENT)` + `addMemberWithRole` raw-membership
 * pattern. `command_proposals` rows are seeded the SAME way
 * `./commands/action-proposal.projection.integration.test.ts` and
 * `./commands/commands.service.propose-from-meeting.integration.test.ts` do:
 * a real `ActionsProposed` `NewDomainEvent` appended via the resolved
 * `EventStoreService` (`moduleRef.get(EventStoreService)`), followed by
 * `projectionRunner.catchUp(new ActionProposalProjection())` -- NOT a raw
 * insert against `command_proposals`, since a raw insert would need to
 * independently reproduce the projection's exact column-population logic and
 * could silently drift from it. `ActionsDecided` (for the "already decided,
 * must be omitted" case) is appended the same way, at the proposal's own
 * stream version 1 -> 2.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `meeting.pendingProposal` does not exist on
 * `MeetingsService.getMeetingDetails`'s return shape at all -- every
 * `'pendingProposal' in ...` / `.pendingProposal` assertion below that
 * expects PRESENCE fails (the key is simply never there), while assertions
 * expecting OMISSION currently pass vacuously (expected, they pin the
 * negative contract for after implementation lands). This is the correct
 * red, not a test-logic bug.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';
const PROPOSAL_STREAM_TYPE = 'action-proposal';
const MEETING_ACTION_EXTRACTOR_ACTOR = { type: 'agent', id: 'meeting-action-extractor' } as const;

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface MeetingObjectBody {
  id: string;
}

interface InviteMeetingEnvelope {
  object: MeetingObjectBody;
}

interface PendingProposalBody {
  proposalId: string;
  actions: unknown[];
}

interface MeetingReadBody {
  id: string;
  transcriptText?: string;
  pendingProposal?: PendingProposalBody;
}

interface GetMeetingEnvelope {
  meeting: MeetingReadBody;
}

interface MeetingBotClientTokenModule {
  MEETING_BOT_CLIENT: string;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `meeting-pending-proposal-test-user-${String(emailCounter)}@example.com`;
}

describe('GET .../meetings/:meetingId -- meeting.pendingProposal (F2-T14 PR5 RED step, ADR-0031 §h/§j, real Postgres + real HTTP via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let mockBotClient: MockMeetingBotClient;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let actionProposalProjection: Projection;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const tokenModule =
      (await import('./meeting-bot-client.token.js')) as unknown as MeetingBotClientTokenModule;

    const { EventStoreService } = await import('../event-store/event-store.service.js');
    const { ProjectionRunner } =
      await import('../event-store/projections/projection-runner.service.js');
    const { ActionProposalProjection } = await import('../commands/action-proposal.projection.js');

    mockBotClient = new MockMeetingBotClient();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(tokenModule.MEETING_BOT_CLIENT)
      .useValue(mockBotClient)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
    eventStore = moduleRef.get(EventStoreService);
    projectionRunner = moduleRef.get(ProjectionRunner);
    actionProposalProjection = new ActionProposalProjection();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    expect((registerResponse.body as UserEnvelope).user.id).toBeDefined();

    const workspaceResponse = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Meeting pending-proposal test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    const userId = (registerResponse.body as UserEnvelope).user.id;

    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  async function seedMeeting(
    workspaceId: string,
    cookie: string,
    meetingUrl: string,
  ): Promise<string> {
    const inviteResponse = await request(server)
      .post(`/workspaces/${workspaceId}/meetings`)
      .set('Cookie', cookie)
      .send({ meetingUrl });
    expect(inviteResponse.status).toBe(201);
    return (inviteResponse.body as InviteMeetingEnvelope).object.id;
  }

  function oneMeetingAction(): Record<string, unknown> {
    return {
      actionId: crypto.randomUUID(),
      type: 'createTaskFromMeeting',
      intent: 'Create a follow-up task from the meeting',
      rationale: 'The transcript named a concrete action item',
      resources: [],
      rollbackNote: 'Delete the created task',
      params: { title: 'Follow up on the meeting' },
    };
  }

  /** Seeds an UNDECIDED `command_proposals` row whose `sourceObjectId` is `meetingObjectId` — returns `{ proposalId, streamId }` so a caller can later append `ActionsDecided` on the SAME stream at version 1 -> 2. */
  async function seedUndecidedProposal(
    workspaceId: string,
    meetingObjectId: string,
  ): Promise<{ proposalId: string; streamId: string }> {
    const proposalId = crypto.randomUUID();
    const streamId = crypto.randomUUID();

    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: PROPOSAL_STREAM_TYPE,
      workspaceId,
      type: 'ActionsProposed',
      payload: {
        proposalId,
        workspaceId,
        sourceObjectId: meetingObjectId,
        command: `[meeting-action-extraction] meetingObjectId=${meetingObjectId}`,
        actions: [oneMeetingAction()],
      },
      actor: MEETING_ACTION_EXTRACTOR_ACTOR,
      occurredAt: new Date(),
    };

    await eventStore.append(streamId, 0, [event]);
    await projectionRunner.catchUp(actionProposalProjection);

    return { proposalId, streamId };
  }

  async function decideProposal(
    workspaceId: string,
    streamId: string,
    proposalId: string,
  ): Promise<void> {
    await eventStore.append(streamId, 1, [
      {
        id: crypto.randomUUID(),
        streamType: PROPOSAL_STREAM_TYPE,
        workspaceId,
        type: 'ActionsDecided',
        payload: { proposalId, decisions: [] },
        actor: { type: 'user', id: 'deciding-user-pending-proposal-test' },
        occurredAt: new Date(),
      },
    ]);
    await projectionRunner.catchUp(actionProposalProjection);
  }

  function meetingUrl(workspaceId: string, meetingId: string): string {
    return `/workspaces/${workspaceId}/meetings/${meetingId}`;
  }

  it('1. an UNDECIDED command_proposals row whose sourceObjectId matches this meeting -> meeting.pendingProposal is present with {proposalId, actions} for an admin/owner caller', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const meetingObjectId = await seedMeeting(
      workspaceId,
      cookie,
      'https://meet.google.com/pending-proposal-ac1',
    );

    const { proposalId } = await seedUndecidedProposal(workspaceId, meetingObjectId);

    const response = await request(server)
      .get(meetingUrl(workspaceId, meetingObjectId))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const meeting = (response.body as GetMeetingEnvelope).meeting;
    expect('pendingProposal' in meeting).toBe(true);
    expect(meeting.pendingProposal?.proposalId).toBe(proposalId);
    expect(Array.isArray(meeting.pendingProposal?.actions)).toBe(true);
    expect(meeting.pendingProposal?.actions).toHaveLength(1);
  });

  it('2a. no proposal at all for this meeting -> meeting.pendingProposal is OMITTED (never null/undefined-as-a-key)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const meetingObjectId = await seedMeeting(
      workspaceId,
      cookie,
      'https://zoom.us/j/pending-proposal-ac2a',
    );

    const response = await request(server)
      .get(meetingUrl(workspaceId, meetingObjectId))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const meeting = (response.body as GetMeetingEnvelope).meeting;
    expect('pendingProposal' in meeting).toBe(false);
  });

  it('2b. a proposal that has ALREADY been decided for this meeting -> meeting.pendingProposal is OMITTED', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const meetingObjectId = await seedMeeting(
      workspaceId,
      cookie,
      'https://teams.microsoft.com/l/meetup-join/pending-proposal-ac2b',
    );

    const { proposalId, streamId } = await seedUndecidedProposal(workspaceId, meetingObjectId);
    await decideProposal(workspaceId, streamId, proposalId);

    const response = await request(server)
      .get(meetingUrl(workspaceId, meetingObjectId))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const meeting = (response.body as GetMeetingEnvelope).meeting;
    expect('pendingProposal' in meeting).toBe(false);
  });

  it('3. role gate: a "guest" caller never sees pendingProposal even when an undecided proposal exists, while "member"/"admin" callers do', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const meetingObjectId = await seedMeeting(
      workspaceId,
      ownerCookie,
      'https://meet.google.com/pending-proposal-ac3',
    );
    const { proposalId } = await seedUndecidedProposal(workspaceId, meetingObjectId);

    const guestCookie = await addMemberWithRole(workspaceId, 'guest');
    const guestResponse = await request(server)
      .get(meetingUrl(workspaceId, meetingObjectId))
      .set('Cookie', guestCookie);
    expect(guestResponse.status).toBe(200);
    const guestMeeting = (guestResponse.body as GetMeetingEnvelope).meeting;
    expect('pendingProposal' in guestMeeting).toBe(false);
    expect(JSON.stringify(guestResponse.body)).not.toContain(proposalId);

    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const memberResponse = await request(server)
      .get(meetingUrl(workspaceId, meetingObjectId))
      .set('Cookie', memberCookie);
    expect(memberResponse.status).toBe(200);
    const memberMeeting = (memberResponse.body as GetMeetingEnvelope).meeting;
    expect('pendingProposal' in memberMeeting).toBe(true);
    expect(memberMeeting.pendingProposal?.proposalId).toBe(proposalId);

    const adminCookie = await addMemberWithRole(workspaceId, 'admin');
    const adminResponse = await request(server)
      .get(meetingUrl(workspaceId, meetingObjectId))
      .set('Cookie', adminCookie);
    expect(adminResponse.status).toBe(200);
    const adminMeeting = (adminResponse.body as GetMeetingEnvelope).meeting;
    expect('pendingProposal' in adminMeeting).toBe(true);
    expect(adminMeeting.pendingProposal?.proposalId).toBe(proposalId);
  });

  it("4. cross-workspace isolation: a proposal sourced from a meeting in workspace A never leaks into a DIFFERENT meeting's pendingProposal, even in workspace B", async () => {
    const ownerA = await registerOwnerWithWorkspace();
    const ownerB = await registerOwnerWithWorkspace();

    const meetingA = await seedMeeting(
      ownerA.workspaceId,
      ownerA.cookie,
      'https://meet.google.com/pending-proposal-ac4-a',
    );
    const meetingB = await seedMeeting(
      ownerB.workspaceId,
      ownerB.cookie,
      'https://zoom.us/j/pending-proposal-ac4-b',
    );

    const { proposalId: proposalIdA } = await seedUndecidedProposal(ownerA.workspaceId, meetingA);

    // Meeting B (a DIFFERENT meeting, in a DIFFERENT workspace) has no
    // proposal of its own at all -- it must never see workspace A's proposal.
    const responseB = await request(server)
      .get(meetingUrl(ownerB.workspaceId, meetingB))
      .set('Cookie', ownerB.cookie);
    expect(responseB.status).toBe(200);
    const meetingBBody = (responseB.body as GetMeetingEnvelope).meeting;
    expect('pendingProposal' in meetingBBody).toBe(false);
    expect(JSON.stringify(responseB.body)).not.toContain(proposalIdA);

    // Meeting A, read from its own real workspace, still sees its own
    // proposal correctly.
    const responseA = await request(server)
      .get(meetingUrl(ownerA.workspaceId, meetingA))
      .set('Cookie', ownerA.cookie);
    expect(responseA.status).toBe(200);
    const meetingABody = (responseA.body as GetMeetingEnvelope).meeting;
    expect(meetingABody.pendingProposal?.proposalId).toBe(proposalIdA);
  });
});
