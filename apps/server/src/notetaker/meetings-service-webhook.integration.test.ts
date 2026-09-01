import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockMeetingBotClient } from '@luminaos/integrations';
import { NotFoundError } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { meetingDetails } from '../db/schema/meeting-details.js';

import type { MeetingDetailsRow, MeetingsService } from './meetings.service.js';
import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T13 PR4 (RED step, part 2 of 3) — `MeetingsService.applyWebhookUpdate`
 * (ADR-0030 §g), a NEW method on the EXISTING `MeetingsService`
 * (`./meetings.service.ts`, already has `inviteBot`/`getMeetingDetails` from
 * PR3 -- this file adds coverage for a THIRD method only, it does not
 * duplicate PR3's own `meeting-invite.controller.integration.test.ts`
 * coverage of `inviteBot`/`getMeetingDetails`).
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   applyWebhookUpdate(
 *     providerMeetingRef: string,
 *     update: {
 *       status: 'kaydedildi' | 'basarisiz';
 *       transcriptText?: string | null;
 *       providerRecordingUrl?: string | null;
 *     },
 *   ): Promise<void>
 *
 * Looks up the `meeting_details` row by `providerMeetingRef` (unique index,
 * ADR-0030 §d). No matching row -> `NotFoundError` (`@luminaos/shared`) with
 * a GENERIC message that does NOT embed/leak the `providerMeetingRef` value
 * itself (ADR-0030 §g: "hangi ref'in var/yok olduğu saldırgana
 * SIZDIRILMAZ", same discipline as ADR-0026 §i) -- and does NOT create or
 * modify any row as a side effect.
 *
 * If found: always updates `status`; updates `transcriptText`/
 * `providerRecordingUrl` ONLY when those keys are PRESENT in the `update`
 * object (own, documented judgment call per this task's instructions,
 * normal partial-update semantics) -- a webhook payload that omits
 * `transcriptText` entirely must NOT null out a previously-set
 * `transcriptText` (test 4 below is the one test proving this distinction;
 * it does NOT test the separate "explicit null clears it" question, which
 * this task deliberately leaves unpinned).
 *
 * ============================================================================
 * HARNESS NOTE: mirrors `./meeting-invite.controller.integration.test.ts`'s
 * EXACT Testcontainers Postgres 16 + Redis 7 + dynamic-`AppModule`-import +
 * `.overrideProvider(MEETING_BOT_CLIENT)` pattern, reusing the SAME
 * `MeetingsService.inviteBot` (via a real HTTP `POST .../meetings` call
 * through the compiled `AppModule`) to seed `meeting_details` rows with a
 * real `object_id`/`providerMeetingRef` pair -- rather than a raw, ad hoc
 * insert -- since a raw insert would need to independently reproduce
 * `meeting_details`'s NOT NULL columns and could silently drift from the
 * real `inviteBot` insert shape. `applyWebhookUpdate` itself is then called
 * DIRECTLY against the `MeetingsService` instance resolved from the same
 * compiled `TestingModule` (`moduleRef.get(MeetingsService)`) -- this PR's
 * webhook HTTP controller/guard are COVERED SEPARATELY by
 * `./notetaker-webhook.controller.integration.test.ts`; this file is scoped
 * to `MeetingsService`'s own update/lookup/partial-update logic in
 * isolation, one level below the HTTP layer. This mirrors PR3's own
 * precedent of testing `MeetingsService` exclusively through
 * Testcontainers-backed integration coverage (no standalone
 * `meetings.service.test.ts` unit file exists for `inviteBot`/
 * `getMeetingDetails` either) -- `applyWebhookUpdate` follows the SAME
 * established convention rather than inventing a mocked-`db` unit test as a
 * parallel, redundant style.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `MeetingsService.applyWebhookUpdate` does not
 * exist -- every test's call to `meetingsService.applyWebhookUpdate(...)`
 * fails at runtime with "meetingsService.applyWebhookUpdate is not a
 * function" (the method truly doesn't exist on the class yet, TypeScript
 * would also reject this at compile time once `pnpm typecheck` runs) -- this
 * is the correct red, not a test-logic bug. `pnpm lint` also reports several
 * `@typescript-eslint/no-unsafe-*` findings at every `applyWebhookUpdate(...)`
 * call site today -- TypeScript's own error-recovery types the missing
 * member as an error/`any` type, which cascades into typed-lint findings at
 * each call site, same "isolated, EXPECTED lint finding caused by the
 * intentionally-missing implementation" category as
 * `../db/schema/meeting-details.integration.test.ts`'s own documented
 * precedent -- these clear once `implementer` adds the real method.
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

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `meetings-service-webhook-test-user-${String(emailCounter)}@example.com`;
}

describe('MeetingsService.applyWebhookUpdate (F2-T13 PR4 RED step, ADR-0030 §g, real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let meetingsService: MeetingsService;
  let mockBotClient: MockMeetingBotClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    // `./meeting-bot-client.token.js` already exists (PR3) -- this import
    // is NOT this file's red signal; `applyWebhookUpdate` not existing on
    // `MeetingsService` is.
    const tokenModule =
      (await import('./meeting-bot-client.token.js')) as unknown as MeetingBotClientTokenModule;

    // `MeetingsService` itself is imported here, dynamically, rather than
    // statically at the top of this file: it transitively imports
    // `../db/db.module.js`, which statically imports `env` from
    // `../config/env.js` -- and `env.ts`'s module-level `readEnv()` calls
    // `process.exit(1)` if `DATABASE_URL` isn't set. A static top-level
    // import would evaluate that chain at test-file COLLECTION time, before
    // `DATABASE_URL` is set above, killing the whole Vitest worker before
    // any test runs. Deferring the import to here (after `DATABASE_URL` is
    // set) avoids that -- mirrors this file's own `tokenModule` pattern and
    // `./meeting-invite.controller.integration.test.ts`'s established
    // "only dynamically import anything reaching the db layer" convention.
    const { MeetingsService } = await import('./meetings.service.js');

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
    meetingsService = moduleRef.get(MeetingsService);
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
      .send({ name: `Meetings service webhook test workspace ${String(emailCounter)}` });
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

  it('1. a webhook update for a KNOWN providerMeetingRef updates status/transcriptText/providerRecordingUrl correctly', async () => {
    const seeded = await seedMeeting('https://meet.google.com/webhook-test-aaa-bbbb-ccc');

    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
      transcriptText: 'Full transcript delivered by the webhook.',
      providerRecordingUrl: 'https://recordings.example.com/webhook-test-1',
    });

    const row = await readMeetingDetailsRow(seeded.objectId);
    expect(row?.status).toBe('kaydedildi');
    expect(row?.transcriptText).toBe('Full transcript delivered by the webhook.');
    expect(row?.providerRecordingUrl).toBe('https://recordings.example.com/webhook-test-1');
  });

  it('2. a webhook update for an UNKNOWN providerMeetingRef throws NotFoundError, without leaking the ref in the message, and creates/modifies no row', async () => {
    const unknownRef = 'never-issued-provider-meeting-ref-999';

    const rowsBefore = await rawDb.select().from(meetingDetails);

    const updatePromise = meetingsService.applyWebhookUpdate(unknownRef, {
      status: 'basarisiz',
    });

    await expect(updatePromise).rejects.toBeInstanceOf(NotFoundError);
    await updatePromise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(unknownRef);
    });

    const rowsAfter = await rawDb.select().from(meetingDetails);
    expect(rowsAfter).toHaveLength(rowsBefore.length);
  });

  it('3. cross-isolation: a webhook update targeting ref A leaves a DIFFERENT meeting_details row (ref B, a different workspace) completely untouched', async () => {
    const meetingA = await seedMeeting('https://zoom.us/j/webhook-cross-isolation-a');
    const meetingB = await seedMeeting('https://zoom.us/j/webhook-cross-isolation-b');

    const rowBBefore = await readMeetingDetailsRow(meetingB.objectId);

    await meetingsService.applyWebhookUpdate(meetingA.providerMeetingRef, {
      status: 'kaydedildi',
      transcriptText: 'Transcript belonging ONLY to meeting A.',
      providerRecordingUrl: 'https://recordings.example.com/cross-isolation-a',
    });

    const rowBAfter = await readMeetingDetailsRow(meetingB.objectId);
    expect(rowBAfter).toEqual(rowBBefore);

    const rowAAfter = await readMeetingDetailsRow(meetingA.objectId);
    expect(rowAAfter?.status).toBe('kaydedildi');
    expect(rowAAfter?.transcriptText).toBe('Transcript belonging ONLY to meeting A.');
  });

  it('4. partial-update semantics: a SECOND webhook call that omits transcriptText/providerRecordingUrl entirely does NOT null out values a PRIOR call already set', async () => {
    const seeded = await seedMeeting('https://teams.microsoft.com/l/meetup-join/webhook-partial');

    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
      transcriptText: 'First-call transcript that must survive the second call.',
      providerRecordingUrl: 'https://recordings.example.com/webhook-partial-first',
    });

    // Second call: `update` object has NO `transcriptText`/`providerRecordingUrl`
    // KEYS at all (not `undefined` values -- the keys are simply absent),
    // simulating a webhook that only reports a later status change.
    await meetingsService.applyWebhookUpdate(seeded.providerMeetingRef, {
      status: 'kaydedildi',
    });

    const row = await readMeetingDetailsRow(seeded.objectId);
    expect(row?.status).toBe('kaydedildi');
    expect(row?.transcriptText).toBe('First-call transcript that must survive the second call.');
    expect(row?.providerRecordingUrl).toBe('https://recordings.example.com/webhook-partial-first');
  });
});
