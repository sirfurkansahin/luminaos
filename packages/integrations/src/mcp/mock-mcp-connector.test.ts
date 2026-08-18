import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, NotFoundError } from '@luminaos/shared';

import { MockMcpConnector } from './mock-mcp-connector.js';

import type {
  ConnectorHealth,
  McpConnector,
  McpResourceReadResult,
  McpToolCallResult,
} from './mcp-connector.js';

/**
 * Designed contract (must be matched exactly by implementer — F2-T9 PR1,
 * red step; see ADR-0025 §f + §j):
 *
 *   export type ConnectorHealthStatus = 'ok' | 'error';
 *
 *   export interface ConnectorHealth {
 *     status: ConnectorHealthStatus;
 *     detail?: string; // only present when status is 'error'
 *   }
 *
 *   export interface McpToolCallResult {
 *     content: unknown;
 *     isError: boolean;
 *   }
 *
 *   export interface McpResourceReadResult {
 *     uri: string;
 *     mimeType?: string;
 *     content: unknown;
 *   }
 *
 *   export interface McpConnector {
 *     readonly connectorType: string;
 *     connect(): Promise<void>; // idempotent
 *     disconnect(): Promise<void>; // idempotent, no-op if already disconnected
 *     checkHealth(): Promise<ConnectorHealth>; // NEVER throws
 *     callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
 *       // throws if not connected, if toolName is unknown, or if the call fails
 *     readResource(uri: string): Promise<McpResourceReadResult>;
 *       // throws if not connected or if uri is unknown/unreadable
 *   }
 *
 *   export interface MockMcpConnectorOptions {
 *     connectorType: string;
 *     tools?: Record<string, McpToolCallResult>;
 *     resources?: Record<string, McpResourceReadResult>;
 *     health?: ConnectorHealth;
 *   }
 *
 *   export class MockMcpConnector implements McpConnector {
 *     constructor(options: MockMcpConnectorOptions);
 *   }
 *
 * `MockMcpConnector` is a deterministic, in-memory test double — no real
 * network/transport, no `@modelcontextprotocol/sdk` import. `connect`/
 * `disconnect` toggle an internal `connected` flag and are idempotent.
 * `callTool`/`readResource` throw `InvalidObjectStateError` when called
 * while not connected (mirrors `CalendarTokenEncryptionService`'s existing
 * lazy-fatal `InvalidObjectStateError` use for "operation invalid in the
 * connector's current state"), and throw `NotFoundError` for an unknown
 * `toolName`/`uri` (this repo's standard "unknown identifier" error,
 * `packages/shared/errors`). `checkHealth` returns the configured `health`
 * option (default `{status: 'ok'}`) and never throws, even when the
 * connector is not connected or other methods would throw.
 */

function buildConnector(
  overrides: Partial<{
    connectorType: string;
    tools: Record<string, McpToolCallResult>;
    resources: Record<string, McpResourceReadResult>;
    health: ConnectorHealth;
  }> = {},
): McpConnector {
  return new MockMcpConnector({
    connectorType: overrides.connectorType ?? 'google-drive',
    tools: overrides.tools,
    resources: overrides.resources,
    health: overrides.health,
  });
}

describe('MockMcpConnector — connectorType', () => {
  it('returns exactly the connectorType passed in the options', () => {
    const connector = buildConnector({ connectorType: 'slack' });

    expect(connector.connectorType).toBe('slack');
  });
});

describe('MockMcpConnector — connect/disconnect idempotency', () => {
  it('resolves without throwing when connect() is called', async () => {
    const connector = buildConnector();

    await expect(connector.connect()).resolves.toBeUndefined();
  });

  it('does not throw when connect() is called twice in a row', async () => {
    const connector = buildConnector();

    await connector.connect();

    await expect(connector.connect()).resolves.toBeUndefined();
  });

  it('does not throw when disconnect() is called without a prior connect()', async () => {
    const connector = buildConnector();

    await expect(connector.disconnect()).resolves.toBeUndefined();
  });

  it('does not throw when disconnect() is called twice in a row', async () => {
    const connector = buildConnector();
    await connector.connect();

    await connector.disconnect();

    await expect(connector.disconnect()).resolves.toBeUndefined();
  });
});

describe('MockMcpConnector — callTool while not connected', () => {
  it('throws InvalidObjectStateError', async () => {
    const connector = buildConnector({
      tools: { 'list-files': { content: ['a.txt'], isError: false } },
    });

    await expect(connector.callTool('list-files', {})).rejects.toThrow(InvalidObjectStateError);
  });
});

describe('MockMcpConnector — callTool while connected', () => {
  it('returns the pre-configured McpToolCallResult for a known toolName', async () => {
    const configuredResult: McpToolCallResult = {
      content: { files: ['a.txt', 'b.txt'] },
      isError: false,
    };
    const connector = buildConnector({
      tools: { 'list-files': configuredResult },
    });
    await connector.connect();

    const result = await connector.callTool('list-files', { path: '/' });

    expect(result).toEqual(configuredResult);
  });

  it('throws NotFoundError for an unknown toolName', async () => {
    const connector = buildConnector({
      tools: { 'list-files': { content: [], isError: false } },
    });
    await connector.connect();

    await expect(connector.callTool('unknown-tool', {})).rejects.toThrow(NotFoundError);
  });
});

describe('MockMcpConnector — readResource while not connected', () => {
  it('throws InvalidObjectStateError', async () => {
    const connector = buildConnector({
      resources: { 'file:///a.txt': { uri: 'file:///a.txt', content: 'hello' } },
    });

    await expect(connector.readResource('file:///a.txt')).rejects.toThrow(InvalidObjectStateError);
  });
});

describe('MockMcpConnector — readResource while connected', () => {
  it('returns the pre-configured McpResourceReadResult for a known uri', async () => {
    const configuredResult: McpResourceReadResult = {
      uri: 'file:///a.txt',
      mimeType: 'text/plain',
      content: 'hello world',
    };
    const connector = buildConnector({
      resources: { 'file:///a.txt': configuredResult },
    });
    await connector.connect();

    const result = await connector.readResource('file:///a.txt');

    expect(result).toEqual(configuredResult);
  });

  it('throws NotFoundError for an unknown uri', async () => {
    const connector = buildConnector({
      resources: { 'file:///a.txt': { uri: 'file:///a.txt', content: 'hello' } },
    });
    await connector.connect();

    await expect(connector.readResource('file:///unknown.txt')).rejects.toThrow(NotFoundError);
  });
});

describe('MockMcpConnector — checkHealth', () => {
  it('defaults to {status: "ok"} when no health option is configured', async () => {
    const connector = buildConnector();

    const health = await connector.checkHealth();

    expect(health).toEqual({ status: 'ok' });
  });

  it('returns the configured health option when provided', async () => {
    const connector = buildConnector({
      health: { status: 'error', detail: 'simulated outage' },
    });

    const health = await connector.checkHealth();

    expect(health).toEqual({ status: 'error', detail: 'simulated outage' });
  });

  it('never throws, even when the connector is not connected', async () => {
    const connector = buildConnector({
      health: { status: 'error', detail: 'simulated outage' },
    });

    await expect(connector.checkHealth()).resolves.toEqual({
      status: 'error',
      detail: 'simulated outage',
    });
  });

  it('never throws, even when callTool/readResource would throw for an unknown identifier', async () => {
    const connector = buildConnector();
    await connector.connect();

    await expect(connector.checkHealth()).resolves.toEqual({ status: 'ok' });
  });
});
