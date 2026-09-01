/**
 * The Nest DI token for the workspace's `MeetingBotClient` (F2-T13 PR3).
 * Deliberately factored out of `notetaker.module.ts` into its own
 * zero-dependency module — mirrors `../calendar/calendar-connector.token.ts`'s
 * exact reasoning: a consumer that only needs this token for
 * `@Inject(MEETING_BOT_CLIENT)` must not be forced to transitively pull in
 * `notetaker.module.ts`'s provider wiring.
 */
export const MEETING_BOT_CLIENT = 'MEETING_BOT_CLIENT';
