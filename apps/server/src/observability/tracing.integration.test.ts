import { Test } from '@nestjs/testing';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { Server } from 'node:http';

/**
 * Real, end-to-end integration test for F0-T8 PR-B (Kapsam 3 — OpenTelemetry
 * tracing). Per the approved plan (`giggly-brewing-moore.md`), this Kapsam
 * item has NO directly-gating acceptance criterion of its own (unlike PR-A's
 * AC1/AC2 or PR-C's AC3/AC4) — this file proves the manual/explicit tracing
 * MECHANISM actually works end-to-end (spans get created with plausible
 * names/attributes for both an HTTP request and a DB query it triggers, and
 * are exportable), not a specific business-behavior acceptance criterion.
 *
 * Follows the same Testcontainers + `Test.createTestingModule({imports:
 * [AppModule]})` + `supertest` pattern established in
 * `../auth/tenant-isolation.integration.test.ts`.
 *
 * =============================== HOW SPANS ARE CAPTURED (design decision +
 * flagged assumption for implementer)
 * ===============================================================
 *
 * Per the plan: "elle (manuel) span'ler, auto-instrumentation DEĞİL" — a
 * global `APP_INTERCEPTOR` wraps HTTP requests, and `createDatabaseClient`
 * gets an optional `Tracer` parameter for DB query spans. Neither
 * `tracing.ts`/`tracing.module.ts`/`http-tracing.interceptor.ts` exist yet,
 * so this test cannot import any concrete DI token names from them (they
 * would be guesses). Instead of guessing token names for a
 * `.overrideModule(TracingModule).useModule(...)`-style DI override (the
 * mechanism PR-A's `request-logging.integration.test.ts` used successfully
 * for `LoggingModule`, and a reasonable fallback if the approach below turns
 * out to be wrong), this test uses OpenTelemetry's own standard, well-known
 * GLOBAL tracer-provider registry (`@opentelemetry/api`'s `trace` object):
 *
 * 1. Before importing/building `AppModule` at all, this test constructs its
 *    own `NodeTracerProvider` wired to an `InMemorySpanExporter` (via a
 *    `SimpleSpanProcessor`, which exports synchronously on `span.end()` —
 *    deliberately NOT the batching processor a real console/OTLP exporter
 *    would use, so this test never needs to sleep/poll waiting for a batch
 *    flush interval) and calls `.register()` on it, making it the
 *    process-wide global `TracerProvider`.
 * 2. `AppModule` is then built and booted completely unmodified — no
 *    `.overrideModule(...)` call at all.
 *
 * ASSUMPTION FOR IMPLEMENTER (flagged, unverified — none of the real tracing
 * files exist yet): this relies on two things holding once PR-B is actually
 * implemented:
 *   (a) Wherever `HttpTracingInterceptor` and `createDatabaseClient`'s
 *       tracer wiring actually obtain the `Tracer` instance they use to
 *       start spans, they do so via `@opentelemetry/api`'s global registry
 *       (i.e. `trace.getTracer('...')`, or a `Tracer` that was itself
 *       obtained by calling `.getTracer()` on whatever provider
 *       `TracingModule`'s own `onModuleInit` registered) — NOT exclusively
 *       via a directly-constructed `Tracer` object injected through Nest DI
 *       that bypasses the global API entirely.
 *   (b) `@opentelemetry/api`'s well-known global-registration semantics: once
 *       a `TracerProvider` has been registered via `.register()`, a LATER
 *       `.register()` call from a *different* provider instance does not
 *       silently replace it (the API layer is documented/specified to log a
 *       diagnostic warning and keep the first registration, unless
 *       `overrideGlobal`/an equivalent explicit opt-in is passed) — meaning
 *       this test's `.register()` call (step 1, called first, before
 *       `AppModule`/`TracingModule` ever boots) "wins", and whatever
 *       provider `TracingModule.onModuleInit()` tries to register for real
 *       (console or OTLP, per the real `OTEL_EXPORTER_OTLP_ENDPOINT` env var)
 *       is harmlessly ignored for the lifetime of this test process.
 * If either assumption doesn't hold once the real implementation exists
 * (e.g. `TracingModule` hands out a DI-only `Tracer` that never touches the
 * global API), this test's `beforeAll` needs to switch to an explicit
 * `.overrideModule(TracingModule).useModule(...)` DI-level override instead
 * (mirroring `request-logging.integration.test.ts`'s `LoggingModule`
 * override) — please verify against the actual implementation and adjust
 * this file if the assumption doesn't hold, rather than silently leaving a
 * test that passes for the wrong reason.
 *
 * `NodeTracerProvider`'s exact constructor/span-processor-registration API
 * (`new NodeTracerProvider({ spanProcessors: [...] })` vs. the older
 * `new NodeTracerProvider(); provider.addSpanProcessor(...)`) depends on the
 * installed `@opentelemetry/sdk-trace-node`/`sdk-trace-base` version, which
 * is not installed yet at the time this test is written — this file uses
 * `addSpanProcessor`, documented across a wide range of versions; if the
 * version implementer installs has deprecated/removed it in favor of the
 * constructor-option form, adjust this test's `beforeAll` accordingly (a
 * mechanical, not logical, change).
 *
 * =============================== ATTRIBUTE-KEY-NAME UNCERTAINTY (flagged)
 * ===============================================================
 *
 * OpenTelemetry's HTTP semantic conventions changed key names between
 * versions (older/"stable-ish" convention: `http.method`, `http.route`,
 * `http.status_code`; newer 2023+ convention:
 * `http.request.method`, `http.response.status_code`, `url.path`). Since
 * `@opentelemetry/semantic-conventions` is not installed yet, this test does
 * NOT hardcode a single key name — it checks a small set of PLAUSIBLE
 * candidate keys per concept (method/route/status/db) via the
 * `firstDefinedAttribute` helper below. Implementer: once
 * `http-tracing.interceptor.ts`/`db/client.ts` are written, confirm the
 * ACTUAL attribute key names against whatever version of
 * `@opentelemetry/semantic-conventions` ends up installed (prefer its
 * exported constants, e.g. `ATTR_HTTP_REQUEST_METHOD` /
 * `SEMATTRS_HTTP_METHOD`, over hardcoded string literals in the real
 * implementation) and update the candidate-key lists below if the real key
 * used isn't already one of the candidates.
 *
 * DB span naming/attribute uncertainty: the plan only says a "pg.query"-ish
 * name/attribute set — `isLikelyDbSpan` below uses a loose heuristic (span
 * name containing "pg"/"query"/"sql"/an SQL verb, OR a `db.system`-shaped
 * attribute). Implementer: confirm the actual span name/attribute choice
 * made in `db/client.ts` and tighten this heuristic once real code exists,
 * if it turns out to be too loose or too narrow.
 */

const HTTP_METHOD_ATTRIBUTE_KEYS = ['http.method', 'http.request.method'];
const HTTP_ROUTE_ATTRIBUTE_KEYS = ['http.route', 'http.target', 'url.path'];
const HTTP_STATUS_ATTRIBUTE_KEYS = ['http.status_code', 'http.response.status_code'];
const DB_SYSTEM_ATTRIBUTE_KEYS = ['db.system'];
const DB_STATEMENT_ATTRIBUTE_KEYS = ['db.statement', 'db.query.text'];

function firstDefinedAttribute(
  span: ReadableSpan,
  candidateKeys: string[],
): { key: string; value: unknown } | undefined {
  for (const key of candidateKeys) {
    const value = span.attributes[key];
    if (value !== undefined) {
      return { key, value };
    }
  }
  return undefined;
}

function isLikelyHttpSpan(span: ReadableSpan): boolean {
  return firstDefinedAttribute(span, HTTP_METHOD_ATTRIBUTE_KEYS) !== undefined;
}

function isLikelyDbSpan(span: ReadableSpan): boolean {
  const nameLooksDbLike = /pg|sql|query|select|insert|update|delete/i.test(span.name);
  const hasDbSystemAttribute = firstDefinedAttribute(span, DB_SYSTEM_ATTRIBUTE_KEYS) !== undefined;
  return nameLooksDbLike || hasDbSystemAttribute;
}

describe('OpenTelemetry tracing (real Postgres + real HTTP, via Testcontainers + supertest + InMemorySpanExporter)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let exporter: InMemorySpanExporter;
  let testProvider: NodeTracerProvider;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    // F0-T8 PR-C ADDITION: AppModule now also imports a RedisModule, whose
    // REDIS_URL is validated fail-fast alongside DATABASE_URL (config/env.ts)
    // — started here purely so AppModule can boot; this file's own
    // assertions never touch Redis.
    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Register the in-memory-backed global TracerProvider BEFORE AppModule
    // is ever imported/booted -- see this file's header comment for why this
    // ordering, and the assumptions it rests on.
    exporter = new InMemorySpanExporter();
    testProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    testProvider.register();

    // NOTE for implementer: none of these modules/packages exist yet
    // ('@opentelemetry/api', '@opentelemetry/sdk-trace-base',
    // '@opentelemetry/sdk-trace-node', and this repo's own
    // './tracing.js'/'./tracing.module.js'/'./http-tracing.interceptor.js'
    // are all missing) -- this test is expected to fail with "Cannot find
    // module" until PR-B's implementation lands.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await app.close();
    await testProvider.shutdown();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  it('a GET /health request produces at least one span with HTTP-shaped attributes (method/route/status)', async () => {
    const server: Server = app.getHttpServer() as Server;

    const response = await request(server).get('/health');
    expect(response.status).toBeLessThan(500);

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    const httpSpan = spans.find(isLikelyHttpSpan);
    expect(
      httpSpan,
      "expected at least one recorded span to carry an HTTP-method-shaped attribute (see this file's header comment for the exact candidate key names implementer must confirm against the installed @opentelemetry/semantic-conventions version)",
    ).toBeDefined();

    const method = firstDefinedAttribute(httpSpan as ReadableSpan, HTTP_METHOD_ATTRIBUTE_KEYS);
    expect(method?.value).toBe('GET');

    const status = firstDefinedAttribute(httpSpan as ReadableSpan, HTTP_STATUS_ATTRIBUTE_KEYS);
    expect(status).toBeDefined();
    expect(Number(status?.value)).toBeGreaterThanOrEqual(200);
    expect(Number(status?.value)).toBeLessThan(500);

    const route = firstDefinedAttribute(httpSpan as ReadableSpan, HTTP_ROUTE_ATTRIBUTE_KEYS);
    expect(route).toBeDefined();
    expect(String(route?.value)).toContain('health');
  });

  it(
    'a POST /auth/register request (a real DB insert) also produces a DB-shaped span alongside the HTTP span, ' +
      'and NO span attribute anywhere (on any span) leaks the raw email or password submitted in the request body ' +
      '-- the single most important assertion in this file, per the plan\'s "yalnızca parametreli SQL metni attribute ' +
      'olur, asla değer dizisi" constraint',
    async () => {
      const server: Server = app.getHttpServer() as Server;

      const email = `tracing-pii-check-${String(Date.now())}@example.com`;
      const password = 'super-secret-tracing-test-password-do-not-leak';

      const response = await request(server).post('/auth/register').send({ email, password });
      expect(response.status).toBe(201);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);

      // A span for the HTTP request itself must exist.
      const httpSpan = spans.find(isLikelyHttpSpan);
      expect(httpSpan, 'expected an HTTP-shaped span for the /auth/register request').toBeDefined();
      const method = firstDefinedAttribute(httpSpan as ReadableSpan, HTTP_METHOD_ATTRIBUTE_KEYS);
      expect(method?.value).toBe('POST');

      // A span for the DB insert `/auth/register` performs must ALSO exist,
      // distinct from the HTTP span above.
      const dbSpan = spans.find(isLikelyDbSpan);
      expect(
        dbSpan,
        'expected at least one DB-query-shaped span (see header comment for the loose heuristic used, and confirm/tighten against the real db/client.ts implementation)',
      ).toBeDefined();

      // ================= CRITICAL PII-SAFETY ASSERTION =================
      // Across EVERY recorded span (not just the DB one) and EVERY
      // attribute on it, the raw email/password submitted above must never
      // appear as a substring of any attribute value or the span name
      // itself. This is what proves the DB span captures only the
      // parameterized SQL query text (e.g.
      // `INSERT INTO users (email, password_hash) VALUES ($1, $2)`) and
      // never the actual bound parameter VALUES.
      for (const span of spans) {
        expect(span.name, `span name "${span.name}" must not contain the raw email`).not.toContain(
          email,
        );
        expect(
          span.name,
          `span name "${span.name}" must not contain the raw password`,
        ).not.toContain(password);

        for (const [attributeKey, attributeValue] of Object.entries(span.attributes)) {
          const stringifiedValue = String(attributeValue);

          expect(
            stringifiedValue,
            `span "${span.name}"'s attribute "${attributeKey}" must not contain the raw email -- ` +
              'DB spans must only ever carry parameterized SQL text, never bound parameter values',
          ).not.toContain(email);

          expect(
            stringifiedValue,
            `span "${span.name}"'s attribute "${attributeKey}" must not contain the raw password -- ` +
              'DB spans must only ever carry parameterized SQL text, never bound parameter values',
          ).not.toContain(password);
        }
      }

      // If a db.statement-shaped attribute exists on the DB span, it should
      // look like parameterized SQL (a placeholder like `$1`), not
      // interpolated literal values -- a stronger, positive check alongside
      // the negative "doesn't contain the raw values" checks above.
      const statement = firstDefinedAttribute(dbSpan as ReadableSpan, DB_STATEMENT_ATTRIBUTE_KEYS);
      if (statement !== undefined) {
        expect(String(statement.value)).toMatch(/\$\d/);
      }
    },
  );
});
