/**
 * Provider-agnostic external calendar sync contract. Concrete connectors
 * (mock, Google, Outlook, ...) implement this interface so callers never
 * depend on a specific vendor SDK — mirrors packages/ai-gateway's
 * AIProvider abstraction. See ADR-0012 §d.
 */

export interface ExternalCalendarEvent {
  externalId: string;
  title: string;
  start: string; // ISO-8601 datetime
  end: string; // ISO-8601 datetime
  meetingUrl?: string; // optional — a calendar event may have no video-call link
}

export interface TimeBlockDraft {
  title: string;
  start: string; // ISO-8601 datetime
  end: string; // ISO-8601 datetime
}

/** `accessToken`/`refreshToken` are real OAuth secrets once a real connector lands — never log, print, or serialize them (mirrors `apps/server/src/observability/redact.ts`'s token-field redaction convention). PR5 stores them encrypted-at-rest via `packages/shared`'s `encryptSecret`/`decryptSecret` (ADR-0012 §c). */
export interface CalendarAccount {
  id: string;
  provider: 'google' | 'outlook';
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO-8601 datetime
}

/** See `CalendarAccount`'s doc comment — same never-log guidance applies to `accessToken`/`refreshToken` here. */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO-8601 datetime
}

export interface CalendarConnector {
  listEvents(range: { start: string; end: string }): Promise<ExternalCalendarEvent[]>;
  createEvent(draft: TimeBlockDraft): Promise<{ externalId: string }>;
  updateEvent(externalId: string, draft: TimeBlockDraft): Promise<void>;
  deleteEvent(externalId: string): Promise<void>;
  refreshToken(account: CalendarAccount): Promise<RefreshedTokens>;
}

export type RefreshTokenResponder = (
  account: CalendarAccount,
) => RefreshedTokens | Promise<RefreshedTokens>;

export interface MockCalendarConnectorOptions {
  events?: ExternalCalendarEvent[];
  refreshTokenResponder?: RefreshTokenResponder;
}

/**
 * A thin, deterministic test double for `CalendarConnector`. `createEvent`,
 * `updateEvent`, and `deleteEvent` record their calls for assertions rather
 * than simulating full CRUD-consistency; `refreshToken` without a configured
 * `refreshTokenResponder` derives a deterministic successful refresh from
 * `account.expiresAt`, otherwise it is a thin pass-through to the responder
 * (mirrors `MockProvider`'s responder semantics exactly).
 */
export class MockCalendarConnector implements CalendarConnector {
  readonly createdEvents: Array<{ externalId: string; draft: TimeBlockDraft }> = [];
  readonly updatedEvents: Array<{ externalId: string; draft: TimeBlockDraft }> = [];
  readonly deletedEventIds: string[] = [];

  private readonly events: ExternalCalendarEvent[];
  private readonly refreshTokenResponder: RefreshTokenResponder | undefined;
  private counter = 0;

  constructor(options: MockCalendarConnectorOptions = {}) {
    this.events = options.events ?? [];
    this.refreshTokenResponder = options.refreshTokenResponder;
  }

  listEvents(range: { start: string; end: string }): Promise<ExternalCalendarEvent[]> {
    const rangeStart = new Date(range.start).getTime();
    const rangeEnd = new Date(range.end).getTime();

    const result = this.events
      .filter((event) => {
        const eventStart = new Date(event.start).getTime();
        const eventEnd = new Date(event.end).getTime();
        return eventStart < rangeEnd && eventEnd > rangeStart;
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    return Promise.resolve(result);
  }

  createEvent(draft: TimeBlockDraft): Promise<{ externalId: string }> {
    this.counter += 1;
    const externalId = `mock-event-${String(this.counter)}`;
    this.createdEvents.push({ externalId, draft });
    return Promise.resolve({ externalId });
  }

  updateEvent(externalId: string, draft: TimeBlockDraft): Promise<void> {
    this.updatedEvents.push({ externalId, draft });
    return Promise.resolve();
  }

  deleteEvent(externalId: string): Promise<void> {
    this.deletedEventIds.push(externalId);
    return Promise.resolve();
  }

  async refreshToken(account: CalendarAccount): Promise<RefreshedTokens> {
    if (this.refreshTokenResponder) {
      return this.refreshTokenResponder(account);
    }

    return {
      accessToken: 'mock-refreshed-access-token',
      expiresAt: new Date(new Date(account.expiresAt).getTime() + 3_600_000).toISOString(),
    };
  }

  static fixed(events: ExternalCalendarEvent[]): MockCalendarConnector {
    return new MockCalendarConnector({ events });
  }
}
