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

import { GithubMcpConnector } from './github-mcp-connector.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { AddressInfo } from 'node:net';

/**
 * F2-T10 PR2 (RED step), ADR-0026 §d/§h — `GithubMcpConnector`
 * (`./github-mcp-connector.ts`, does NOT exist yet), mechanically repeating
 * PR1's proven `NotionMcpConnector` pattern (`./notion-mcp-connector.test.ts`)
 * for the GitHub concrete `StreamableHttpMcpConnector` subclass — ADR-0026
 * §d: "PR2(+PR3): kalan 4 bağlayıcı, PR1'in deseninin mekanik tekrarı."
 *
 * Real production `serverUrl` for `GithubMcpConnector` (wired in
 * `apps/server/src/integrations/mcp-connectors.module.ts`, NOT asserted by
 * this file, which talks to a local fake server instead — same as Notion's
 * own test file): `https://api.githubcopilot.com/mcp/` (GA but requires a
 * Copilot license + limited rollout per ADR-0026 §e).
 *
 * ============================================================================
 * SCHEMA-MAP CONTENT PINNED BY THIS FILE (ADR-0026 §h explicitly delegates
 * the exact tool/resource list + schema shapes to test-writer/implementer;
 * exact tool/resource names are NOT load-bearing outside this file — no real
 * GitHub Copilot-licensed account testing is possible in this session — only
 * internal consistency between this fake server and the connector's declared
 * schemas matters, same spirit as Notion's `notion-search`). `implementer`'s
 * real `github-mcp-connector.ts` MUST declare, at minimum:
 *
 *   TOOL_RESULT_SCHEMAS['github-search-issues'] — validates the RAW
 *     `raw.content` array `StreamableHttpMcpConnector.callTool`'s pinned body
 *     (ADR-0026 §g) passes into `parseOrThrow` — i.e. an array of
 *     `{type:'text', text: string}` content blocks.
 *   RESOURCE_CONTENT_SCHEMAS['github://repo/fixture-owner/fixture-repo'] —
 *     validates the single resource-content item `readResource`'s pinned
 *     body destructures as `first` — i.e. `{uri: string, text: string,
 *     mimeType?: string}`.
 *   Both maps must throw `NotFoundError` for any key they do not declare.
 *
 * ============================================================================
 * HARNESS: same real, in-process Streamable HTTP MCP server (SDK server
 * pieces, ADR-0026 §g/Bağlam 3) as `../streamable-http-mcp-connector.test.ts`
 * and `./notion-mcp-connector.test.ts` — not a live
 * `api.githubcopilot.com/mcp/`.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./github-mcp-connector.ts` does not exist
 * yet — the static import above rejects with a "Cannot find module"
 * resolution error, failing every test in this file at collection time. This
 * is a legitimate "implementation incomplete" red, not a test-logic bug.
 * ============================================================================
 */

const SEARCH_TOOL_NAME = 'github-search-issues';
const BROKEN_TOOL_NAME = 'github-broken';
const UNDECLARED_TOOL_NAME = 'github-undeclared-tool';
const REPO_RESOURCE_URI = 'github://repo/fixture-owner/fixture-repo';
const UNDECLARED_RESOURCE_URI = 'github://undeclared';

interface FakeGithubMcpServer {
  serverUrl: string;
  capturedAuthHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** Same real Streamable HTTP MCP server construction as
 * `../streamable-http-mcp-connector.test.ts`'s `startFakeMcpServer` --
 * duplicated locally (small, self-contained, per this repo's established
 * per-file-integration-test convention) with GitHub-flavored tool/resource
 * names instead of generic ones. */
async function startFakeGithubMcpServer(): Promise<FakeGithubMcpServer> {
  const capturedAuthHeaders: (string | undefined)[] = [];

  const mcpServer = new LowLevelMcpServer(
    { name: 'fake-github-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === SEARCH_TOOL_NAME) {
      return {
        content: [{ type: 'text', text: 'GitHub search result' }],
        isError: false,
      } satisfies CallToolResult;
    }

    if (name === BROKEN_TOOL_NAME) {
      // Deliberately returns a shape that does NOT match whatever schema
      // `GithubMcpConnector` declares for this tool name -- see this file's
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

    throw new Error(`fake GitHub MCP server: unknown tool "${name}"`);
  });

  mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === REPO_RESOURCE_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: '{"owner":"fixture-owner","repo":"fixture-repo"}',
          },
        ],
      } satisfies ReadResourceResult;
    }

    if (uri === UNDECLARED_RESOURCE_URI) {
      return {
        contents: [{ uri, mimeType: 'text/plain', text: 'server knows this resource too' }],
      } satisfies ReadResourceResult;
    }

    throw new Error(`fake GitHub MCP server: unknown resource "${uri}"`);
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

describe('GithubMcpConnector (ADR-0026 §d/§h, real fake-HTTP MCP server round-trip)', () => {
  let fakeServer: FakeGithubMcpServer;
  let getAccessToken: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let connector: GithubMcpConnector;
  const accessToken = 'fixture-github-access-token-xyz789';

  beforeEach(async () => {
    fakeServer = await startFakeGithubMcpServer();
    getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValue(accessToken);
    connector = new GithubMcpConnector({
      connectorType: 'github',
      serverUrl: fakeServer.serverUrl,
      getAccessToken,
    });
  });

  afterEach(async () => {
    await connector.disconnect();
    await fakeServer.close();
  });

  it('1. connectorType is exactly "github"', () => {
    expect(connector.connectorType).toBe('github');
  });

  it('2. connect() sends "Authorization: Bearer <token>" (from getAccessToken()) on every request to the real GitHub-flavored fake server', async () => {
    await connector.connect();

    expect(fakeServer.capturedAuthHeaders.length).toBeGreaterThan(0);
    expect(
      fakeServer.capturedAuthHeaders.every((header) => header === `Bearer ${accessToken}`),
    ).toBe(true);
  });

  it('3. callTool("github-search-issues", ...) resolves with the connector\'s validated content and isError:false (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.callTool(SEARCH_TOOL_NAME, { query: 'is:open bug' });

    expect(result.isError).toBe(false);
    expect(result.content).toBeDefined();
  });

  it('4. callTool() throws NotFoundError for a toolName GithubMcpConnector never declared a schema for, even though the fake server itself knows that tool', async () => {
    await connector.connect();

    await expect(connector.callTool(UNDECLARED_TOOL_NAME, {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("5. callTool() throws ValidationError when the server's result for a KNOWN, declared tool does not match GithubMcpConnector's own declared schema", async () => {
    await connector.connect();

    // NOTE for implementer: this test requires `TOOL_RESULT_SCHEMAS['github-broken']`
    // to be declared with a schema a plain `{type:'text', text: string}`
    // content block cannot satisfy (e.g. requiring `type: 'image'`), so the
    // fake server's deliberately-mismatched response (see
    // `startFakeGithubMcpServer` above) fails validation.
    await expect(connector.callTool(BROKEN_TOOL_NAME, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('6. readResource("github://repo/fixture-owner/fixture-repo") resolves with the validated content and correct mimeType (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.readResource(REPO_RESOURCE_URI);

    expect(result.uri).toBe(REPO_RESOURCE_URI);
    expect(result.mimeType).toBe('application/json');
    expect(result.content).toBeDefined();
  });

  it('7. readResource() throws NotFoundError for a uri GithubMcpConnector never declared a schema for, even though the fake server itself knows that resource', async () => {
    await connector.connect();

    await expect(connector.readResource(UNDECLARED_RESOURCE_URI)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('8. callTool()/readResource() throw InvalidObjectStateError before connect() has ever been called', async () => {
    await expect(connector.callTool(SEARCH_TOOL_NAME, {})).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
    await expect(connector.readResource(REPO_RESOURCE_URI)).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
  });

  it('9. checkHealth() returns {status:"error"} before connect(), {status:"ok"} after a successful connect() -- proving GithubMcpConnector inherits the base class round-trip correctly, not just re-declaring its own', async () => {
    await expect(connector.checkHealth()).resolves.toMatchObject({ status: 'error' });

    await connector.connect();

    await expect(connector.checkHealth()).resolves.toEqual({ status: 'ok' });
  });
});
