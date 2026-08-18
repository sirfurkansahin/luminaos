import type { ConnectorHealth, McpConnectorRegistry } from '@luminaos/integrations';

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Races `promise` against a timer -- if `promise` neither resolves nor
 * rejects within `timeoutMs`, the returned promise rejects instead of
 * staying pending forever. Own copy of `../health/health.service.ts`'s
 * `withTimeout` helper (not exported from there, ADR-0025 §m).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs.toString()}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * F2-T9 PR2 (ADR-0025 §m): same `withTimeout`/`Promise.allSettled` pattern
 * as `HealthService`, but iterating every connector registered in a
 * `McpConnectorRegistry` instead of two fixed (db/redis) probes. Framework-
 * agnostic (no Nest DI) -- `apps/server/src/health/`'s `HealthService`
 * itself is unchanged/unextended (Karar m).
 */
export class ConnectorHealthService {
  private readonly timeoutMs: number;

  constructor(
    private readonly registry: McpConnectorRegistry,
    options?: { timeoutMs?: number },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async checkAll(): Promise<Record<string, ConnectorHealth>> {
    const connectors = this.registry.list();

    const settled = await Promise.allSettled(
      connectors.map((connector) => withTimeout(connector.checkHealth(), this.timeoutMs)),
    );

    const result: Record<string, ConnectorHealth> = {};

    settled.forEach((outcome, index) => {
      const connector = connectors[index];
      if (!connector) {
        return;
      }

      result[connector.connectorType] =
        outcome.status === 'fulfilled' ? outcome.value : { status: 'error' };
    });

    return result;
  }
}
