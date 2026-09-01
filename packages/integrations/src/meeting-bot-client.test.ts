import { describe, expect, it } from 'vitest';

import { MockMeetingBotClient } from './meeting-bot-client.js';

import type { MeetingBotInviteRequest } from './meeting-bot-client.js';

/**
 * F2-T13 PR3 (RED step, part 1 of 3) — `MeetingBotClient` interface +
 * `MockMeetingBotClient` test double (ADR-0030 §e, `docs/adr/ADR-0030-
 * notetaker-botu-mimarisi.md`, "[ARCHITECT KARARI] `MeetingBotClient` arayüzü
 * + somut adapter şekli"). This file does NOT exist as implementation yet —
 * `./meeting-bot-client.js` (new) must export exactly:
 *
 *   export interface MeetingBotInviteRequest {
 *     meetingUrl: string;
 *     meetingObjectId: string;
 *   }
 *
 *   export interface MeetingBotInviteResult {
 *     providerMeetingRef: string;
 *   }
 *
 *   export interface MeetingBotClient {
 *     inviteBot(request: MeetingBotInviteRequest): Promise<MeetingBotInviteResult>;
 *   }
 *
 *   export class MockMeetingBotClient implements MeetingBotClient { ... }
 *
 * `MockMeetingBotClient` mirrors `MockCalendarConnector`'s exact style
 * (`./calendar-connector.ts`, see `./calendar-connector.test.ts` for the
 * precedent this file matches): a deterministic test double that
 *   - records every `inviteBot` call, inspectable via a readonly array
 *     property (this test file asserts on `invitedMeetings`, an
 *     `Array<{ request: MeetingBotInviteRequest }>` — if the implementer
 *     chooses a different property name/shape, only THIS file's read of that
 *     property needs to change, not the contract's intent: every call must be
 *     recorded, in order, with the exact request it received),
 *   - returns a deterministic `providerMeetingRef` of the exact shape
 *     `mock-bot-${counter}`, counter starting at 1 and incrementing per call
 *     (mirrors `MockCalendarConnector.createEvent`'s `mock-event-${counter}`
 *     pattern verbatim — see `./calendar-connector.ts:92-97`),
 *   - never throws (this mock's job is deterministic recording, same
 *     "no existence validation" reasoning as `MockCalendarConnector.
 *     updateEvent`/`deleteEvent`).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): this file fails at MODULE RESOLUTION time —
 * `./meeting-bot-client.js` does not exist, so both the value import
 * (`MockMeetingBotClient`) and the type import (`MeetingBotInviteRequest`)
 * fail to resolve. `pnpm typecheck`/`pnpm lint` on this package must report a
 * "module not found"/`import-x/no-unresolved` finding at this import, not a
 * bug in this test file's own logic.
 * ============================================================================
 */

function buildInviteRequest(
  overrides: Partial<MeetingBotInviteRequest> = {},
): MeetingBotInviteRequest {
  return {
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    meetingObjectId: 'seed-meeting-object-1',
    ...overrides,
  };
}

describe('MockMeetingBotClient — inviteBot', () => {
  it('returns a deterministic sequential providerMeetingRef starting at mock-bot-1', async () => {
    const client = new MockMeetingBotClient();

    const result = await client.inviteBot(buildInviteRequest());

    expect(result).toEqual({ providerMeetingRef: 'mock-bot-1' });
  });

  it('increments the counter across multiple calls on the same instance (mock-bot-1, mock-bot-2, ...)', async () => {
    const client = new MockMeetingBotClient();

    const first = await client.inviteBot(buildInviteRequest({ meetingObjectId: 'object-a' }));
    const second = await client.inviteBot(buildInviteRequest({ meetingObjectId: 'object-b' }));
    const third = await client.inviteBot(buildInviteRequest({ meetingObjectId: 'object-c' }));

    expect(first).toEqual({ providerMeetingRef: 'mock-bot-1' });
    expect(second).toEqual({ providerMeetingRef: 'mock-bot-2' });
    expect(third).toEqual({ providerMeetingRef: 'mock-bot-3' });
  });

  it('the counter is per-instance, not global/shared across separate MockMeetingBotClient instances', async () => {
    const clientA = new MockMeetingBotClient();
    const clientB = new MockMeetingBotClient();

    const resultA1 = await clientA.inviteBot(buildInviteRequest());
    const resultB1 = await clientB.inviteBot(buildInviteRequest());
    const resultA2 = await clientA.inviteBot(buildInviteRequest());

    expect(resultA1).toEqual({ providerMeetingRef: 'mock-bot-1' });
    expect(resultB1).toEqual({ providerMeetingRef: 'mock-bot-1' });
    expect(resultA2).toEqual({ providerMeetingRef: 'mock-bot-2' });
  });

  it('records every call, in order, with the exact request it received', async () => {
    const client = new MockMeetingBotClient();
    const requestOne = buildInviteRequest({
      meetingUrl: 'https://zoom.us/j/1234567890',
      meetingObjectId: 'object-zoom',
    });
    const requestTwo = buildInviteRequest({
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      meetingObjectId: 'object-teams',
    });

    await client.inviteBot(requestOne);
    await client.inviteBot(requestTwo);

    expect(client.invitedMeetings).toEqual([{ request: requestOne }, { request: requestTwo }]);
  });

  it('never throws for any well-formed request (deterministic recording only, no existence validation)', async () => {
    const client = new MockMeetingBotClient();

    await expect(
      client.inviteBot(buildInviteRequest({ meetingObjectId: 'never-seen-before' })),
    ).resolves.toEqual({ providerMeetingRef: 'mock-bot-1' });
  });

  it('starts with an empty invitedMeetings array before any call', () => {
    const client = new MockMeetingBotClient();

    expect(client.invitedMeetings).toEqual([]);
  });
});
