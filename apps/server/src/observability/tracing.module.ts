import { Injectable, Module } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

import { createTracerProvider } from './tracing.js';

import type { OnModuleDestroy } from '@nestjs/common';
import type { Tracer } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * DI token for the `Tracer` this module provides. A `Symbol`, not a class,
 * since `Tracer` is an interface from `@opentelemetry/api` with no concrete
 * class to use as a token — same reasoning as `DATABASE_CONNECTION` in
 * `db/database-connection.token.ts`.
 */
export const TRACER = Symbol('TRACER');

/**
 * Reads `OTEL_EXPORTER_OTLP_ENDPOINT` directly (raw, unvalidated) rather than
 * through `config/env.ts`'s zod schema — see `tracing.ts`'s doc comment and
 * the approved plan (`giggly-brewing-moore.md`, Kapsam 3) for why: this is
 * OpenTelemetry's own standard, cross-tool env var name, and piping it
 * through this app's fail-fast schema would fight that convention.
 */
function readOtlpEndpoint(): string | undefined {
  return process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
}

/**
 * Owns the real `NodeTracerProvider` instance's lifecycle: builds it via the
 * pure `createTracerProvider` factory, registers it as the OpenTelemetry
 * GLOBAL tracer provider (`@opentelemetry/api`'s well-known
 * `trace.setGlobalTracerProvider`, invoked here via `provider.register()`),
 * and shuts it down when this module is destroyed.
 *
 * DESIGN DECISION (global registration, not DI-only `Tracer` construction):
 * `HttpTracingInterceptor` and `db/client.ts`'s optional `Tracer` parameter
 * both need a `Tracer` instance. Rather than handing them `provider.getTracer(...)`
 * directly (a `Tracer` tied only to whichever `NodeTracerProvider` this
 * specific process happened to construct), the `TRACER` DI token below
 * resolves to `trace.getTracer(...)` from `@opentelemetry/api`'s GLOBAL
 * registry. This means:
 *   - In production, this module's own `provider.register()` call is the
 *     only registration that ever happens, so `trace.getTracer(...)` and
 *     `provider.getTracer(...)` are equivalent in practice.
 *   - In `tracing.integration.test.ts`, a test-owned `NodeTracerProvider`
 *     (wired to an `InMemorySpanExporter`) registers itself globally BEFORE
 *     `AppModule` is ever imported/booted. `@opentelemetry/api`'s own
 *     `registerGlobal` (confirmed by reading the installed
 *     `@opentelemetry/api@1.9.1` source: `internal/global-utils.js`) is a
 *     first-write-wins registry — a second `.register()` call for the same
 *     API type is a no-op (logged via `diag.error`, not thrown, and does NOT
 *     replace the existing delegate). So this module's own `provider.register()`
 *     call below harmlessly loses, and every `trace.getTracer(...)` call
 *     anywhere in the app (including this module's own) transparently starts
 *     resolving spans through the TEST's provider/exporter instead — with no
 *     `.overrideModule()`/`.overrideProvider()` needed on the Nest testing
 *     module at all. This is what makes the DI token a thin, always-correct
 *     proxy onto "whichever provider actually won global registration",
 *     rather than a value that could silently diverge from it.
 *   - This module still owns and shuts down (`onModuleDestroy`) the
 *     provider IT constructed, regardless of whether that provider ended up
 *     being the one actually used for spans — shutting down a
 *     never-used provider's (no-op) span processor is harmless.
 */
@Injectable()
class TracerProviderLifecycle implements OnModuleDestroy {
  private readonly provider: NodeTracerProvider;

  constructor() {
    const { provider } = createTracerProvider({ otlpEndpoint: readOtlpEndpoint() });
    provider.register();
    this.provider = provider;
  }

  async onModuleDestroy(): Promise<void> {
    await this.provider.shutdown();
  }
}

@Module({
  providers: [
    TracerProviderLifecycle,
    {
      provide: TRACER,
      useFactory: (): Tracer => trace.getTracer('luminaos-server'),
      // Depends on `TracerProviderLifecycle` purely for ordering: its
      // constructor must run (registering the real/global provider) before
      // anything resolves a `Tracer` from the global API, even though the
      // factory itself never reads the instance.
      inject: [TracerProviderLifecycle],
    },
  ],
  exports: [TRACER],
})
export class TracingModule {}
