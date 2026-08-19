import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { Server as LowLevelMcpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidObjectStateError, NotFoundError, ValidationError } from '@luminaos/shared';

import { SlackMcpConnector } from './slack-mcp-connector.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { AddressInfo } from 'node:net';

/**
 * F2-T10 PR2 (RED step), ADR-0026 §d/§h — `SlackMcpConnector`
 * (`./slack-mcp-connector.ts`, does NOT exist yet), mechanically repeating
 * PR1's proven `NotionMcpConnector` pattern (`./notion-mcp-connector.test.ts`)
 * for the Slack concrete `StreamableHttpMcpConnector` subclass — ADR-0026 §d:
 * "PR2(+PR3): kalan 4 bağlayıcı, PR1'in deseninin mekanik tekrarı."
 *
 * Real production `serverUrl` for `SlackMcpConnector` (wired in
 * `apps/server/src/integrations/mcp-connectors.module.ts`, NOT asserted by
 * this file, which talks to a local fake server instead — same as Notion's
 * own test file): `https://mcp.slack.com/mcp` (GA, workspace-admin approval
 * required per ADR-0026 §e — no license/rollout constraint).
 *
 * ============================================================================
 * SCHEMA-MAP CONTENT PINNED BY THIS FILE (ADR-0026 §h explicitly delegates
 * the exact tool/resource list + schema shapes to test-writer/implementer;
 * exact tool/resource names are NOT load-bearing outside this file — only
 * internal consistency between this fake server and the connector's declared
 * schemas matters, same spirit as Notion's `notion-search`). `implementer`'s
 * real `slack-mcp-connector.ts` MUST declare, at minimum:
 *
 *   TOOL_RESULT_SCHEMAS['slack-search-messages'] — validates the RAW
 *     `raw.content` array `StreamableHttpMcpConnector.callTool`'s pinned body
 *     (ADR-0026 §g) passes into `parseOrThrow` — i.e. an array of
 *     `{type:'text', text: string}` content blocks.
 *   RESOURCE_CONTENT_SCHEMAS['slack://channel/fixture-channel-id'] —
 *     validates the single resource-content item `readResource`'s pinned
 *     body destructures as `first` — i.e. `{uri: string, text: string,
 *     mimeType?: string}`.
 *   Both maps must throw `NotFoundError` for any key they do not declare.
 *
 * ============================================================================
 * HARNESS: same real, in-process Streamable HTTP MCP server (SDK server
 * pieces, ADR-0026 §g/Bağlam 3) as `../streamable-http-mcp-connector.test.ts`
 * and `./notion-mcp-connector.test.ts` — not a live `mcp.slack.com`.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./slack-mcp-connector.ts` does not exist yet —
 * the static import above rejects with a "Cannot find module" resolution
 * error, failing every test in this file at collection time. This is a
 * legitimate "implementation incomplete" red, not a test-logic bug.
 * ============================================================================
 */

const SEARCH_TOOL_NAME = 'slack-search-messages';
const BROKEN_TOOL_NAME = 'slack-broken';
const UNDECLARED_TOOL_NAME = 'slack-undeclared-tool';
const CHANNEL_RESOURCE_URI = 'slack://channel/fixture-channel-id';
const UNDECLARED_RESOURCE_URI = 'slack://undeclared';

interface FakeSlackMcpServer {
  serverUrl: string;
  capturedAuthHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** Same real Streamable HTTP MCP server construction as
 * `../streamable-http-mcp-connector.test.ts`'s `startFakeMcpServer` --
 * duplicated locally (small, self-contained, per this repo's established
 * per-file-integration-test convention) with Slack-flavored tool/resource
 * names instead of generic ones. */
async function startFakeSlackMcpServer(): Promise<FakeSlackMcpServer> {
  const capturedAuthHeaders: (string | undefined)[] = [];

  const mcpServer = new LowLevelMcpServer(
    { name: 'fake-slack-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === SEARCH_TOOL_NAME) {
      return {
        content: [{ type: 'text', text: 'Slack search result' }],
        isError: false,
      } satisfies CallToolResult;
    }

    if (name === BROKEN_TOOL_NAME) {
      // Deliberately returns a shape that does NOT match whatever schema
      // `SlackMcpConnector` declares for this tool name -- see this file's
      // "5." test below.
      return {
        content: [{ type: 'text', text: 'unexpectedly still just text' }],
        isError: false,
      } satisfies CallToolResult;
    }

    if (name === UNDECLARED_TOOL_NAME) {
      return {
        content: [{ type: 'text', text: 'server knows this tool; connector class does not' }],
        isError: false,
      } satisfies CallToolResult;
    }

    throw new Error(`fake Slack MCP server: unknown tool "${name}"`);
  });

  mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === CHANNEL_RESOURCE_URI) {
      return {
        contents: [
          { uri, mimeType: 'application/json', text: '{"channelId":"fixture-channel-id"}' },
        ],
      } satisfies ReadResourceResult;
    }

    if (uri === UNDECLARED_RESOURCE_URI) {
      return {
        contents: [{ uri, mimeType: 'text/plain', text: 'server knows this resource too' }],
      } satisfies ReadResourceResult;
    }

    throw new Error(`fake Slack MCP server: unknown resource "${uri}"`);
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // See `notion-mcp-connector.test.ts`'s identical comment for why this cast
  // is a narrow, targeted structural-assignability workaround, not a real
  // interface mismatch.
  await mcpServer.connect(transport as unknown as Transport);

  const httpServer = http.createServer((req, res) => {
    capturedAuthHeaders.push(req.headers.authorization);
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });

  const address = httpServer.address() as AddressInfo;

  return {
    serverUrl: `http://127.0.0.1:${String(address.port)}/mcp`,
    capturedAuthHeaders,
    close: async () => {
      await transport.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
    },
  };
}

describe('SlackMcpConnector (ADR-0026 §d/§h, real fake-HTTP MCP server round-trip)', () => {
  let fakeServer: FakeSlackMcpServer;
  let getAccessToken: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let connector: SlackMcpConnector;
  const accessToken = 'fixture-slack-access-token-xyz789';

  beforeEach(async () => {
    fakeServer = await startFakeSlackMcpServer();
    getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValue(accessToken);
    connector = new SlackMcpConnector({
      connectorType: 'slack',
      serverUrl: fakeServer.serverUrl,
      getAccessToken,
    });
  });

  afterEach(async () => {
    await connector.disconnect();
    await fakeServer.close();
  });

  it('1. connectorType is exactly "slack"', () => {
    expect(connector.connectorType).toBe('slack');
  });

  it('2. connect() sends "Authorization: Bearer <token>" (from getAccessToken()) on every request to the real Slack-flavored fake server', async () => {
    await connector.connect();

    expect(fakeServer.capturedAuthHeaders.length).toBeGreaterThan(0);
    expect(
      fakeServer.capturedAuthHeaders.every((header) => header === `Bearer ${accessToken}`),
    ).toBe(true);
  });

  it('3. callTool("slack-search-messages", ...) resolves with the connector\'s validated content and isError:false (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.callTool(SEARCH_TOOL_NAME, { query: 'deploy' });

    expect(result.isError).toBe(false);
    expect(result.content).toBeDefined();
  });

  it('4. callTool() throws NotFoundError for a toolName SlackMcpConnector never declared a schema for, even though the fake server itself knows that tool', async () => {
    await connector.connect();

    await expect(connector.callTool(UNDECLARED_TOOL_NAME, {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("5. callTool() throws ValidationError when the server's result for a KNOWN, declared tool does not match SlackMcpConnector's own declared schema", async () => {
    await connector.connect();

    // NOTE for implementer: this test requires `TOOL_RESULT_SCHEMAS['slack-broken']`
    // to be declared with a schema a plain `{type:'text', text: string}`
    // content block cannot satisfy (e.g. requiring `type: 'image'`), so the
    // fake server's deliberately-mismatched response (see
    // `startFakeSlackMcpServer` above) fails validation.
    await expect(connector.callTool(BROKEN_TOOL_NAME, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('6. readResource("slack://channel/fixture-channel-id") resolves with the validated content and correct mimeType (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.readResource(CHANNEL_RESOURCE_URI);

    expect(result.uri).toBe(CHANNEL_RESOURCE_URI);
    expect(result.mimeType).toBe('application/json');
    expect(result.content).toBeDefined();
  });

  it('7. readResource() throws NotFoundError for a uri SlackMcpConnector never declared a schema for, even though the fake server itself knows that resource', async () => {
    await connector.connect();

    await expect(connector.readResource(UNDECLARED_RESOURCE_URI)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('8. callTool()/readResource() throw InvalidObjectStateError before connect() has ever been called', async () => {
    await expect(connector.callTool(SEARCH_TOOL_NAME, {})).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
    await expect(connector.readResource(CHANNEL_RESOURCE_URI)).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
  });

  it('9. checkHealth() returns {status:"error"} before connect(), {status:"ok"} after a successful connect() -- proving SlackMcpConnector inherits the base class round-trip correctly, not just re-declaring its own', async () => {
    await expect(connector.checkHealth()).resolves.toMatchObject({ status: 'error' });

    await connector.connect();

    await expect(connector.checkHealth()).resolves.toEqual({ status: 'ok' });
  });
});
