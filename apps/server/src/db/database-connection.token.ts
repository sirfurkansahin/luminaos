/**
 * The Nest DI token for the shared Drizzle database client. Deliberately
 * factored out of `db.module.ts` into its own zero-dependency module: a
 * consumer that only needs this token for `@Inject(DATABASE_CONNECTION)`
 * (e.g. `EventStoreService`, which F0-T6's integration test constructs
 * directly with `new EventStoreService(db)`, outside of Nest DI entirely)
 * must not be forced to transitively pull in `db.module.ts`'s top-level
 * `env` import, which validates `DATABASE_URL` and calls `process.exit(1)`
 * if it's missing — a real Nest-app boot-time concern that has nothing to do
 * with merely referencing this constant.
 */
export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';
