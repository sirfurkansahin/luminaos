import { describe, expect, it } from 'vitest';

import { MockCalendarConnector } from './calendar-connector.js';

import type {
  CalendarAccount,
  ExternalCalendarEvent,
  TimeBlockDraft,
} from './calendar-connector.js';

/**
 * Designed contract (must be matched exactly by implementer — F1-T12 PR4,
 * red step; see ADR-0012 §d):
 *
 *   export interface ExternalCalendarEvent {
 *     externalId: string;
 *     title: string;
 *     start: string; // ISO-8601 datetime
 *     end: string;   // ISO-8601 datetime
 *   }
 *
 *   export interface TimeBlockDraft {
 *     title: string;
 *     start: string; // ISO-8601 datetime
 *     end: string;   // ISO-8601 datetime
 *   }
 *
 *   export interface CalendarAccount {
 *     id: string;
 *     provider: 'google' | 'outlook';
 *     accessToken: string;
 *     refreshToken: string;
 *     expiresAt: string; // ISO-8601 datetime
 *   }
 *
 *   export interface RefreshedTokens {
 *     accessToken: string;
 *     refreshToken?: string;
 *     expiresAt: string; // ISO-8601 datetime
 *   }
 *
 *   export interface CalendarConnector {
 *     listEvents(range: { start: string; end: string }): Promise<ExternalCalendarEvent[]>;
 *     createEvent(draft: TimeBlockDraft): Promise<{ externalId: string }>;
 *     updateEvent(externalId: string, draft: TimeBlockDraft): Promise<void>;
 *     deleteEvent(externalId: string): Promise<void>;
 *     refreshToken(account: CalendarAccount): Promise<RefreshedTokens>;
 *   }
 *
 *   export type RefreshTokenResponder = (
 *     account: CalendarAccount,
 *   ) => RefreshedTokens | Promise<RefreshedTokens>;
 *
 *   export interface MockCalendarConnectorOptions {
 *     events?: ExternalCalendarEvent[];
 *     refreshTokenResponder?: RefreshTokenResponder;
 *   }
 *
 *   export class MockCalendarConnector implements CalendarConnector {
 *     readonly createdEvents: Array<{ externalId: string; draft: TimeBlockDraft }>;
 *     readonly updatedEvents: Array<{ externalId: string; draft: TimeBlockDraft }>;
 *     readonly deletedEventIds: string[];
 *     constructor(options?: MockCalendarConnectorOptions);
 *     static fixed(events: ExternalCalendarEvent[]): MockCalendarConnector;
 *   }
 *
 * `MockCalendarConnector` is a deterministic test double:
 *  - `listEvents` filters seeded `events` by standard interval overlap
 *    (`event.start < range.end && event.end > range.start`), sorted by
 *    `start` ascending.
 *  - `createEvent` assigns sequential ids `mock-event-1`, `mock-event-2`, ...
 *    via a plain counter (no `crypto.randomUUID()` — keeps this package
 *    dependency-free, mirrors ai-gateway's zero-Node-API design) and records
 *    the call in `createdEvents`.
 *  - `updateEvent`/`deleteEvent` record calls unconditionally (no existence
 *    validation — this mock's job is deterministic call recording for
 *    assertions, not simulating every real-world 404 path).
 *  - `refreshToken` without a configured `refreshTokenResponder` returns a
 *    deterministic successful refresh derived from `account.expiresAt`
 *    (+1 hour), with no `refreshToken` field in the response. With a
 *    configured responder, it is a thin pass-through (mirrors
 *    `MockProvider`'s responder semantics exactly) — calls the responder
 *    with the exact `account` and returns/propagates exactly what it
 *    returns/throws.
 *  - `MockCalendarConnector.fixed(events)` is `new MockCalendarConnector({ events })`.
 */

function buildEvent(overrides: Partial<ExternalCalendarEvent> = {}): ExternalCalendarEvent {
  return {
    externalId: 'seed-event-1',
    title: 'Seeded event',
    start: '2026-08-10T10:00:00.000Z',
    end: '2026-08-10T11:00:00.000Z',
    ...overrides,
  };
}

function buildDraft(overrides: Partial<TimeBlockDraft> = {}): TimeBlockDraft {
  return {
    title: 'A time block',
    start: '2026-08-10T09:00:00.000Z',
    end: '2026-08-10T10:00:00.000Z',
    ...overrides,
  };
}

function buildAccount(overrides: Partial<CalendarAccount> = {}): CalendarAccount {
  return {
    id: 'account-1',
    provider: 'google',
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    expiresAt: '2026-08-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('MockCalendarConnector — listEvents overlap filtering', () => {
  it('includes an event fully inside the requested range', async () => {
    const event = buildEvent({
      externalId: 'inside',
      start: '2026-08-10T10:15:00.000Z',
      end: '2026-08-10T10:45:00.000Z',
    });
    const connector = MockCalendarConnector.fixed([event]);

    const result = await connector.listEvents({
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T11:00:00.000Z',
    });

    expect(result).toContainEqual(event);
  });

  it('includes an event that partially overlaps the start boundary of the range', async () => {
    const event = buildEvent({
      externalId: 'overlaps-start',
      start: '2026-08-10T09:30:00.000Z',
      end: '2026-08-10T10:30:00.000Z',
    });
    const connector = MockCalendarConnector.fixed([event]);

    const result = await connector.listEvents({
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T11:00:00.000Z',
    });

    expect(result).toContainEqual(event);
  });

  it('includes an event that partially overlaps the end boundary of the range', async () => {
    const event = buildEvent({
      externalId: 'overlaps-end',
      start: '2026-08-10T10:30:00.000Z',
      end: '2026-08-10T11:30:00.000Z',
    });
    const connector = MockCalendarConnector.fixed([event]);

    const result = await connector.listEvents({
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T11:00:00.000Z',
    });

    expect(result).toContainEqual(event);
  });

  it('excludes an event entirely before the range with no overlap', async () => {
    const event = buildEvent({
      externalId: 'before-range',
      start: '2026-08-10T08:00:00.000Z',
      end: '2026-08-10T09:00:00.000Z',
    });
    const connector = MockCalendarConnector.fixed([event]);

    const result = await connector.listEvents({
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T11:00:00.000Z',
    });

    expect(result).not.toContainEqual(event);
  });

  it('excludes an event entirely after the range with no overlap', async () => {
    const event = buildEvent({
      externalId: 'after-range',
      start: '2026-08-10T12:00:00.000Z',
      end: '2026-08-10T13:00:00.000Z',
    });
    const connector = MockCalendarConnector.fixed([event]);

    const result = await connector.listEvents({
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T11:00:00.000Z',
    });

    expect(result).not.toContainEqual(event);
  });

  it('returns results sorted by start ascending, regardless of seed order', async () => {
    const later = buildEvent({
      externalId: 'later',
      start: '2026-08-10T10:40:00.000Z',
      end: '2026-08-10T10:50:00.000Z',
    });
    const earliest = buildEvent({
      externalId: 'earliest',
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T10:10:00.000Z',
    });
    const middle = buildEvent({
      externalId: 'middle',
      start: '2026-08-10T10:20:00.000Z',
      end: '2026-08-10T10:30:00.000Z',
    });
    const connector = MockCalendarConnector.fixed([later, earliest, middle]);

    const result = await connector.listEvents({
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T11:00:00.000Z',
    });

    expect(result.map((e) => e.externalId)).toEqual(['earliest', 'middle', 'later']);
  });

  it('returns an empty array when no events were seeded', async () => {
    const connector = new MockCalendarConnector();

    const result = await connector.listEvents({
      start: '2026-08-10T10:00:00.000Z',
      end: '2026-08-10T11:00:00.000Z',
    });

    expect(result).toEqual([]);
  });
});

describe('MockCalendarConnector — createEvent', () => {
  it('returns a deterministic sequential id and records the call in createdEvents', async () => {
    const connector = new MockCalendarConnector();
    const firstDraft = buildDraft({ title: 'First block' });
    const secondDraft = buildDraft({ title: 'Second block' });

    const first = await connector.createEvent(firstDraft);
    const second = await connector.createEvent(secondDraft);

    expect(first).toEqual({ externalId: 'mock-event-1' });
    expect(second).toEqual({ externalId: 'mock-event-2' });
    expect(connector.createdEvents).toEqual([
      { externalId: 'mock-event-1', draft: firstDraft },
      { externalId: 'mock-event-2', draft: secondDraft },
    ]);
  });
});

describe('MockCalendarConnector — updateEvent', () => {
  it('records the call in updatedEvents without throwing, even for an externalId never created via this instance', async () => {
    const connector = new MockCalendarConnector();
    const draft = buildDraft({ title: 'Updated block' });

    await expect(connector.updateEvent('never-created-id', draft)).resolves.toBeUndefined();

    expect(connector.updatedEvents).toEqual([{ externalId: 'never-created-id', draft }]);
  });
});

describe('MockCalendarConnector — deleteEvent', () => {
  it('records the id in deletedEventIds without throwing', async () => {
    const connector = new MockCalendarConnector();

    await expect(connector.deleteEvent('some-id')).resolves.toBeUndefined();

    expect(connector.deletedEventIds).toEqual(['some-id']);
  });
});

describe('MockCalendarConnector — refreshToken without a configured responder', () => {
  it('returns a deterministic successful refresh derived from account.expiresAt (+1 hour), with no refreshToken field', async () => {
    const connector = new MockCalendarConnector();
    const account = buildAccount({ expiresAt: '2026-08-10T12:00:00.000Z' });

    const result = await connector.refreshToken(account);

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.expiresAt).toBe('2026-08-10T13:00:00.000Z');
    expect(result.refreshToken).toBeUndefined();
  });
});

describe('MockCalendarConnector — refreshToken with a configured refreshTokenResponder', () => {
  it('calls the responder with the exact account passed to refreshToken and returns its result as-is', async () => {
    const seenAccounts: CalendarAccount[] = [];
    const scriptedResult = {
      accessToken: 'custom-access-token',
      refreshToken: 'custom-refresh-token',
      expiresAt: '2026-09-01T00:00:00.000Z',
    };
    const connector = new MockCalendarConnector({
      refreshTokenResponder: (account) => {
        seenAccounts.push(account);
        return scriptedResult;
      },
    });
    const account = buildAccount();

    const result = await connector.refreshToken(account);

    expect(seenAccounts).toEqual([account]);
    expect(result).toEqual(scriptedResult);
  });

  it('propagates a thrown error from the responder as a rejection', async () => {
    const connector = new MockCalendarConnector({
      refreshTokenResponder: () => {
        throw new Error('boom: refresh token expired and cannot be renewed');
      },
    });

    await expect(connector.refreshToken(buildAccount())).rejects.toThrow(
      'boom: refresh token expired and cannot be renewed',
    );
  });
});

describe('MockCalendarConnector.fixed — convenience constructor', () => {
  it('is equivalent to new MockCalendarConnector({ events })', async () => {
    const events = [
      buildEvent({
        externalId: 'a',
        start: '2026-08-10T10:00:00.000Z',
        end: '2026-08-10T10:30:00.000Z',
      }),
      buildEvent({
        externalId: 'b',
        start: '2026-08-10T10:30:00.000Z',
        end: '2026-08-10T11:00:00.000Z',
      }),
    ];
    const range = { start: '2026-08-10T10:00:00.000Z', end: '2026-08-10T11:00:00.000Z' };

    const viaFixed = MockCalendarConnector.fixed(events);
    const viaConstructor = new MockCalendarConnector({ events });

    const resultFixed = await viaFixed.listEvents(range);
    const resultConstructor = await viaConstructor.listEvents(range);

    expect(resultFixed).toEqual(resultConstructor);
  });
});
