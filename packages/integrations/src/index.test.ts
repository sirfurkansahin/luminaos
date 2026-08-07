import { describe, expect, it } from 'vitest';

import { MockCalendarConnector } from './index.js';

import type { CalendarConnector, ExternalCalendarEvent } from './index.js';

/**
 * Minimal barrel-export smoke test (mirrors packages/ai-gateway/src/index.test.ts):
 * confirms the calendar-connector contract is re-exported from ./index.js
 * once the implementer wires src/index.ts. Fails today because neither
 * src/index.ts nor src/calendar-connector.ts exist yet (F1-T12 PR4, red step).
 */
describe('@luminaos/integrations barrel exports', () => {
  it('re-exports MockCalendarConnector, usable as a CalendarConnector', async () => {
    const events: ExternalCalendarEvent[] = [
      {
        externalId: 'seed-1',
        title: 'Seeded event',
        start: '2026-08-10T10:00:00.000Z',
        end: '2026-08-10T11:00:00.000Z',
      },
    ];

    const connector: CalendarConnector = MockCalendarConnector.fixed(events);

    const result = await connector.listEvents({
      start: '2026-08-10T00:00:00.000Z',
      end: '2026-08-11T00:00:00.000Z',
    });

    expect(result).toEqual(events);
  });
});
