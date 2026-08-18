import { InvalidObjectStateError, NotFoundError } from '@luminaos/shared';

import type {
  ConnectorHealth,
  McpConnector,
  McpResourceReadResult,
  McpToolCallResult,
} from './mcp-connector.js';

export interface MockMcpConnectorOptions {
  connectorType: string;
  tools?: Record<string, McpToolCallResult> | undefined;
  resources?: Record<string, McpResourceReadResult> | undefined;
  health?: ConnectorHealth | undefined;
}

/**
 * A thin, deterministic, in-memory test double for `McpConnector` — no
 * real network/transport, no `@modelcontextprotocol/sdk` import. See
 * ADR-0025 §j.
 */
export class MockMcpConnector implements McpConnector {
  readonly connectorType: string;

  private readonly tools: Record<string, McpToolCallResult>;
  private readonly resources: Record<string, McpResourceReadResult>;
  private readonly health: ConnectorHealth;
  private connected = false;

  constructor(options: MockMcpConnectorOptions) {
    this.connectorType = options.connectorType;
    this.tools = options.tools ?? {};
    this.resources = options.resources ?? {};
    this.health = options.health ?? { status: 'ok' };
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  checkHealth(): Promise<ConnectorHealth> {
    return Promise.resolve(this.health);
  }

  callTool(toolName: string): Promise<McpToolCallResult> {
    return Promise.resolve().then(() => {
      if (!this.connected) {
        throw new InvalidObjectStateError(
          `Cannot call tool "${toolName}" on connector "${this.connectorType}" while not connected`,
        );
      }

      const result = this.tools[toolName];
      if (!result) {
        throw new NotFoundError(`Unknown tool "${toolName}" for connector "${this.connectorType}"`);
      }

      return result;
    });
  }

  readResource(uri: string): Promise<McpResourceReadResult> {
    return Promise.resolve().then(() => {
      if (!this.connected) {
        throw new InvalidObjectStateError(
          `Cannot read resource "${uri}" on connector "${this.connectorType}" while not connected`,
        );
      }

      const result = this.resources[uri];
      if (!result) {
        throw new NotFoundError(`Unknown resource "${uri}" for connector "${this.connectorType}"`);
      }

      return result;
    });
  }
}
