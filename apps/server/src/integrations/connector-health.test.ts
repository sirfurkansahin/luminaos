import { describe, expect, it } from 'vitest';

import { McpConnectorRegistry, MockMcpConnector } from '@luminaos/integrations';
import type {
  ConnectorHealth,
  McpConnector,
  McpResourceReadResult,
  McpToolCallResult,
} from '@luminaos/integrations';

import { ConnectorHealthService as ConnectorHealthServiceModuleExport } from './connector-health.service.js';

/**
 * F2-T9 PR2 (RED step), ADR-0025 §m — `ConnectorHealthService`
 * (`./connector-health.service.ts`, does NOT exist yet as of this commit).
 * `McpConnectorRegistry`/`MockMcpConnector`/`ConnectorHealth` are already
 * real, resolvable `@luminaos/integrations` exports (PR1, already merged) --
 * imported directly, normally, no cast workaround needed for them.
 *
 * Unit test (no I/O, no Testcontainers) -- `McpConnectorRegistry` and
 * `MockMcpConnector` are pure in-memory, exactly mirroring
 * `../health/health.service.test.ts`'s own "no separate integration-DB test"
 * convention for the structurally-analogous `HealthService`
 * (`withTimeout`/`Promise.allSettled`, hand-built duck-typed probes instead
 * of real DB/Redis). This file follows THAT file's exact conventions:
 * `SHORT_TIMEOUT_MS` + a real (not fake-timer) short injected timeout, a
 * `neverResolves()` helper, direct `new ConnectorHealthService(registry, options)`
 * construction (no Nest DI), and the same
 * `ModuleExport as unknown as Constructor` + local-interface lint-avoidance
 * pattern (`./connector-health.service.ts` doesn't exist yet, so a bare
 * import's binding would otherwise be `any`, cascading
 * `@typescript-eslint/no-unsafe-*` errors through every call site below, on
 * top of the one genuinely-expected `import-x/no-unresolved` error this file
 * is supposed to fail with).
 *
 * FAKE-SLOW-CONNECTOR TECHNIQUE: a small hand-written class implementing the
 * real `McpConnector` interface (imported directly from
 * `@luminaos/integrations`, since that type already exists) with a
 * controllable `checkHealth()` -- either `neverResolves()` (proves the
 * `timeoutMs` bound, mirrors `health.service.test.ts`'s `neverResolves`
 * exactly) or a rejected promise (defense-in-depth: `McpConnector.checkHealth`'s
 * own contract says "never throws", but `checkAll()`'s `Promise.allSettled`
 * design must survive a buggy implementation that violates it anyway).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./connector-health.service.ts` does not
 * exist. This file's own top-level `import { ConnectorHealthService as
 * ConnectorHealthServiceModuleExport } from './connector-health.service.js'`
 * fails module resolution (`import-x/no-unresolved` / "Cannot find module"),
 * which is the correct red -- the class this PR adds simply does not exist
 * yet, not a test-logic bug.
 * ============================================================================
 */

interface ConnectorHealthServiceInstance {
  checkAll: () => Promise<Record<string, ConnectorHealth>>;
}

interface ConnectorHealthServiceConstructor {
  new (
    registry: McpConnectorRegistry,
    options?: { timeoutMs?: number },
  ): ConnectorHealthServiceInstance;
}

const ConnectorHealthService =
  ConnectorHealthServiceModuleExport as unknown as ConnectorHealthServiceConstructor;

const SHORT_TIMEOUT_MS = 50;

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Deliberately never settles -- simulates a hung connector health probe
    // so the service's own timeout wrapper is what bounds this test's
    // runtime, not an unrelated real-world hang. Mirrors
    // `../health/health.service.test.ts`'s identically-named helper.
  });
}

/**
 * A minimal, hand-written `McpConnector` -- NOT `MockMcpConnector` -- because
 * `MockMcpConnector.checkHealth()` always resolves immediately to its
 * configured `health` option and can't simulate a hang or a contract-violating
 * rejection. `connect`/`disconnect`/`callTool`/`readResource` are unused by
 * `ConnectorHealthService` and only present to satisfy the `McpConnector`
 * interface.
 */
class FakeConnector implements McpConnector {
  readonly connectorType: string;

  private readonly healthImpl: () => Promise<ConnectorHealth>;

  constructor(connectorType: string, healthImpl: () => Promise<ConnectorHealth>) {
    this.connectorType = connectorType;
    this.healthImpl = healthImpl;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  checkHealth(): Promise<ConnectorHealth> {
    return this.healthImpl();
  }

  callTool(): Promise<McpToolCallResult> {
    return Promise.reject(
      new Error('FakeConnector.callTool is not implemented -- unused by ConnectorHealthService'),
    );
  }

  readResource(): Promise<McpResourceReadResult> {
    return Promise.reject(
      new Error(
        'FakeConnector.readResource is not implemented -- unused by ConnectorHealthService',
      ),
    );
  }
}

describe('ConnectorHealthService.checkAll() (ADR-0025 §m)', () => {
  it('1. registry with 2-3 MockMcpConnectors, each with its OWN configured health -- checkAll() returns a record keyed by connectorType, each entry matching its own connector', async () => {
    const registry = new McpConnectorRegistry();
    registry.register(
      new MockMcpConnector({ connectorType: 'google-drive', health: { status: 'ok' } }),
    );
    registry.register(
      new MockMcpConnector({
        connectorType: 'slack',
        health: { status: 'error', detail: 'invalid credentials' },
      }),
    );
    registry.register(new MockMcpConnector({ connectorType: 'github', health: { status: 'ok' } }));

    const service = new ConnectorHealthService(registry);
    const result = await service.checkAll();

    expect(result['google-drive']).toEqual({ status: 'ok' });
    expect(result['slack']).toEqual({ status: 'error', detail: 'invalid credentials' });
    expect(result['github']).toEqual({ status: 'ok' });
    expect(Object.keys(result).sort()).toEqual(['github', 'google-drive', 'slack']);
  });

  it('2. a connector whose checkHealth() never resolves is reported {status: "error"} once the injected timeoutMs elapses, WITHOUT delaying the other connectors\' results', async () => {
    const registry = new McpConnectorRegistry();
    registry.register(new MockMcpConnector({ connectorType: 'fast-ok', health: { status: 'ok' } }));
    registry.register(new FakeConnector('hung-connector', () => neverResolves<ConnectorHealth>()));

    const service = new ConnectorHealthService(registry, { timeoutMs: SHORT_TIMEOUT_MS });

    const start = Date.now();
    const result = await service.checkAll();
    const elapsedMs = Date.now() - start;

    expect(result['fast-ok']).toEqual({ status: 'ok' });
    expect(result['hung-connector']?.status).toBe('error');

    // Bounded by the short injected timeout, not left hanging -- generous
    // upper bound (well below vitest's own 5s default) so this only fails if
    // the timeout wrapper regresses to an unbounded hang.
    expect(elapsedMs).toBeLessThan(2_000);
  }, 5_000);

  it('3. a connector whose checkHealth() REJECTS (violates its own "never throws" contract) does not crash checkAll() -- still produces an {status: "error"} entry for it, and other connectors are unaffected (Promise.allSettled defense-in-depth)', async () => {
    const registry = new McpConnectorRegistry();
    registry.register(
      new MockMcpConnector({ connectorType: 'well-behaved', health: { status: 'ok' } }),
    );
    registry.register(
      new FakeConnector('buggy-connector', () =>
        Promise.reject(new Error('buggy connector violated the never-throws contract')),
      ),
    );

    const service = new ConnectorHealthService(registry, { timeoutMs: SHORT_TIMEOUT_MS });

    // The call itself must resolve (not reject/crash) despite the buggy
    // connector's rejection.
    const result = await service.checkAll();

    expect(result['well-behaved']).toEqual({ status: 'ok' });
    expect(result['buggy-connector']?.status).toBe('error');
  }, 5_000);

  it('4. an empty registry (no connectors registered) -> checkAll() resolves to an empty record, not an error', async () => {
    const registry = new McpConnectorRegistry();
    const service = new ConnectorHealthService(registry);

    const result = await service.checkAll();
    expect(result).toEqual({});
  });
});
