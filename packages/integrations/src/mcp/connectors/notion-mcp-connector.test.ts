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

import { NotionMcpConnector } from './notion-mcp-connector.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { AddressInfo } from 'node:net';

/**
 * F2-T10 PR1 (RED step), ADR-0026 §h — `NotionMcpConnector`
 * (`./notion-mcp-connector.ts`, does NOT exist yet), the reference/
 * first-proven concrete `StreamableHttpMcpConnector` subclass (ADR-0026 §e:
 * Notion chosen over GitHub as the reference connector because its OAuth
 * app registration is self-serve/license-free/admin-approval-free).
 *
 * This file exercises `NotionMcpConnector` THROUGH the shared base class
 * (`../streamable-http-mcp-connector.test.ts` pins the base class's own
 * generic contract in full — `connect`/`disconnect`/`checkHealth`/not-
 * connected errors/idempotent `disconnect` are NOT re-tested here) — this
 * file's job is narrower: prove `NotionMcpConnector` correctly wires its OWN
 * `TOOL_RESULT_SCHEMAS`/`RESOURCE_CONTENT_SCHEMAS`-map-driven
 * `getToolResultSchema`/`getResourceContentSchema` hooks (ADR-0026 §h).
 *
 * ============================================================================
 * SCHEMA-MAP CONTENT PINNED BY THIS FILE (ADR-0026 §h explicitly delegates
 * the exact tool/resource list + schema shapes to test-writer/implementer --
 * "kendi başına yeni bir mimari karar taşımıyor, Karar (g)/(h)'nin doğrudan
 * bir uygulaması"). `implementer`'s real `notion-mcp-connector.ts` MUST
 * declare, at minimum, the following in its `TOOL_RESULT_SCHEMAS`/
 * `RESOURCE_CONTENT_SCHEMAS` maps for this file to go green (additional
 * tools/resources beyond these are fine and untested here):
 *
 *   TOOL_RESULT_SCHEMAS['notion-search'] — validates the RAW
 *     `raw.content` array `StreamableHttpMcpConnector.callTool`'s pinned
 *     body (ADR-0026 §g) passes into `parseOrThrow` — i.e. an array of
 *     `{type:'text', text: string}` content blocks, NOT the illustrative
 *     `z.object({results:...})` shown in ADR-0026 §h's snippet (which
 *     validates against that exact same `raw.content` value per §g and so
 *     could never be satisfied by a real MCP content-blocks array — see
 *     `../streamable-http-mcp-connector.test.ts`'s header for the same
 *     reasoning, applied here to Notion specifically).
 *   RESOURCE_CONTENT_SCHEMAS['notion://workspace'] — validates the single
 *     resource-content item `readResource`'s pinned body destructures as
 *     `first` — i.e. `{uri: string, text: string, mimeType?: string}`.
 *   Both maps must throw `NotFoundError` for any key they do not declare
 *   (ADR-0026 §g/§h's pinned contract, inherited from the abstract base).
 *
 * ============================================================================
 * HARNESS: same real, in-process Streamable HTTP MCP server (SDK server
 * pieces, ADR-0026 §g/Bağlam 3) as `../streamable-http-mcp-connector.test.ts`
 * — not a live `mcp.notion.com`, not a hand-rolled protocol fake.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./notion-mcp-connector.ts` nor
 * `../streamable-http-mcp-connector.ts` (which it extends) exist yet — the
 * static import above rejects with a "Cannot find module" resolution error,
 * failing every test in this file at collection time. `zod` is also not yet
 * a declared dependency of `packages/integrations` (see the sibling test
 * file's header for the same note) — `implementer` must add it alongside
 * both connector files. Both are legitimate "implementation incomplete"
 * reds, not test-logic bugs.
 * ============================================================================
 */

const SEARCH_TOOL_NAME = 'notion-search';
const BROKEN_TOOL_NAME = 'notion-broken';
const UNDECLARED_TOOL_NAME = 'notion-undeclared-tool';
const WORKSPACE_RESOURCE_URI = 'notion://workspace';
const UNDECLARED_RESOURCE_URI = 'notion://undeclared';

interface FakeNotionMcpServer {
  serverUrl: string;
  capturedAuthHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** Same real Streamable HTTP MCP server construction as
 * `../streamable-http-mcp-connector.test.ts`'s `startFakeMcpServer` --
 * duplicated locally (small, self-contained, per this repo's established
 * per-file-integration-test convention) with Notion-flavored tool/resource
 * names instead of generic ones. */
async function startFakeNotionMcpServer(): Promise<FakeNotionMcpServer> {
  const capturedAuthHeaders: (string | undefined)[] = [];

  const mcpServer = new LowLevelMcpServer(
    { name: 'fake-notion-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === SEARCH_TOOL_NAME) {
      return {
        content: [{ type: 'text', text: 'Notion search result' }],
        isError: false,
      } satisfies CallToolResult;
    }

    if (name === BROKEN_TOOL_NAME) {
      // Deliberately returns a shape that does NOT match whatever schema
      // `NotionMcpConnector` declares for this tool name -- see this file's
      // "10." test below.
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

    throw new Error(`fake Notion MCP server: unknown tool "${name}"`);
  });

  mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === WORKSPACE_RESOURCE_URI) {
      return {
        contents: [{ uri, mimeType: 'application/json', text: '{"workspace":"fixture"}' }],
      } satisfies ReadResourceResult;
    }

    if (uri === UNDECLARED_RESOURCE_URI) {
      return {
        contents: [{ uri, mimeType: 'text/plain', text: 'server knows this resource too' }],
      } satisfies ReadResourceResult;
    }

    throw new Error(`fake Notion MCP server: unknown resource "${uri}"`);
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // `StreamableHTTPServerTransport` genuinely implements `Transport`
  // (verified at the SDK's own `implements Transport` class declaration) --
  // the mismatch here is purely a structural-assignability false positive
  // under `exactOptionalPropertyTypes: true` (the SDK's `onclose?: () =>
  // void` field declaration on the concrete class isn't structurally
  // identical to the interface's optional-property shape). Narrow, targeted
  // cast at the one call site rather than weakening the tsconfig.
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

describe('NotionMcpConnector (ADR-0026 §e/§h, real fake-HTTP MCP server round-trip)', () => {
  let fakeServer: FakeNotionMcpServer;
  let getAccessToken: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let connector: NotionMcpConnector;
  const accessToken = 'fixture-notion-access-token-xyz789';

  beforeEach(async () => {
    fakeServer = await startFakeNotionMcpServer();
    getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValue(accessToken);
    connector = new NotionMcpConnector({
      connectorType: 'notion',
      serverUrl: fakeServer.serverUrl,
      getAccessToken,
    });
  });

  afterEach(async () => {
    await connector.disconnect();
    await fakeServer.close();
  });

  it('1. connectorType is exactly "notion"', () => {
    expect(connector.connectorType).toBe('notion');
  });

  it('2. connect() sends "Authorization: Bearer <token>" (from getAccessToken()) on every request to the real Notion-flavored fake server', async () => {
    await connector.connect();

    expect(fakeServer.capturedAuthHeaders.length).toBeGreaterThan(0);
    expect(
      fakeServer.capturedAuthHeaders.every((header) => header === `Bearer ${accessToken}`),
    ).toBe(true);
  });

  it('3. callTool("notion-search", ...) resolves with the connector\'s validated content and isError:false (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.callTool(SEARCH_TOOL_NAME, { query: 'roadmap' });

    expect(result.isError).toBe(false);
    expect(result.content).toBeDefined();
  });

  it('4. callTool() throws NotFoundError for a toolName NotionMcpConnector never declared a schema for, even though the fake server itself knows that tool', async () => {
    await connector.connect();

    await expect(connector.callTool(UNDECLARED_TOOL_NAME, {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("5. callTool() throws ValidationError when the server's result for a KNOWN, declared tool does not match NotionMcpConnector's own declared schema", async () => {
    await connector.connect();

    // NOTE for implementer: this test requires `TOOL_RESULT_SCHEMAS['notion-broken']`
    // to be declared with a schema that a plain `{type:'text', text: string}`
    // content block cannot satisfy (e.g. requiring `type: 'image'`), so the
    // fake server's deliberately-mismatched response (see
    // `startFakeNotionMcpServer` above) fails validation. If implementer's
    // real schema map has no 'notion-broken' entry at all, this test's
    // expectation of `ValidationError` (rather than `NotFoundError`) will
    // need `implementer` to add exactly this kind of entry.
    await expect(connector.callTool(BROKEN_TOOL_NAME, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('6. readResource("notion://workspace") resolves with the validated content and correct mimeType (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.readResource(WORKSPACE_RESOURCE_URI);

    expect(result.uri).toBe(WORKSPACE_RESOURCE_URI);
    expect(result.mimeType).toBe('application/json');
    expect(result.content).toBeDefined();
  });

  it('7. readResource() throws NotFoundError for a uri NotionMcpConnector never declared a schema for, even though the fake server itself knows that resource', async () => {
    await connector.connect();

    await expect(connector.readResource(UNDECLARED_RESOURCE_URI)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('8. callTool()/readResource() throw InvalidObjectStateError before connect() has ever been called', async () => {
    await expect(connector.callTool(SEARCH_TOOL_NAME, {})).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
    await expect(connector.readResource(WORKSPACE_RESOURCE_URI)).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
  });

  it('9. checkHealth() returns {status:"error"} before connect(), {status:"ok"} after a successful connect() -- proving NotionMcpConnector inherits the base class round-trip correctly, not just re-declaring its own', async () => {
    await expect(connector.checkHealth()).resolves.toMatchObject({ status: 'error' });

    await connector.connect();

    await expect(connector.checkHealth()).resolves.toEqual({ status: 'ok' });
  });
});
