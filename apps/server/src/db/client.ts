import { SpanStatusCode } from '@opentelemetry/api';
import {
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM_NAME,
  DB_SYSTEM_NAME_VALUE_POSTGRESQL,
} from '@opentelemetry/semantic-conventions';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.js';

import type { Tracer } from '@opentelemetry/api';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

const DB_QUERY_SPAN_NAME = 'pg.query';

/**
 * `pool.query(...)` is heavily overloaded (string form, `QueryConfig` form,
 * `Submittable`/stream form — see the installed `@types/pg`'s `index.d.ts`).
 * This only needs to recognize the two forms Drizzle's own
 * `node-postgres` driver actually uses (a plain string, or a `QueryConfig`
 * object carrying `.text`) well enough to extract the parameterized SQL TEXT
 * for a span attribute — it deliberately never looks at a `values`/params
 * argument (the second argument to `pool.query`), which is exactly the
 * bound-parameter array that must never end up in a span (see this module's
 * `wrapPoolQueryWithTracing` doc comment for why).
 */
function extractQueryText(firstArgument: unknown): string | undefined {
  if (typeof firstArgument === 'string') {
    return firstArgument;
  }

  if (
    typeof firstArgument === 'object' &&
    firstArgument !== null &&
    'text' in firstArgument &&
    typeof firstArgument.text === 'string'
  ) {
    return (firstArgument as { text: string }).text;
  }

  return undefined;
}

/**
 * Wraps `pool.query(...)` so every call is recorded as a child span named
 * `pg.query`, carrying only `db.system` and the parameterized SQL statement
 * text (`db.query.text`) as attributes.
 *
 * CRITICAL SECURITY CONSTRAINT (per the approved plan,
 * `giggly-brewing-moore.md`, Kapsam 3: "yalnızca parametreli SQL metni
 * attribute olur, asla değer dizisi"): this must NEVER read or record the
 * bound parameter VALUES `pg` passes alongside the query text (Drizzle's
 * `node-postgres` session calls `client.query(queryConfigWithText, values)`
 * — confirmed by reading the installed `drizzle-orm@0.45.2`'s
 * `node-postgres/session.js` — with `values` as a separate second argument,
 * never nested inside the first). `extractQueryText` above only ever reads
 * the first argument's string/`.text` shape and this function never touches
 * `arguments[1]` for anything other than passing it through, unread, to the
 * real `pool.query`.
 *
 * `pg`'s `Pool.query` is a prototype method, not an own property — assigning
 * a wrapped function directly onto this specific `pool` instance shadows it
 * for this instance only, without needing to subclass `Pool` (whose `query`
 * overload set is large enough that a type-safe subclass override would add
 * substantial complexity for no behavioral benefit here).
 */
function wrapPoolQueryWithTracing(pool: Pool, tracer: Tracer): void {
  const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;

  const tracedQuery = (...args: unknown[]): unknown =>
    tracer.startActiveSpan(DB_QUERY_SPAN_NAME, (span) => {
      span.setAttribute(ATTR_DB_SYSTEM_NAME, DB_SYSTEM_NAME_VALUE_POSTGRESQL);

      const queryText = extractQueryText(args[0]);
      if (queryText !== undefined) {
        span.setAttribute(ATTR_DB_QUERY_TEXT, queryText);
      }

      const endWithError = (error: unknown): never => {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      };

      let result: unknown;
      try {
        result = originalQuery(...args);
      } catch (error) {
        endWithError(error);
      }

      if (result instanceof Promise) {
        // `instanceof Promise` narrows the global (non-generic) `Promise`
        // type, whose resolved-value type parameter TypeScript infers as
        // `any` rather than preserving `unknown` — cast explicitly so the
        // `.then` callback's `value`/return stay soundly typed.
        return (result as Promise<unknown>).then(
          (value: unknown) => {
            span.end();
            return value;
          },
          (error: unknown) => endWithError(error),
        );
      }

      span.end();
      return result;
    });

  pool.query = tracedQuery as unknown as Pool['query'];
}

/**
 * Creates a Drizzle client backed by a `pg` connection pool.
 *
 * The connection string is accepted as a parameter (rather than read
 * directly from `env` here) so both the running application and the
 * Testcontainers-driven integration tests can point it at different
 * Postgres instances.
 *
 * `tracer` is optional: when provided (the real app wires it in via
 * `DbModule`'s DI, from `TracingModule`'s `TRACER` token), every pool query
 * is wrapped in a span — see `wrapPoolQueryWithTracing` above.
 */
export function createDatabaseClient(connectionString: string, tracer?: Tracer): Database {
  const pool = new Pool({ connectionString });

  if (tracer !== undefined) {
    wrapPoolQueryWithTracing(pool, tracer);
  }

  return drizzle(pool, { schema });
}
