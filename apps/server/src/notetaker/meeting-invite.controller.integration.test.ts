import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockMeetingBotClient } from '@luminaos/integrations';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { meetingDetails } from '../db/schema/meeting-details.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T13 PR3 (RED step, part 3 of 3) — `POST /workspaces/:workspaceId/meetings`
 * (ad hoc bot invite) + `GET /workspaces/:workspaceId/meetings/:meetingId`
 * (ADR-0030 §e/§h/§i, `docs/adr/ADR-0030-notetaker-botu-mimarisi.md`). NONE
 * of this PR's code exists yet: `apps/server/src/notetaker/` currently
 * contains only this PR's sibling RED files
 * (`detect-meeting-provider.test.ts`) — no `meetings.service.ts`, no
 * `meeting-invite.controller.ts`, no `notetaker.module.ts`, no
 * `meeting-bot-client.token.ts`, and `AppModule` does not import any
 * notetaker module yet.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `apps/server/src/notetaker/meeting-bot-client.token.ts` (new) --
 *    `export const MEETING_BOT_CLIENT = 'MEETING_BOT_CLIENT';`, mirroring
 *    `../calendar/calendar-connector.token.ts`'s exact "own zero-dependency
 *    token module" reasoning, so this test can `.overrideProvider(
 *    MEETING_BOT_CLIENT).useValue(mockBotClient)` without pulling in the
 *    whole notetaker module's wiring.
 *
 * B. `apps/server/src/notetaker/meetings.service.ts` (new) --
 *    `MeetingsService.inviteBot(workspaceId, actor, callerRole, {meetingUrl})`
 *    -- detects the provider via `detectMeetingProvider` (ValidationError,
 *    400, propagated BEFORE any `ObjectsService.create`/`MeetingBotClient.
 *    inviteBot`/`meeting_details` insert happens -- see tests 4a/4b/4c below),
 *    creates a `meeting` LuminaObject via the EXISTING `ObjectsService.create`
 *    (no new object-CRUD path), invites the bot via the injected
 *    `MeetingBotClient`, and inserts exactly one `meeting_details` row.
 *    `MeetingsService.getMeetingDetails(workspaceId, meetingId, callerRole)`
 *    -- `NotFoundError` (404) if no `meeting_details` row exists for that
 *    `objectId` OR if the `meeting` object does not belong to `workspaceId`
 *    (same "doesn't exist in this scope, not a membership failure" 404
 *    convention as `objects.integration.test.ts`'s cross-workspace GET test,
 *    NOT 403); otherwise returns the meeting's metadata always, and
 *    `transcriptText` ONLY when `hasAtLeastRole(callerRole, 'member')` is
 *    true (ADR-0030 §h verbatim -- `guest` sees everything else, never 403).
 *
 * C. `apps/server/src/notetaker/meeting-invite.controller.ts` (new) --
 *    `@Controller('workspaces/:workspaceId/meetings')`,
 *    `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)` at class level
 *    (identical guard stack to `ObjectsController`).
 *
 *    `POST /` -- body `{meetingUrl: string}` (zod, `.strict()`), 201:
 *      { object: ObjectWithFieldValues; meetingDetails: {
 *          id: string; objectId: string; meetingUrl: string;
 *          provider: 'google-meet' | 'zoom' | 'microsoft-teams';
 *          status: 'sunuldu' | 'beklemede' | 'kaydedildi' | 'basarisiz';
 *          providerMeetingRef: string;
 *          providerRecordingUrl: string | null;
 *          transcriptText: string | null;
 *          createdAt: string;
 *      } }
 *      `object.objectType` MUST be `'meeting'`. An unrecognized `meetingUrl`
 *      -> 400 (ValidationError from `detectMeetingProvider`), and this MUST
 *      happen before any side effect: no `MeetingBotClient.inviteBot` call
 *      recorded, no `meeting` object created, no `meeting_details` row
 *      inserted (tests 4a/4b/4c).
 *
 *    `GET /:meetingId` -- 200:
 *      { meeting: {
 *          id: string; title: string; meetingUrl: string;
 *          provider: 'google-meet' | 'zoom' | 'microsoft-teams';
 *          status: 'sunuldu' | 'beklemede' | 'kaydedildi' | 'basarisiz';
 *          createdAt: string;
 *          transcriptText?: string; // present iff hasAtLeastRole(callerRole, 'member')
 *      } }
 *      404 for a nonexistent `meetingId` OR one belonging to a different
 *      workspace than the URL's `:workspaceId` (test 6/7).
 *
 * D. `apps/server/src/notetaker/notetaker.module.ts` (new) -- provides
 *    `MeetingsService`, `MeetingBotClient` under the `MEETING_BOT_CLIENT`
 *    token (real adapter, ADR-0030 §e — this test overrides it), and
 *    `MeetingInviteController`. `AppModule` (modify) imports it.
 *
 * ----------------------------------------------------------------------------
 * HARNESS NOTE: mirrors `../calendar/calendar-events.integration.test.ts`'s
 * exact Testcontainers Postgres 16 + Redis 7 + dynamic-`AppModule`-import +
 * `.overrideProvider` pattern. `MockMeetingBotClient` is a SINGLE shared
 * instance across this whole file's tests (recreating the Nest app per test
 * is not this codebase's convention) -- so assertions about "was `inviteBot`
 * called" use either (a) a snapshot-before/compare-after diff of
 * `mockBotClient.invitedMeetings` (test 4a/4b/4c's "no new call" assertion,
 * order-independent regardless of what earlier tests in this file already
 * recorded) or (b) a lookup BY `meetingObjectId` (tests 1/2/3's "the right
 * call happened" assertions) -- never an absolute index/count, since this
 * mock's counter/array are NOT reset between tests in this file (unlike the
 * dedicated, single-instance-per-test unit tests in
 * `../../../packages/integrations/src/meeting-bot-client.test.ts`, which pin
 * the exact `mock-bot-1`/`mock-bot-2` sequencing contract).
 *
 * `memberships`/`addMemberWithRole` raw-insert pattern copied from
 * `../fields/field-definitions-security.integration.test.ts` (Finding 2's
 * `guestCookie = await addMemberWithRole(workspaceId, 'guest')` precedent) --
 * the ONLY way to get a `guest`/`member`/`admin` session in this codebase's
 * test suites, since there is no invite-by-email HTTP flow yet.
 *
 * Test 5's `transcriptText` seeding uses a DIRECT raw Drizzle update against
 * `meeting_details` (not the webhook, which doesn't exist until PR4) --
 * exactly as this PR's task instructions call out as expected/fine.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `beforeAll` itself fails -- the dynamic
 * `import('./meeting-bot-client.token.js')` rejects ("Cannot find module"),
 * which alone fails every `it` in this file (mirrors
 * `calendar-events.integration.test.ts`'s identical "poller service import
 * rejects in beforeAll" red-state precedent). Once that file exists, every
 * `POST`/`GET` under `/workspaces/:workspaceId/meetings` 404s as an unmatched
 * route (no `NotetakerModule` wired into `AppModule` yet) -- including the
 * tests that expect 400/404, which will actually see a plain Nest
 * "Cannot POST/GET ..." 404 rather than this codebase's `AppError`-shaped
 * body, mirroring `objects.integration.test.ts`'s header-comment note for
 * the same situation.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface MeetingObjectBody {
  id: string;
  objectType: string;
  title: string;
}

interface MeetingDetailsBody {
  id: string;
  objectId: string;
  meetingUrl: string;
  provider: string;
  status: string;
  providerMeetingRef: string;
  providerRecordingUrl: string | null;
  transcriptText: string | null;
  createdAt: string;
}

interface InviteMeetingEnvelope {
  object: MeetingObjectBody;
  meetingDetails: MeetingDetailsBody;
}

interface MeetingReadBody {
  id: string;
  title: string;
  meetingUrl: string;
  provider: string;
  status: string;
  createdAt: string;
  transcriptText?: string;
}

interface GetMeetingEnvelope {
  meeting: MeetingReadBody;
}

interface ObjectListEnvelope {
  objects: Array<{ id: string; objectType: string }>;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `meeting-invite-test-user-${String(emailCounter)}@example.com`;
}

interface MeetingBotClientTokenModule {
  MEETING_BOT_CLIENT: string;
}

describe('F2-T13 PR3 (RED step): POST/GET .../meetings -- MeetingBotClient invite + role-filtered read (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let mockBotClient: MockMeetingBotClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    // `./meeting-bot-client.token.js` does not exist yet -- this dynamic
    // import is the file's primary, unavoidable RED signal (see header
    // comment's EXPECTED RED STATE section).
    const tokenModule =
      (await import('./meeting-bot-client.token.js')) as unknown as MeetingBotClientTokenModule;

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
      .send({ name: `Meeting invite test workspace ${String(emailCounter)}` });
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

  function meetingsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/meetings`;
  }

  function meetingUrl(workspaceId: string, meetingId: string): string {
    return `/workspaces/${workspaceId}/meetings/${meetingId}`;
  }

  it('1. POST .../meetings with a meet.google.com URL -> 201, creates a "meeting" object AND a meeting_details row with provider "google-meet" and the mock bot client\'s recorded providerMeetingRef', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const googleMeetUrl = 'https://meet.google.com/aaa-bbbb-ccc';

    const response = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ meetingUrl: googleMeetUrl });

    expect(response.status).toBe(201);
    const body = response.body as InviteMeetingEnvelope;
    expect(body.object.objectType).toBe('meeting');
    expect(body.meetingDetails.objectId).toBe(body.object.id);
    expect(body.meetingDetails.meetingUrl).toBe(googleMeetUrl);
    expect(body.meetingDetails.provider).toBe('google-meet');
    expect(body.meetingDetails.status).toBe('sunuldu');

    const recordedInvite = mockBotClient.invitedMeetings.find(
      (entry) => entry.request.meetingObjectId === body.object.id,
    );
    expect(recordedInvite).toBeDefined();
    expect(recordedInvite?.request.meetingUrl).toBe(googleMeetUrl);
    expect(body.meetingDetails.providerMeetingRef).toMatch(/^mock-bot-\d+$/);

    const [row] = await rawDb
      .select()
      .from(meetingDetails)
      .where(eq(meetingDetails.objectId, body.object.id));
    expect(row?.provider).toBe('google-meet');
    expect(row?.providerMeetingRef).toBe(body.meetingDetails.providerMeetingRef);
  });

  it('2. POST .../meetings with a zoom.us URL -> provider "zoom"', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const zoomUrl = 'https://zoom.us/j/1234567890';

    const response = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ meetingUrl: zoomUrl });

    expect(response.status).toBe(201);
    const body = response.body as InviteMeetingEnvelope;
    expect(body.meetingDetails.provider).toBe('zoom');
    expect(body.meetingDetails.meetingUrl).toBe(zoomUrl);
  });

  it('3. POST .../meetings with a teams.microsoft.com URL -> provider "microsoft-teams"', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const teamsUrl = 'https://teams.microsoft.com/l/meetup-join/abc';

    const response = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ meetingUrl: teamsUrl });

    expect(response.status).toBe(201);
    const body = response.body as InviteMeetingEnvelope;
    expect(body.meetingDetails.provider).toBe('microsoft-teams');
    expect(body.meetingDetails.meetingUrl).toBe(teamsUrl);
  });

  it('4a. POST .../meetings with an unrecognized URL -> 400, and NO new MeetingBotClient.inviteBot call is recorded', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const invitesBefore = [...mockBotClient.invitedMeetings];
    const unsupportedUrl = 'https://example.com/some-link';

    const response = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ meetingUrl: unsupportedUrl });

    expect(response.status).toBe(400);
    expect(mockBotClient.invitedMeetings).toEqual(invitesBefore);
  });

  it('4b. POST .../meetings with an unrecognized URL does NOT create a "meeting" object', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const listBefore = await request(server)
      .get(meetingsUrl(workspaceId).replace('/meetings', '/objects'))
      .set('Cookie', cookie);
    expect(listBefore.status).toBe(200);
    const countBefore = (listBefore.body as ObjectListEnvelope).objects.length;

    const response = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ meetingUrl: 'https://example.com/some-other-unsupported-link' });
    expect(response.status).toBe(400);

    const listAfter = await request(server)
      .get(meetingsUrl(workspaceId).replace('/meetings', '/objects'))
      .set('Cookie', cookie);
    expect(listAfter.status).toBe(200);
    const countAfter = (listAfter.body as ObjectListEnvelope).objects.length;

    expect(countAfter).toBe(countBefore);
    expect(
      (listAfter.body as ObjectListEnvelope).objects.some((o) => o.objectType === 'meeting'),
    ).toBe(false);
  });

  it('4c. POST .../meetings with an unrecognized URL does NOT insert a meeting_details row for that URL', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const unsupportedUrl = 'https://example.com/yet-another-unsupported-link';

    const response = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ meetingUrl: unsupportedUrl });
    expect(response.status).toBe(400);

    const rows = await rawDb
      .select()
      .from(meetingDetails)
      .where(eq(meetingDetails.meetingUrl, unsupportedUrl));
    expect(rows).toHaveLength(0);
  });

  it('5. GET .../meetings/:meetingId includes transcriptText for member/admin/owner callers when the row has one set', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();

    const inviteResponse = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send({ meetingUrl: 'https://meet.google.com/ddd-eeee-fff' });
    expect(inviteResponse.status).toBe(201);
    const meetingId = (inviteResponse.body as InviteMeetingEnvelope).object.id;

    const transcript = 'Full unfiltered transcript content for this meeting.';
    await rawDb
      .update(meetingDetails)
      .set({ transcriptText: transcript })
      .where(eq(meetingDetails.objectId, meetingId));

    const ownerReadResponse = await request(server)
      .get(meetingUrl(workspaceId, meetingId))
      .set('Cookie', ownerCookie);
    expect(ownerReadResponse.status).toBe(200);
    expect((ownerReadResponse.body as GetMeetingEnvelope).meeting.transcriptText).toBe(transcript);

    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const memberReadResponse = await request(server)
      .get(meetingUrl(workspaceId, meetingId))
      .set('Cookie', memberCookie);
    expect(memberReadResponse.status).toBe(200);
    expect((memberReadResponse.body as GetMeetingEnvelope).meeting.transcriptText).toBe(transcript);

    const adminCookie = await addMemberWithRole(workspaceId, 'admin');
    const adminReadResponse = await request(server)
      .get(meetingUrl(workspaceId, meetingId))
      .set('Cookie', adminCookie);
    expect(adminReadResponse.status).toBe(200);
    expect((adminReadResponse.body as GetMeetingEnvelope).meeting.transcriptText).toBe(transcript);
  });

  it('6. GET .../meetings/:meetingId for a "guest" caller omits transcriptText but still returns title/meetingUrl/provider/status (ADR-0030 §h, most important RBAC test in this PR)', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();

    const inviteResponse = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send({ meetingUrl: 'https://zoom.us/j/5555555555' });
    expect(inviteResponse.status).toBe(201);
    const meetingId = (inviteResponse.body as InviteMeetingEnvelope).object.id;

    const transcript = 'Sensitive raw transcript that guests must never see.';
    await rawDb
      .update(meetingDetails)
      .set({ transcriptText: transcript })
      .where(eq(meetingDetails.objectId, meetingId));

    const guestCookie = await addMemberWithRole(workspaceId, 'guest');
    const guestReadResponse = await request(server)
      .get(meetingUrl(workspaceId, meetingId))
      .set('Cookie', guestCookie);

    expect(guestReadResponse.status).toBe(200);
    const guestMeeting = (guestReadResponse.body as GetMeetingEnvelope).meeting;
    expect(guestMeeting.transcriptText).toBeUndefined();
    // The transcript content must never leak anywhere in the guest's response body.
    expect(JSON.stringify(guestReadResponse.body)).not.toContain(transcript);

    // Metadata is still fully visible to guest -- this is an EXTRA field
    // filter, not an access denial.
    expect(guestMeeting.meetingUrl).toBe('https://zoom.us/j/5555555555');
    expect(guestMeeting.provider).toBe('zoom');
    expect(guestMeeting.status).toBe('sunuldu');
    expect(guestMeeting.id).toBe(meetingId);
  });

  it('7. GET .../meetings/:meetingId for a nonexistent meetingId -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .get(meetingUrl(workspaceId, 'not-a-real-meeting-id'))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it("8. GET .../meetings/:meetingId for a meetingId that belongs to a DIFFERENT workspace -> 404 (mirrors objects.integration.test.ts's cross-workspace GET precedent, not 403)", async () => {
    const ownerA = await registerOwnerWithWorkspace();
    const ownerB = await registerOwnerWithWorkspace();

    const inviteResponse = await request(server)
      .post(meetingsUrl(ownerA.workspaceId))
      .set('Cookie', ownerA.cookie)
      .send({ meetingUrl: 'https://meet.google.com/ggg-hhhh-iii' });
    expect(inviteResponse.status).toBe(201);
    const meetingId = (inviteResponse.body as InviteMeetingEnvelope).object.id;

    const crossWorkspaceResponse = await request(server)
      .get(meetingUrl(ownerB.workspaceId, meetingId))
      .set('Cookie', ownerB.cookie);

    expect(crossWorkspaceResponse.status).toBe(404);

    // The meeting is still perfectly reachable through its real workspace.
    const ownWorkspaceResponse = await request(server)
      .get(meetingUrl(ownerA.workspaceId, meetingId))
      .set('Cookie', ownerA.cookie);
    expect(ownWorkspaceResponse.status).toBe(200);
  });

  it('9. guard stack: unauthenticated -> 401, authenticated non-member -> 403 (POST and GET)', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const unauthenticatedPost = await request(server)
      .post(meetingsUrl(workspaceId))
      .send({ meetingUrl: 'https://meet.google.com/jjj-kkkk-lll' });
    expect(unauthenticatedPost.status).toBe(401);

    const outsider = await registerOwnerWithWorkspace();
    const nonMemberPost = await request(server)
      .post(meetingsUrl(workspaceId))
      .set('Cookie', outsider.cookie)
      .send({ meetingUrl: 'https://meet.google.com/mmm-nnnn-ooo' });
    expect(nonMemberPost.status).toBe(403);
  });
});
