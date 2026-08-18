import { ConflictError } from '@luminaos/shared';

import type { McpConnector } from './mcp-connector.js';

/**
 * `Map`-based catalog of `McpConnector` instances, keyed by
 * `connectorType`. See ADR-0025 §g.
 */
export class McpConnectorRegistry {
  private readonly connectors = new Map<string, McpConnector>();

  /** Throws `ConflictError` if `connector.connectorType` is already
   * registered — a registry is a catalog, not an upsert; re-registering
   * the same type is almost always a wiring bug (e.g. two DI factories
   * both registering 'google-drive'), not an intended override. */
  register(connector: McpConnector): void {
    if (this.connectors.has(connector.connectorType)) {
      throw new ConflictError(
        `A connector is already registered for connectorType "${connector.connectorType}"`,
      );
    }

    this.connectors.set(connector.connectorType, connector);
  }

  /** Returns `undefined` if not found — NOT throwing, because "is this
   * connector type known" is a legitimate question callers (e.g.
   * F2-T11's Connected Search) need to ask without a try/catch, mirrors
   * `Map.get`'s own convention directly. */
  get(connectorType: string): McpConnector | undefined {
    return this.connectors.get(connectorType);
  }

  list(): McpConnector[] {
    return Array.from(this.connectors.values());
  }
}
