import { URL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';

import type {
  ConnectorHealth,
  McpConnector,
  McpResourceReadResult,
  McpToolCallResult,
} from './mcp-connector.js';
import type { ZodType } from 'zod';

export interface StreamableHttpMcpConnectorConfig {
  connectorType: string;
  /** The provider's MCP server endpoint, e.g. 'https://mcp.notion.com'. */
  serverUrl: string;
  /** Called at the START of every `connect()` — returns a currently-valid
   * access token. Refresh-if-expired logic (if any) lives INSIDE this
   * callback, supplied by the caller (the DI factory, Karar l) — the base
   * class never inspects token expiry itself, mirroring how `getAccessToken`
   * is the ONE seam between this class and `ConnectorCredentialsService`. */
  getAccessToken: () => Promise<string>;
}

/**
 * Shared base every one of the 5 concrete connectors extends. Builds a
 * fresh `StreamableHTTPClientTransport` + SDK `Client` on each `connect()`
 * (never uses the SDK's own `OAuthClientProvider` — Bağlam madde 3). Concrete
 * subclasses supply ONLY: `connectorType`/`serverUrl` (via `super(config)`)
 * and the two zod-validation hooks below (Karar h). See ADR-0026 §g.
 */
export abstract class StreamableHttpMcpConnector implements McpConnector {
  readonly connectorType: string;
  private client: Client | undefined; // SDK's own `Client`, never exposed
  private readonly config: StreamableHttpMcpConnectorConfig;

  constructor(config: StreamableHttpMcpConnectorConfig) {
    this.connectorType = config.connectorType;
    this.config = config;
  }

  async connect(): Promise<void> {
    const accessToken = await this.config.getAccessToken();
    const transport = new StreamableHTTPClientTransport(new URL(this.config.serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client({ name: 'luminaos', version: '1.0.0' });
    // @ts-expect-error upstream @modelcontextprotocol/sdk <-> exactOptionalPropertyTypes
    // incompatibility: `StreamableHTTPClientTransport`'s `sessionId` getter is typed
    // `string | undefined`, which the `Transport` interface's `sessionId?: string` field
    // rejects under `exactOptionalPropertyTypes: true` -- a purely-structural upstream
    // typing quirk (the runtime behavior is unaffected), same class of issue as
    // apps/web/src/views/doc/DocEditor.tsx's documented BlockNote override.
    await client.connect(transport); // throws on handshake failure (McpConnector contract)
    this.client = client;
  }

  disconnect(): Promise<void> {
    // Idempotent — SDK's Client has no explicit close(); dropping the
    // reference is sufficient (no `client.close()` observed in the SDK's
    // `Client` surface, Bağlam madde 3 — only the transport has `close()`,
    // which the SDK's own `client.connect()` is responsible for owning).
    this.client = undefined;
    return Promise.resolve();
  }

  /** Never throws (McpConnector contract) — read-only against existing
   * `this.client` state, NEVER calls `connect()`/`getAccessToken` itself. */
  async checkHealth(): Promise<ConnectorHealth> {
    if (!this.client) {
      return { status: 'error', detail: 'not connected' };
    }
    try {
      await this.client.ping();
      return { status: 'ok' };
    } catch {
      return { status: 'error', detail: 'ping failed' };
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.client) {
      throw new InvalidObjectStateError(
        `Cannot call tool "${toolName}" on connector "${this.connectorType}" while not connected`,
      );
    }
    const raw = await this.client.callTool({ name: toolName, arguments: args });
    const content = this.parseOrThrow(this.getToolResultSchema(toolName), raw.content, toolName);
    return { content, isError: Boolean(raw.isError) };
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    if (!this.client) {
      throw new InvalidObjectStateError(
        `Cannot read resource "${uri}" on connector "${this.connectorType}" while not connected`,
      );
    }
    const raw = await this.client.readResource({ uri });
    const [first] = raw.contents;
    const content = this.parseOrThrow(this.getResourceContentSchema(uri), first, uri);
    const mimeType = (first as { mimeType?: string } | undefined)?.mimeType;
    return { uri, content, ...(mimeType === undefined ? {} : { mimeType }) };
  }

  /** `ZodValidationPipe`'ın (`apps/server/src/common/`) AYNI `safeParse` +
   * `ValidationError(message, issues)` deseni — MCP çağrılarının sonuçları
   * için tekrarlanabilir, tek bir kanca (Karar h). */
  protected parseOrThrow<T>(schema: ZodType<T>, raw: unknown, context: string): T {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new ValidationError(
        `Connector "${this.connectorType}" returned an unexpected shape for "${context}"`,
        result.error.issues,
      );
    }
    return result.data;
  }

  /** Concrete connectors implement this as a lookup into their OWN static
   * map of `toolName -> ZodType`; throws `NotFoundError` for a `toolName`
   * this connector class does not declare a schema for — this is a WIRING
   * bug (a tool the connector never registered a schema for), not a
   * degraded/expected state, mirroring `MockMcpConnector`'s own
   * unknown-tool `NotFoundError`. */
  protected abstract getToolResultSchema(toolName: string): ZodType;

  /** Same contract as above, for `readResource`. */
  protected abstract getResourceContentSchema(uri: string): ZodType;
}
