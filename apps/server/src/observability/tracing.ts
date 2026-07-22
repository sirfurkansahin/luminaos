import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * Pure factory for the OpenTelemetry `NodeTracerProvider`, mirroring
 * `logging.module.ts`'s `buildPinoHttpOptions(env)` convention: explicit,
 * already-resolved configuration in, a fully-built object out — no reading of
 * `process.env` here. The real env-var read
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`) happens exactly once, in
 * `tracing.module.ts`, per the approved plan (`giggly-brewing-moore.md`,
 * Kapsam 3): this is OpenTelemetry's own standard, cross-tool env var name,
 * deliberately NOT routed through `config/env.ts`'s strict zod schema (an
 * operator should be free to point it at any collector, or omit it, without
 * this app's own schema second-guessing a value only the OTel SDK needs to
 * understand).
 *
 * Exporter selection: an empty/whitespace-only `otlpEndpoint` is treated the
 * same as "not set" (mirrors `config/env.ts`'s `readLogLevel()` discipline —
 * an explicitly-set-but-blank env var is a realistic deployment accident, not
 * a deliberate "use OTLP with no URL" request).
 *
 * `NodeTracerProvider`/`BasicTracerProvider` do not expose any public way to
 * introspect which exporter/processor an instance was built with (span
 * processors are held in a private array), so this returns a small
 * `{ provider, exporterKind }` wrapper: `exporterKind` is the one thing
 * callers (and tests) actually need to observe about the decision this
 * factory made, without reaching into OTel internals.
 *
 * Span processor choice: `SimpleSpanProcessor` for the console exporter
 * (synchronous, one-span-at-a-time export — fine for local dev, where there
 * is no batching benefit and immediate console output is more useful than a
 * delayed batch), `BatchSpanProcessor` for the OTLP exporter (the standard
 * production choice — batches spans and exports them on an interval/queue
 * threshold instead of making one HTTP call per span).
 */

const SERVICE_NAME = 'luminaos-server';

export interface TracerProviderOptions {
  otlpEndpoint?: string | undefined;
}

export interface TracerProviderResult {
  provider: NodeTracerProvider;
  exporterKind: 'console' | 'otlp';
}

export function createTracerProvider(options?: TracerProviderOptions): TracerProviderResult {
  const trimmedEndpoint = options?.otlpEndpoint?.trim();
  const hasOtlpEndpoint = trimmedEndpoint !== undefined && trimmedEndpoint.length > 0;

  const spanProcessor: SpanProcessor = hasOtlpEndpoint
    ? new BatchSpanProcessor(new OTLPTraceExporter({ url: trimmedEndpoint }))
    : new SimpleSpanProcessor(new ConsoleSpanExporter());

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
    spanProcessors: [spanProcessor],
  });

  return { provider, exporterKind: hasOtlpEndpoint ? 'otlp' : 'console' };
}
