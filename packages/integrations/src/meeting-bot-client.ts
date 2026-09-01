/**
 * Provider-agnostic third-party "meeting bot" invite contract (ADR-0030 §e,
 * `docs/adr/ADR-0030-notetaker-botu-mimarisi.md`). Concrete adapters (mock,
 * a real Recall.ai-style vendor, ...) implement this interface so callers
 * (`MeetingsService`) never depend on a specific vendor SDK — mirrors
 * `CalendarConnector`'s exact provider-agnostic-interface reasoning.
 */

export interface MeetingBotInviteRequest {
  meetingUrl: string;
  // `meeting_details.objectId` -- not used for webhook matching, passed to
  // the vendor only as "our own reference" (ADR-0030 §e).
  meetingObjectId: string;
}

export interface MeetingBotInviteResult {
  // Written to `meeting_details.providerMeetingRef` -- the webhook's (ADR-0030
  // §g) matching key.
  providerMeetingRef: string;
}

export interface MeetingBotClient {
  inviteBot(request: MeetingBotInviteRequest): Promise<MeetingBotInviteResult>;
}

/**
 * A thin, deterministic test double for `MeetingBotClient` — mirrors
 * `MockCalendarConnector`'s exact style (`./calendar-connector.ts`): records
 * every `inviteBot` call (in order, with the exact request received) via a
 * readonly array property, and returns a deterministic, per-instance
 * sequential `providerMeetingRef` (`mock-bot-${counter}`, counter starting at
 * 1). Never throws — this mock's job is deterministic recording only, same
 * "no existence validation" reasoning as `MockCalendarConnector.updateEvent`/
 * `deleteEvent`.
 */
export class MockMeetingBotClient implements MeetingBotClient {
  readonly invitedMeetings: Array<{ request: MeetingBotInviteRequest }> = [];

  private counter = 0;

  inviteBot(request: MeetingBotInviteRequest): Promise<MeetingBotInviteResult> {
    this.counter += 1;
    const providerMeetingRef = `mock-bot-${String(this.counter)}`;
    this.invitedMeetings.push({ request });
    return Promise.resolve({ providerMeetingRef });
  }
}
