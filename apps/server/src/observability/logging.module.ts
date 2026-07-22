import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { maskSensitiveFields } from './redact.js';
import { env } from '../config/env.js';

import type { Env } from '../config/env.js';
import type { Options as PinoHttpOptions } from 'pino-http';

/**
 * Pure factory for `nestjs-pino`'s `pinoHttp` options — the exact same
 * function the real app (via `LoggingModule` below) AND integration tests
 * call, so test log configuration can never drift from production
 * configuration (mirrors `db/client.ts`'s `createDatabaseClient` pattern:
 * one function, different callers supply a different `stream`).
 *
 * Key decisions, verified against the installed `pino@10.3.1` /
 * `pino-http@11.0.0` / `nestjs-pino@4.6.1` (not assumed from docs):
 *
 * - `quietReqLogger: true` + `quietResLogger: true`: pino-http's own default
 *   (`quietReqLogger: false`) attaches the *raw* `req` object as a bound
 *   child-logger field (serialized to `{id, method, url, headers, ...}` at
 *   bind time) and never puts a top-level `reqId` key on the line at all —
 *   the request id only ever appears nested at `req.id`. With
 *   `quietReqLogger: true`, pino-http instead binds a lean
 *   `{ reqId: req.id }` (its own default `customAttributeKeys.reqId` key —
 *   confirmed in `pino-http`'s `logger.js`: `opts.customAttributeKeys.reqId
 *   || 'reqId'`) onto every logger derived from the request, which is what
 *   propagates through `nestjs-pino`'s `AsyncLocalStorage`-backed
 *   `PinoLogger`/`Logger` to *any* call — including `new
 *   Logger(SomeClass.name)` from `@nestjs/common` after
 *   `app.useLogger(app.get(Logger))` overrides Nest's static logger — made
 *   during that request's lifecycle, not just pino-http's own access-log
 *   line. This is what gives every log line from one request the same
 *   top-level `reqId` field (AC1).
 * - `genReqId: () => randomUUID()`: pino-http's own default `genReqId`
 *   (confirmed in `logger.js`'s `reqIdGenFactory`) returns a process-local
 *   incrementing *number* (`1, 2, 3, ...`), not a string — fine for local
 *   uniqueness, but not what a caller correlating requestIds across a
 *   distributed system (or even just typing a value as `string` in a test)
 *   would expect. A `crypto.randomUUID()` per request is unique across
 *   processes/restarts and unambiguously a string.
 * - `formatters.log`: pino calls this on the plain object argument passed to
 *   a log call *before* applying any per-key serializer (verified against
 *   pino's `lib/tools.js` `_asJson`) — this is the primary redaction layer
 *   (AC2), and it is what actually intercepts a deliberately-logged
 *   `{email, password, ...}` object.
 * - `redact.paths` for `req.headers.authorization`/`req.headers.cookie`:
 *   defense-in-depth for the (currently dormant, since request/response
 *   loggers stay lean per `quietReqLogger`/`quietResLogger` above) case
 *   where a raw `req` ever does get bound/logged elsewhere — the shape
 *   `req.headers.*` is pino-http's actual default request-serialization
 *   shape, confirmed against `pino-std-serializers`' `req` serializer
 *   (`{id, method, url, query, params, headers, remoteAddress,
 *   remotePort}` — no `body` field exists at all, confirming pino-http never
 *   logs a request body by default).
 * - `redact.paths` for `res.headers["set-cookie"]`: unlike the request side,
 *   this one is NOT dormant/defense-in-depth — it is load-bearing, and its
 *   absence was a real bug (see `cookie-redaction.integration.test.ts`).
 *   `formatters.log` (above) runs on pino's log-call argument BEFORE pino's
 *   own `res` serializer turns the raw `res` into a plain
 *   `{statusCode, headers}` object (verified against pino 10.3.1's
 *   `_asJson`) — at `formatters.log` time, `res` is still a raw
 *   `http.ServerResponse` instance, which `redact.ts`'s `isPlainObject()`
 *   deliberately treats as an opaque leaf (see that file's doc comment), so
 *   `maskSensitiveFields` structurally cannot reach `res.headers` and never
 *   redacts the response's `Set-Cookie` value. `redact.paths`, by contrast,
 *   is a *separate* mechanism (pino wires this via the installed
 *   `@pinojs/redact` — an API-compatible, non-mutating drop-in for
 *   `fast-redact` used by pino 10.x internally) applied AFTER all
 *   serializers run, right before JSON stringification, so it CAN see
 *   `res.headers` once it has already become a plain object. The key needs
 *   quoted-bracket notation (`["set-cookie"]`, not `.set-cookie`) because
 *   `-` is not a valid character in an unquoted dot-path segment — confirmed
 *   against `@pinojs/redact`'s own README, whose bracket-notation example is
 *   literally a hyphenated header name (`headers["X-Forwarded-For"]`). The
 *   key is lowercase because `pino-std-serializers`' `res` serializer builds
 *   `headers` from `res.getHeaders()`, and Node's `http.ServerResponse
 *   .getHeaders()` always normalizes header names to lowercase regardless of
 *   how they were originally set (confirmed against the installed
 *   `pino-std-serializers@7.1.0`'s `lib/res.js`) — so `set-cookie`, not
 *   `Set-Cookie`, is what actually appears in the object redact.paths
 *   inspects. Reuses the existing global `censor: '[REDACTED]'` (whole-value
 *   redaction) rather than a smarter cookie-name-preserving censor, for
 *   consistency with the `req.headers.cookie` entry already above.
 *
 * Two known, deliberately-deferred limitations (found in security review,
 * not fixed here — a partial fix would be misleading rather than helpful):
 *
 * 1. Free-text PII embedded inside an Error's `.message`/`.stack` survives
 *    redaction. Both `formatters.log` (key-based) and `redact.paths`
 *    (fixed-path) operate on OBJECT KEYS, never scanning a string VALUE's
 *    content for an embedded email/token. A Postgres constraint-violation
 *    message or a raw stack trace would pass through untouched if ever
 *    logged directly. `AppErrorFilter` already defends against exactly this
 *    (never forwards a non-AppError's raw message/stack) — but that
 *    discipline lives per call site, not here, and at least one existing
 *    call site (`event-store/event-bus.ts`'s `logRejection`, predating this
 *    task) does forward a raw `error.stack`. Wrapping `serializers.err` with
 *    `maskSensitiveFields` was considered and rejected: it would only catch
 *    extra enumerable named properties on an Error object, not PII embedded
 *    as free text in `.message`/`.stack` — the actually-reachable risk in
 *    `event-bus.ts` — so it would look like a fix without being one. Real
 *    fix belongs at each call site (follow-up: audit every
 *    `Logger.error(msg, error.stack)`-style call for the same PII discipline
 *    `AppErrorFilter` already has).
 * 2. `res.headers["set-cookie"]` is a hardcoded exact-path allowlist, not a
 *    pattern — a future response header carrying a credential-equivalent
 *    (e.g. a custom session-token header) would need its own explicit
 *    `redact.paths` entry; nothing here generalizes "any sensitive-looking
 *    response header" the way `SENSITIVE_KEY_PATTERN` does for logged
 *    objects. Currently latent, not live: `auth.controller.ts`'s
 *    `res.cookie(...)` is the only place the server sets a response header
 *    carrying a session value today.
 */
export function buildPinoHttpOptions(env: Env): PinoHttpOptions {
  return {
    level: env.logLevel,
    genReqId: () => randomUUID(),
    quietReqLogger: true,
    quietResLogger: true,
    formatters: {
      log(logObject: Record<string, unknown>): Record<string, unknown> {
        return maskSensitiveFields(logObject) as Record<string, unknown>;
      },
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
  };
}

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: buildPinoHttpOptions(env),
    }),
  ],
})
export class LoggingModule {}
