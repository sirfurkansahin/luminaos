import { createHmac } from 'node:crypto';

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

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T13 PR4 (RED step, part 3 of 3) — `POST /webhooks/notetaker`
 * (ADR-0030 §f/§g): full HTTP round-trip through a real Nest
 * `TestingModule` + `supertest`, proving `NotetakerWebhookAuthGuard` +
 * `NotetakerWebhookController` + `MeetingsService.applyWebhookUpdate` wired
 * together correctly. NONE of this PR's code exists yet:
 * `apps/server/src/notetaker/` currently contains only this PR's sibling RED
 * files (`./notetaker-webhook-auth.guard.test.ts`,
 * `./meetings-service-webhook.integration.test.ts`,
 * `../config/env-notetaker.test.ts`) -- no
 * `notetaker-webhook-auth.guard.ts`, no `notetaker-webhook.controller.ts`,
 * no `dto/notetaker-webhook.schema.ts`, and `NotetakerModule` does not wire
 * any of them into `AppModule` yet.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `apps/server/src/notetaker/dto/notetaker-webhook.schema.ts` (new) --
 *    zod schema: `{ providerMeetingRef: z.string().min(1); status:
 *    z.enum(['kaydedildi', 'basarisiz']); transcriptText:
 *    z.string().nullable().optional(); providerRecordingUrl:
 *    z.string().nullable().optional(); }`, validated via the EXISTING
 *    `ZodValidationPipe` convention (`../common/zod-validation.pipe.ts`,
 *    same as `./dto/invite-meeting.schema.ts`).
 *
 * B. `apps/server/src/notetaker/notetaker-webhook-auth.guard.ts` (new) --
 *    `NotetakerWebhookAuthGuard implements CanActivate`, covered in
 *    isolation by `./notetaker-webhook-auth.guard.test.ts`; this file only
 *    exercises it through the real HTTP layer (its behavior is NOT
 *    re-derived here, only its wiring into the controller).
 *
 * C. `apps/server/src/notetaker/notetaker-webhook.controller.ts` (new) --
 *    `@Controller('webhooks/notetaker')` (NO `:workspaceId` in the path,
 *    ADR-0030 §g), `@UseGuards(NotetakerWebhookAuthGuard)` as the ONLY guard
 *    (no `SessionAuthGuard`/`WorkspaceMembershipGuard` -- there is no user
 *    identity on this path). `@Post()` handler: validates the body against
 *    (A)'s schema, calls `MeetingsService.applyWebhookUpdate(...)`, returns
 *    200 with `{ received: true }`.
 *
 * D. `NotetakerModule` (modify) -- registers `NotetakerWebhookController` +
 *    `NotetakerWebhookAuthGuard`.
 *
 * ----------------------------------------------------------------------------
 * HARNESS NOTE: mirrors `./meeting-invite.controller.integration.test.ts`'s
 * EXACT Testcontainers Postgres 16 + Redis 7 + dynamic-`AppModule`-import +
 * `.overrideProvider(MEETING_BOT_CLIENT)` pattern, with TWO additions:
 *
 *   1. `process.env.NOTETAKER_WEBHOOK_SECRET` is set to a fixed test value
 *      BEFORE the dynamic `import('../app.module.js')` in `beforeAll` --
 *      `env.ts`'s singleton (`export const env: Env = readEnv();`) is
 *      evaluated exactly once, the FIRST time anything in this worker
 *      imports it (transitively, via `AppModule`), so the env var must be in
 *      place before that first import, mirroring `DATABASE_URL`/
 *      `REDIS_URL`'s identical "set right before the dynamic AppModule
 *      import" placement in every sibling integration test file.
 *
 *   2. `moduleRef.createNestApplication({ rawBody: true })` -- the SAME
 *      option Nest's real bootstrap (`main.ts`) needs (ADR-0030 §f's literal
 *      implementation note: `bodyParser.json({verify: (req, _res, buf) => {
 *      req.rawBody = buf; }})`-equivalent), so `request.rawBody` is
 *      populated for `NotetakerWebhookAuthGuard` to HMAC over. This test
 *      file does NOT modify/inspect `main.ts` (out of scope per this task's
 *      instructions) -- it only ensures ITS OWN test app instance sets this
 *      option, since `Test.createTestingModule(...).compile()` +
 *      `moduleRef.createNestApplication()` builds a fresh
 *      `INestApplication`, not the one `main.ts` would build.
 *
 * Signatures are computed over the EXACT raw JSON string sent on the wire
 * (`JSON.stringify(payload)`), never re-serialized by supertest -- verified
 * against `superagent`'s own `send()` implementation: for a STRING argument
 * with `Content-Type: application/json` already set, superagent
 * concatenates the string as-is (`this._data = (this._data || '') + data`),
 * it does NOT re-run `JSON.stringify` on an already-string payload. This is
 * required because a webhook signature MUST be computed over the raw wire
 * bytes (ADR-0030 §f) -- if this file instead called `.send(payloadObject)`
 * (an object, not a string), superagent would JSON-encode it INTERNALLY with
 * potentially different key ordering/whitespace than this file's own
 * `JSON.stringify(payload)` used to compute the signature, causing spurious
 * signature mismatches unrelated to the guard's actual correctness.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `beforeAll` itself fails -- the dynamic
 * `import('./meeting-bot-client.token.js')` succeeds (PR3 already created
 * it), but nothing routes `POST /webhooks/notetaker` yet (no
 * `NotetakerWebhookController`, not wired into `AppModule`), so EVERY test
 * below receives a plain Nest "Cannot POST /webhooks/notetaker" 404 instead
 * of this file's expected 200/401/404 `AppError`-shaped responses -- this is
 * the correct red, not a test-logic bug (mirrors
 * `objects.integration.test.ts`'s identical "unmatched route" red-state
 * precedent for a not-yet-wired controller).
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';
const WEBHOOK_SECRET = 'notetaker-webhook-controller-test-secret-value';

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

interface WebhookPayload {
  providerMeetingRef: string;
  status: 'kaydedildi' | 'basarisiz';
  transcriptText?: string | null;
  providerRecordingUrl?: string | null;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `notetaker-webhook-test-user-${String(emailCounter)}@example.com`;
}

function computeSignature(secret: string, rawBodyString: string): string {
  return createHmac('sha256', secret).update(rawBodyString).digest('hex');
}

describe('POST /webhooks/notetaker (F2-T13 PR4 RED step, ADR-0030 §f/§g -- real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    // MUST be set before `env.ts`'s singleton is first (transitively)
    // evaluated by the dynamic `AppModule` import below -- see this file's
    // header comment, HARNESS NOTE point 1.
    process.env.NOTETAKER_WEBHOOK_SECRET = WEBHOOK_SECRET;

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const tokenModule =
      (await import('./meeting-bot-client.token.js')) as unknown as MeetingBotClientTokenModule;

    mockBotClient = new MockMeetingBotClient();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(tokenModule.MEETING_BOT_CLIENT)
      .useValue(mockBotClient)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
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
      .send({ name: `Notetaker webhook test workspace ${String(emailCounter)}` });
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

  async function readMeetingDetailsByObjectId(objectId: string): Promise<
    | {
        status: string;
        transcriptText: string | null;
        providerRecordingUrl: string | null;
      }
    | undefined
  > {
    const [row] = await rawDb
      .select()
      .from(meetingDetails)
      .where(eq(meetingDetails.objectId, objectId));
    return row;
  }

  async function sendWebhook(
    payload: WebhookPayload,
    options?: { signatureHeader?: string | null },
  ): Promise<request.Response> {
    const rawBodyString = JSON.stringify(payload);
    const signature =
      options?.signatureHeader === null
        ? undefined
        : (options?.signatureHeader ?? computeSignature(WEBHOOK_SECRET, rawBodyString));

    const req = request(server).post('/webhooks/notetaker').type('json');
    if (signature !== undefined) {
      req.set('X-Notetaker-Signature', signature);
    }
    return req.send(rawBodyString);
  }

  it('1. valid signature + valid payload for a KNOWN providerMeetingRef -> 200, and the underlying meeting_details row is actually updated', async () => {
    const seeded = await seedMeeting('https://meet.google.com/webhook-controller-test-aaa');

    const response = await sendWebhook({
      providerMeetingRef: seeded.providerMeetingRef,
      status: 'kaydedildi',
      transcriptText: 'Webhook-delivered transcript, HTTP round-trip test.',
      providerRecordingUrl: 'https://recordings.example.com/webhook-controller-test-1',
    });

    expect(response.status).toBe(200);
    expect((response.body as { received: boolean }).received).toBe(true);

    const row = await readMeetingDetailsByObjectId(seeded.objectId);
    expect(row?.status).toBe('kaydedildi');
    expect(row?.transcriptText).toBe('Webhook-delivered transcript, HTTP round-trip test.');
    expect(row?.providerRecordingUrl).toBe(
      'https://recordings.example.com/webhook-controller-test-1',
    );
  });

  it('2. missing X-Notetaker-Signature header entirely -> 401, and the row is NOT updated', async () => {
    const seeded = await seedMeeting('https://zoom.us/j/webhook-controller-test-missing-sig');

    const response = await sendWebhook(
      {
        providerMeetingRef: seeded.providerMeetingRef,
        status: 'kaydedildi',
        transcriptText: 'This must NEVER be persisted.',
      },
      { signatureHeader: null },
    );

    expect(response.status).toBe(401);

    const row = await readMeetingDetailsByObjectId(seeded.objectId);
    expect(row?.status).toBe('sunuldu');
    expect(row?.transcriptText).toBeNull();
  });

  it('3. wrong/invalid signature -> 401, and the row is NOT updated', async () => {
    const seeded = await seedMeeting(
      'https://teams.microsoft.com/l/meetup-join/webhook-controller-test-wrong-sig',
    );

    const response = await sendWebhook(
      {
        providerMeetingRef: seeded.providerMeetingRef,
        status: 'kaydedildi',
        transcriptText: 'This must NEVER be persisted either.',
      },
      { signatureHeader: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    );

    expect(response.status).toBe(401);

    const row = await readMeetingDetailsByObjectId(seeded.objectId);
    expect(row?.status).toBe('sunuldu');
    expect(row?.transcriptText).toBeNull();
  });

  it('4. valid signature but UNKNOWN providerMeetingRef -> 4xx (NotFoundError via AppErrorFilter), and no row anywhere is created/modified', async () => {
    const rowsBefore = await rawDb.select().from(meetingDetails);

    const response = await sendWebhook({
      providerMeetingRef: 'never-issued-provider-meeting-ref-controller-test',
      status: 'basarisiz',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    const rowsAfter = await rawDb.select().from(meetingDetails);
    expect(rowsAfter).toHaveLength(rowsBefore.length);
  });

  it("5. cross-workspace isolation: a correctly-signed webhook for workspace A's ref does NOT affect workspace B's meeting_details row", async () => {
    const meetingA = await seedMeeting('https://meet.google.com/webhook-controller-cross-a');
    const meetingB = await seedMeeting('https://meet.google.com/webhook-controller-cross-b');

    const rowBBefore = await readMeetingDetailsByObjectId(meetingB.objectId);
    expect(meetingA.workspaceId).not.toBe(meetingB.workspaceId);

    const response = await sendWebhook({
      providerMeetingRef: meetingA.providerMeetingRef,
      status: 'kaydedildi',
      transcriptText: "Transcript belonging ONLY to workspace A's meeting.",
    });

    expect(response.status).toBe(200);

    const rowBAfter = await readMeetingDetailsByObjectId(meetingB.objectId);
    expect(rowBAfter).toEqual(rowBBefore);

    const rowAAfter = await readMeetingDetailsByObjectId(meetingA.objectId);
    expect(rowAAfter?.status).toBe('kaydedildi');
    expect(rowAAfter?.transcriptText).toBe("Transcript belonging ONLY to workspace A's meeting.");
  });
});
