import { describe, expect, it } from 'vitest';

import { createTracerProvider } from './tracing.js';

import type { TracerProviderResult } from './tracing.js';

/**
 * Unit tests (no I/O, no Testcontainers) for F0-T8 PR-B's exporter-selection
 * logic, per the approved plan (`giggly-brewing-moore.md`, Kapsam 3):
 * "Exporter seçimi: `OTEL_EXPORTER_OTLP_ENDPOINT` env değişkeninin
 * varlığı/yokluğu ... varsa OTLP, yoksa konsol exporter."
 *
 * =============================== CONTRACT DESIGNED HERE (not yet
 * implemented — `./tracing.ts` does not exist) ===============================
 *
 * `createTracerProvider` is a PURE factory, mirroring PR-A's
 * `buildPinoHttpOptions(env)` convention in `logging.module.ts`: it takes
 * explicit, already-resolved configuration as a plain argument rather than
 * reading `process.env` itself, so tests never need to mutate/restore global
 * env state to exercise both branches, and the real env-var read happens
 * exactly once, at the call site inside `tracing.module.ts` (not written
 * yet) — mirroring how `env.ts` centralizes all other env reads.
 *
 * Deliberately, `OTEL_EXPORTER_OTLP_ENDPOINT` itself is NOT threaded through
 * `config/env.ts`'s zod-validated `Env` shape: it is OpenTelemetry's own
 * standard, cross-tool env var name (the OTel SDK spec itself defines and
 * reads it by this exact name in every language — Node, Python, Go, Java
 * SDKs all honor it, and third-party collectors/agents key off of it too by
 * convention). Piping it through `env.ts`'s strict fail-fast validation
 * (`process.exit(1)` on bad values, as `DATABASE_URL`/`LOG_LEVEL` do) would
 * fight that convention: an operator should be able to point
 * `OTEL_EXPORTER_OTLP_ENDPOINT` at any collector URL (or omit it entirely for
 * local/console-only tracing) without this app's own schema second-guessing
 * a value only the OTel SDK itself needs to understand. `tracing.module.ts`
 * is expected to read `process.env['OTEL_EXPORTER_OTLP_ENDPOINT']` directly
 * (undecorated, no zod schema) and pass it straight into this factory as
 * `otlpEndpoint` — implementer: please confirm this reasoning still holds
 * once you're actually wiring `tracing.module.ts`, and adjust if a stronger
 * reason to route it through `env.ts` turns up.
 *
 * Signature (implementer: build exactly this shape):
 *
 *   interface TracerProviderOptions {
 *     otlpEndpoint?: string;
 *   }
 *
 *   interface TracerProviderResult {
 *     provider: import('@opentelemetry/sdk-trace-base').BasicTracerProvider;
 *     exporterKind: 'console' | 'otlp';
 *   }
 *
 *   function createTracerProvider(options?: TracerProviderOptions): TracerProviderResult
 *
 * Why `{ provider, exporterKind }` instead of returning the bare provider:
 * `NodeTracerProvider`/`BasicTracerProvider` do not expose any public,
 * documented way to introspect which span processor/exporter a given
 * instance was built with (span processors are held in a private array —
 * there is no `provider.getSpanProcessors()` or equivalent in
 * `@opentelemetry/sdk-trace-base`'s public API as of the versions this repo
 * is expected to install). A test that only had the bare provider back could
 * assert "doesn't throw when starting/ending a span" but could NEVER
 * distinguish "configured for OTLP" from "configured for console" — the
 * actual acceptance-relevant behavior per the plan. Returning a small
 * wrapper object with an explicit `exporterKind` discriminant lets tests
 * assert on the OBSERABLE DECISION the factory made without needing to
 * reach into OTel internals, while `provider` itself still needs to be a
 * real, usable `BasicTracerProvider`/`NodeTracerProvider` (checked here only
 * by duck-typing: `getTracer`/`shutdown` are present and callable, and using
 * them to start+end a span does not throw) since it is what
 * `HttpTracingInterceptor` and `createDatabaseClient`'s optional `Tracer`
 * parameter (both not written yet) actually need to consume.
 *
 * This unit test file deliberately imports NOTHING from any
 * `@opentelemetry/*` package (only from `./tracing.js`) so that, until both
 * `./tracing.ts` AND the `@opentelemetry/*` dependencies exist, every test
 * below fails for the single, unambiguous reason "Cannot find module
 * './tracing.js'" — not a mix of that plus separately-guessable OTel-package
 * import errors.
 *
 * Empty/whitespace-only `otlpEndpoint` treated as absent: mirrors
 * `config/env.ts`'s existing `readLogLevel()` convention (an explicitly-set
 * but blank env var is treated the same as "not set", not as a malformed
 * value) — reasonable to expect the same discipline here, since
 * `OTEL_EXPORTER_OTLP_ENDPOINT=` (present but empty) is a realistic
 * deployment-config accident (e.g. an unset shell variable substituted into
 * an env file). Implementer: adjust/remove this test if a stricter
 * "any defined value, even blank, means OTLP" interpretation is chosen
 * instead — flagging this as a judgment call, not a hard requirement from
 * the plan text.
 */

describe('createTracerProvider (exporter selection)', () => {
  it('selects the console exporter when called with no options at all', () => {
    const result: TracerProviderResult = createTracerProvider();

    expect(result.exporterKind).toBe('console');
  });

  it('selects the console exporter when otlpEndpoint is explicitly undefined', () => {
    const result = createTracerProvider({ otlpEndpoint: undefined });

    expect(result.exporterKind).toBe('console');
  });

  it('selects the console exporter when otlpEndpoint is an empty/whitespace-only string', () => {
    const blankResult = createTracerProvider({ otlpEndpoint: '' });
    const whitespaceResult = createTracerProvider({ otlpEndpoint: '   ' });

    expect(blankResult.exporterKind).toBe('console');
    expect(whitespaceResult.exporterKind).toBe('console');
  });

  it('selects the OTLP exporter when a non-empty otlpEndpoint is provided', () => {
    const result = createTracerProvider({
      otlpEndpoint: 'http://localhost:4318/v1/traces',
    });

    expect(result.exporterKind).toBe('otlp');
  });

  it('returns a usable provider (console) that can start and end a span without throwing', () => {
    const { provider } = createTracerProvider();

    expect(typeof provider.getTracer).toBe('function');

    const tracer = provider.getTracer('tracing-unit-test');
    const span = tracer.startSpan('unit-test-span-console');
    span.setAttribute('test.marker', 'console-exporter');
    span.end();
  });

  it('returns a usable provider (otlp-configured) that can start and end a span without throwing, with no live collector needed', () => {
    // No network collector is running at this address in the test
    // environment — per the plan, span creation/completion itself must never
    // depend on a reachable collector; only actual export (batched/async,
    // happening well after `.end()` returns) would need one, and this test
    // never waits for or asserts on that export succeeding.
    const { provider } = createTracerProvider({
      otlpEndpoint: 'http://localhost:4318/v1/traces',
    });

    const tracer = provider.getTracer('tracing-unit-test');
    const span = tracer.startSpan('unit-test-span-otlp');
    span.setAttribute('test.marker', 'otlp-exporter');
    span.end();
  });

  it('provider.shutdown() resolves without throwing (console exporter)', async () => {
    const { provider } = createTracerProvider();

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('provider.shutdown() resolves without throwing (otlp-configured exporter)', async () => {
    const { provider } = createTracerProvider({
      otlpEndpoint: 'http://localhost:4318/v1/traces',
    });

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('each call returns an independent provider instance, not a shared singleton', () => {
    const first = createTracerProvider();
    const second = createTracerProvider();

    expect(first.provider).not.toBe(second.provider);
  });
});
