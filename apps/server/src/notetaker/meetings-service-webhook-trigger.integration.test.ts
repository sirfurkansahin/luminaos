import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockMeetingBotClient } from '@luminaos/integrations';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { meetingDetails } from '../db/schema/meeting-details.js';

import type { MeetingDetailsRow, MeetingsService } from './meetings.service.js';
import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { Mock } from 'vitest';

/**
 * F2-T14 PR5 (RED step, part 1 of 2) — webhook-triggered action extraction in
 * `MeetingsService.applyWebhookUpdate` (ADR-0031 §e/§h/§i).
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `applyWebhookUpdate` gains a new side effect: whenever the incoming
 * `update` NEWLY populates `transcriptText` -- i.e. the `transcriptText` KEY
 * is present in `update` AND its value is a non-null, non-empty string, AND
 * the row's PREVIOUS `transcriptText` value (read BEFORE this update is
 * applied) was null/empty -- `MeetingsService` calls
 * `CommandsService.proposeFromMeeting(workspaceId, meetingObjectId,
 * transcriptText)` EXACTLY ONCE, using the row's OWN `workspaceId` and
 * `objectId` columns (NOT any value taken from the webhook payload itself).
 *
 * This is deliberately a ONE-TIME transition trigger, not "fires whenever
 * transcriptText is present": a webhook update that OMITS the
 * `transcriptText` key entirely, or explicitly sends `transcriptText: null`,
 * must NOT trigger a call -- and once a row already has non-empty
 * `transcriptText`, a LATER webhook update carrying a new/different
 * `transcriptText` value must NOT trigger a second call (fires once, on
 * first population, never again for that row).
 *
 * The call is fire-and-forget from `applyWebhookUpdate`'s own perspective:
 * `applyWebhookUpdate` must resolve successfully even if
 * `CommandsService.proposeFromMeeting` rejects -- a failing AI extraction
 * must never fail the webhook's own persistence step (ADR-0031 §i).
 *
 * ============================================================================
 * HARNESS NOTE: mirrors `./meetings-service-webhook.integration.test.ts`'s
 * EXACT Testcontainers Postgres 16 + Redis 7 + dynamic-`AppModule`-import +
 * `.overrideProvider(MEETING_BOT_CLIENT)` pattern, seeding real
 * `meeting_details` rows via a real HTTP `POST .../meetings` call (through
 * `MeetingsService.inviteBot`) rather than a raw insert. `CommandsService` is
 * ADDITIONALLY overridden (`.overrideProvider(CommandsService).useValue(...)`,
 * same "swap a real collaborator for a `vi.fn()`-backed stub" technique this
 * codebase already uses for `MEETING_BOT_CLIENT`/`MeetingBotClient`) so this
 * file can assert exact call count/args/fire-and-forget behavior without
 * depending on a real `AIProvider`/quota state. `applyWebhookUpdate` itself is
 * called DIRECTLY against the `MeetingsService` instance resolved from the
 * compiled `TestingModule` (`moduleRef.get(MeetingsService)`), one level below
 * the HTTP webhook controller -- same convention as the sibling PR4 webhook
 * test this file extends.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `MeetingsService.applyWebhookUpdate` has no
 * `CommandsService` dependency and no proposal-triggering logic at all -- the
 * stubbed `proposeFromMeeting` mock is NEVER called by any test below, so
 * every "was called" assertion fails (the "was NOT called" assertions
 * currently pass vacuously, which is expected and fine; they exist to pin the
 * negative contract once the positive trigger is implemented). This is the
 * correct red, not a test-logic bug.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface MeetingDetailsBody {
  id: string;
  objectId: string;
  providerMeetingRef: string;
}

interface InviteMeetingEnvelope {
  object: { id: string; objectType: string; title: string };
  meetingDetails: MeetingDetailsBody;
}

interface MeetingBotClientTokenModule {
  MEETING_BOT_CLIENT: string;
}

interface CommandsServiceParseResultStub {
  proposalId: string;
  actions: unknown[];
  parseError: boolean;
}

interface CommandsServiceStub {
  proposeFromMeeting: Mock<
    (
      workspaceId: string,
      meetingObjectId: string,
      transcriptText: string,
    ) => Promise<CommandsServiceParseResultStub>
  >;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `meetings-service-webhook-trigger-test-user-${String(emailCounter)}@example.com`;
}

describe('MeetingsService.applyWebhookUpdate triggers CommandsService.proposeFromMeeting on first transcript population (F2-T14 PR5 RED step, ADR-0031 §h/§i, real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let meetingsService: MeetingsService;
  let mockBotClient: MockMeetingBotClient;
  let mockProposeFromMeeting: CommandsServiceStub['proposeFromMeeting'];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const tokenModule =
      (await import('./meeting-bot-client.token.js')) as unknown as MeetingBotClientTokenModule;

    // Deferred to here (after `DATABASE_URL` is set) for the SAME reason
    // `./meetings-service-webhook.integration.test.ts` defers its own
    // `MeetingsService` import -- transitively reaches `../config/env.js`'s
    // module-level `readEnv()`, which `process.exit(1)`s if `DATABASE_URL`
    // isn't set yet.
    const { MeetingsService } = await import('./meetings.service.js');
    const { CommandsService } = await import('../commands/commands.service.js');

    mockBotClient = new MockMeetingBotClient();
    mockProposeFromMeeting = vi.fn();

    const commandsServiceStub: CommandsServiceStub = {
      proposeFromMeeting: mockProposeFromMeeting,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(tokenModule.MEETING_BOT_CLIENT)
      .useValue(mockBotClient)
      .overrideProvider(CommandsService)
      .useValue(commandsServiceStub)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
    meetingsService = moduleRef.get(MeetingsService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  beforeEach(() => {
    mockProposeFromMeeting.mockReset();
    mockProposeFromMeeting.mockResolvedValue({
      proposalId: 'stub-proposal-id',
      actions: [],
      parseError: false,
    });
  });

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
      .send({ name: `Meetings webhook-trigger test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function seedMeeting(meetingUrl: string): Promise<{
    objectId: string;
    providerMeetingRef: string;
    workspaceId: string;
  }> {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const inviteResponse = await request(server)
      .post(`/workspaces/${workspaceId}/meetings`)
      .set('Cookie', cookie)
      .send({ meetingUrl });
    expect(inviteResponse.status).toBe(201);
    const body = inviteResponse.body as InviteMeetingEnvelope;

    return {
      objectId: body.object.id,
      providerMeetingRef: body.meetingDetails.providerMeetingRef,
      workspaceId,
    };
  }

  async function readMeetingDetailsRow(objectId: string): Promise<MeetingDetailsRow | undefined> {
    const [row] = await rawDb
      .select()
      .from(meetingDetails)
      .where(eq(meetingDetails.objectId, objectId));
    return row;
  }

  it("1. a webhook update that NEWLY populates transcriptText (previous value was null) calls proposeFromMeeting exactly once with the row's workspaceId/objectId/transcriptText", async () => {
    const seeded = await seedMeeting('https://meet.google.com/webhook-trigger-first-pop');
    const rowBefore = await readMeetingDetailsRow(seeded.objectId);
    expect(rowBefore?.transcriptText).toBeNull();

    const transcriptText = 'First-time transcript delivered by the webhook.';
    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
      transcriptText,
    });

    expect(mockProposeFromMeeting).toHaveBeenCalledTimes(1);
    expect(mockProposeFromMeeting).toHaveBeenCalledWith(
      seeded.workspaceId,
      seeded.objectId,
      transcriptText,
    );
  });

  it('2. a webhook update that OMITS the transcriptText key entirely does NOT call proposeFromMeeting', async () => {
    const seeded = await seedMeeting('https://zoom.us/j/webhook-trigger-omitted-key');

    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
    });

    expect(mockProposeFromMeeting).not.toHaveBeenCalled();
  });

  it('3. a webhook update that sends transcriptText: null (explicit clear) does NOT call proposeFromMeeting', async () => {
    const seeded = await seedMeeting(
      'https://teams.microsoft.com/l/meetup-join/webhook-trigger-null',
    );

    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
      transcriptText: null,
    });

    expect(mockProposeFromMeeting).not.toHaveBeenCalled();
  });

  it('4. once transcriptText is already non-empty, a LATER webhook update carrying a different transcriptText value does NOT re-trigger a second call', async () => {
    const seeded = await seedMeeting('https://meet.google.com/webhook-trigger-no-retrigger');

    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
      transcriptText: 'First content -- this is the one and only trigger.',
    });
    expect(mockProposeFromMeeting).toHaveBeenCalledTimes(1);

    mockProposeFromMeeting.mockClear();

    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
      transcriptText: 'Second, DIFFERENT content -- must not trigger again.',
    });

    expect(mockProposeFromMeeting).not.toHaveBeenCalled();
  });

  it('5. fire-and-forget: applyWebhookUpdate resolves successfully even when proposeFromMeeting REJECTS', async () => {
    mockProposeFromMeeting.mockReset();
    mockProposeFromMeeting.mockRejectedValue(
      new Error('Simulated proposeFromMeeting failure -- must not fail the webhook update.'),
    );

    const seeded = await seedMeeting('https://zoom.us/j/webhook-trigger-fire-and-forget');

    await expect(
      meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
        status: 'kaydedildi',
        transcriptText: 'Content that triggers a rejecting proposeFromMeeting call.',
      }),
    ).resolves.toBeUndefined();

    // Give the (fire-and-forget) rejected promise's own internal handler a
    // microtask/timer turn to run, so a real implementation's rejection
    // handling doesn't surface as an unhandled rejection after this test ends.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = await readMeetingDetailsRow(seeded.objectId);
    expect(row?.status).toBe('kaydedildi');
  });
});
