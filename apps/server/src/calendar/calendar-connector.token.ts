/**
 * The Nest DI token for the workspace's `CalendarConnector` (F1-T12 PR5b).
 * Deliberately factored out of `calendar-connector.module.ts` into its own
 * zero-dependency module — mirrors `ai/ai-provider.token.ts`'s exact
 * reasoning: a consumer that only needs this token for
 * `@Inject(CALENDAR_CONNECTOR)` must not be forced to transitively pull in
 * `calendar-connector.module.ts`'s provider wiring.
 */
export const CALENDAR_CONNECTOR = 'CALENDAR_CONNECTOR';
