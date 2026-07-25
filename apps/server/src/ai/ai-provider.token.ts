/**
 * The Nest DI token for the workspace's `AIProvider` (F1-T5 PR-C).
 * Deliberately factored out of `ai-provider.module.ts` into its own
 * zero-dependency module — mirrors `db/database-connection.token.ts` /
 * `redis/redis-connection.token.ts`'s exact reasoning: a consumer that only
 * needs this token for `@Inject(AI_PROVIDER)` must not be forced to
 * transitively pull in `ai-provider.module.ts`'s top-level `env` import.
 */
export const AI_PROVIDER = 'AI_PROVIDER';
