import { describe, expect, it } from 'vitest';

import { ConflictError } from '@luminaos/shared';

import { McpConnectorRegistry } from './mcp-connector-registry.js';

import type {
  ConnectorHealth,
  McpConnector,
  McpResourceReadResult,
  McpToolCallResult,
} from './mcp-connector.js';

/**
 * Designed contract (must be matched exactly by implementer — F2-T9 PR1,
 * red step; see ADR-0025 §f + §g):
 *
 *   export interface McpConnector {
 *     readonly connectorType: string;
 *     connect(): Promise<void>;
 *     disconnect(): Promise<void>;
 *     checkHealth(): Promise<ConnectorHealth>; // never throws
 *     callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
 *     readResource(uri: string): Promise<McpResourceReadResult>;
 *   }
 *
 *   export class McpConnectorRegistry {
 *     register(connector: McpConnector): void; // throws ConflictError if connector.connectorType already registered
 *     get(connectorType: string): McpConnector | undefined; // returns undefined if not found, does NOT throw
 *     list(): McpConnector[];
 *   }
 *
 * `register` is a catalog operation, not an upsert — re-registering an
 * already-known `connectorType` is treated as a wiring bug and throws
 * `ConflictError` (mirrors `CalendarAccountsService.connect`'s failed-insert
 * convention, `packages/shared/errors`).
 */

/** Minimal inline stub satisfying `McpConnector` — avoids a circular
 * test-fixture dependency on `MockMcpConnector` (file 3 of this PR). */
function buildStubConnector(connectorType: string): McpConnector {
  return {
    connectorType,
    connect(): Promise<void> {
      return Promise.resolve();
    },
    disconnect(): Promise<void> {
      return Promise.resolve();
    },
    checkHealth(): Promise<ConnectorHealth> {
      return Promise.resolve({ status: 'ok' });
    },
    callTool(): Promise<McpToolCallResult> {
      return Promise.resolve({ content: null, isError: false });
    },
    readResource(uri: string): Promise<McpResourceReadResult> {
      return Promise.resolve({ uri, content: null });
    },
  };
}

describe('McpConnectorRegistry — register + get', () => {
  it('makes a registered connector retrievable via get by its connectorType', () => {
    const registry = new McpConnectorRegistry();
    const connector = buildStubConnector('google-drive');

    registry.register(connector);

    expect(registry.get('google-drive')).toBe(connector);
  });

  it('returns undefined (does not throw) for an unregistered connectorType', () => {
    const registry = new McpConnectorRegistry();

    expect(registry.get('never-registered')).toBeUndefined();
  });

  it('registers two different connectors with different connectorTypes and both are retrievable', () => {
    const registry = new McpConnectorRegistry();
    const driveConnector = buildStubConnector('google-drive');
    const slackConnector = buildStubConnector('slack');

    registry.register(driveConnector);
    registry.register(slackConnector);

    expect(registry.get('google-drive')).toBe(driveConnector);
    expect(registry.get('slack')).toBe(slackConnector);
  });

  it('throws ConflictError when registering a second connector with an already-registered connectorType', () => {
    const registry = new McpConnectorRegistry();
    registry.register(buildStubConnector('github'));

    expect(() => registry.register(buildStubConnector('github'))).toThrow(ConflictError);
  });

  it('leaves the original connector in place after a rejected duplicate registration', () => {
    const registry = new McpConnectorRegistry();
    const original = buildStubConnector('notion');
    registry.register(original);

    expect(() => registry.register(buildStubConnector('notion'))).toThrow(ConflictError);

    expect(registry.get('notion')).toBe(original);
  });
});

describe('McpConnectorRegistry — list', () => {
  it('returns an empty array when no connectors are registered', () => {
    const registry = new McpConnectorRegistry();

    expect(registry.list()).toEqual([]);
  });

  it('returns all registered connectors, matching count and contents, after several registrations', () => {
    const registry = new McpConnectorRegistry();
    const driveConnector = buildStubConnector('google-drive');
    const slackConnector = buildStubConnector('slack');
    const githubConnector = buildStubConnector('github');

    registry.register(driveConnector);
    registry.register(slackConnector);
    registry.register(githubConnector);

    const listed = registry.list();

    expect(listed).toHaveLength(3);
    expect(listed).toEqual(
      expect.arrayContaining([driveConnector, slackConnector, githubConnector]),
    );
  });
});
