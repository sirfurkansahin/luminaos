import { Module } from '@nestjs/common';

import { MockCalendarConnector } from '@luminaos/integrations';
import type { CalendarConnector } from '@luminaos/integrations';

import { CALENDAR_CONNECTOR } from './calendar-connector.token.js';

export { CALENDAR_CONNECTOR };

/**
 * PLACEHOLDER wiring (F1-T12 PR5b): the factory ALWAYS returns a bare
 * `new MockCalendarConnector()` — real Google/Outlook adapters are a
 * deferred future task. When they land, this factory gains an env-based
 * branch mirroring `ai-provider.module.ts`'s `env.anthropicApiKey` branch
 * (e.g. selecting a real connector when OAuth credentials are configured,
 * falling back to the mock otherwise).
 */
@Module({
  providers: [
    {
      provide: CALENDAR_CONNECTOR,
      useFactory: (): CalendarConnector => new MockCalendarConnector(),
    },
  ],
  exports: [CALENDAR_CONNECTOR],
})
export class CalendarConnectorModule {}
