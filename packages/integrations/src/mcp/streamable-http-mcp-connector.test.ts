import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { Server as LowLevelMcpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { InvalidObjectStateError, NotFoundError, ValidationError } from '@luminaos/shared';

import { StreamableHttpMcpConnector } from './streamable-http-mcp-connector.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { AddressInfo } from 'node:net';
import type { ZodType } from 'zod';

/**
 * F2-T10 PR1 (RED step), ADR-0026 §g/§h — `StreamableHttpMcpConnector`
 * (`./streamable-http-mcp-connector.ts`, does NOT exist yet), the shared
 * abstract base every real connector (Notion first, then Drive/Gmail/Slack/
 * GitHub in PR2+) extends. See ADR-0026 §g for the pinned code this file
 * exercises byte-for-byte (constructor, `connect`/`disconnect`/`checkHealth`/
 * `callTool`/`readResource`/`parseOrThrow`, the two protected abstract hooks).
 *
 * ============================================================================
 * HARNESS: a REAL, tiny, in-process Streamable HTTP MCP server — not a live
 * external service, not a hand-rolled fake of the wire protocol. Built from
 * `@modelcontextprotocol/sdk`'s OWN server-side pieces (`Server` +
 * `StreamableHTTPServerTransport`, the exact counterpart to the connector's
 * client-side `Client` + `StreamableHTTPClientTransport`, ADR-0026 §g/Bağlam
 * 3), wired to a real `node:http` server on an ephemeral port
 * (`httpServer.listen(0)`). This means the connector under test does a real
 * network round-trip against a real (if minimal) MCP server implementation,
 * not a mocked transport — the strongest test double available without a
 * live external account, consistent with ADR-0026 §a's "gerçek kod TAM
 * yazılır, testler sahte-HTTP'ye karşı" decision.
 *
 * `TestConnector` is a minimal concrete subclass satisfying the two
 * `protected abstract` hooks with a small, closed schema map — deliberately
 * exercising `parseOrThrow`'s validation against the RAW MCP `content`/
 * `contents` shape the SDK's `Client.callTool()`/`readResource()` actually
 * returns (an array of typed content blocks, e.g. `{type:'text', text}`) —
 * NOT the illustrative `z.object({results:...})` shown in ADR-0026 §h's
 * Notion snippet, which validates against that exact same `raw.content`
 * value per §g's pinned `callTool` body and so cannot itself be satisfied by
 * a real MCP content-blocks array. ADR-0026 §h explicitly delegates the
 * EXACT schema-map contents to test-writer/implementer ("kendi başına yeni
 * bir mimari karar taşımıyor") — this file's judgment call is to validate
 * the actual `raw.content`/`raw.contents[0]` shape the SDK produces.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./streamable-http-mcp-connector.ts` does not
 * exist. The static import above rejects with a "Cannot find module"
 * resolution error, failing every test in this file at collection time --
 * this is the correct red, not a test-logic bug. A SECOND, independent red
 * surface is also expected: `zod` is not yet declared as a direct dependency
 * of `packages/integrations`'s `package.json` (today it only depends on
 * `@luminaos/shared` and `@modelcontextprotocol/sdk`, even though the SDK
 * itself depends on `zod` transitively) -- ADR-0026 §g/§h requires the real
 * `streamable-http-mcp-connector.ts` to import `zod` directly (the
 * `parseOrThrow`/`ZodType` hooks), so `implementer` must add `zod` as an
 * explicit `dependencies` entry in `packages/integrations/package.json`
 * alongside writing the class itself -- until then, `zod` may also fail to
 * resolve from this package, which is an equally legitimate "implementation
 * incomplete" red, not a test-logic bug.
 * ============================================================================
 */

const ECHO_TOOL_NAME = 'echo';
const WRONG_SHAPE_TOOL_NAME = 'returns-wrong-shape';
const UNDECLARED_TOOL_NAME = 'undeclared-tool';
const KNOWN_RESOURCE_URI = 'test://resource';

const TOOL_RESULT_SCHEMAS: Record<string, ZodType<unknown>> = {
  [ECHO_TOOL_NAME]: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  [WRONG_SHAPE_TOOL_NAME]: z.array(
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  ),
};

const RESOURCE_CONTENT_SCHEMAS: Record<string, ZodType<unknown>> = {
  [KNOWN_RESOURCE_URI]: z.object({
    uri: z.string(),
    text: z.string(),
    mimeType: z.string().optional(),
  }),
};

/** Minimal concrete subclass under test -- mirrors ADR-0026 §h's
 * `NotionMcpConnector` shape exactly, just with a trivial schema map. */
class TestConnector extends StreamableHttpMcpConnector {
  protected getToolResultSchema(toolName: string): ZodType<unknown> {
    const schema = TOOL_RESULT_SCHEMAS[toolName];
    if (!schema) {
      throw new NotFoundError(`Unknown tool "${toolName}" for connector "test-connector"`);
    }
    return schema;
  }

  protected getResourceContentSchema(uri: string): ZodType<unknown> {
    const schema = RESOURCE_CONTENT_SCHEMAS[uri];
    if (!schema) {
      throw new NotFoundError(`Unknown resource "${uri}" for connector "test-connector"`);
    }
    return schema;
  }
}

interface FakeMcpServer {
  serverUrl: string;
  capturedAuthHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

/** A REAL Streamable HTTP MCP server (SDK server pieces, ADR-0026 §g/Bağlam
 * 3), listening on an ephemeral local port. Every incoming HTTP request's
 * `Authorization` header is captured, in order, for assertion. */
async function startFakeMcpServer(): Promise<FakeMcpServer> {
  const capturedAuthHeaders: (string | undefined)[] = [];

  const mcpServer = new LowLevelMcpServer(
    { name: 'fake-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === ECHO_TOOL_NAME) {
      return {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      } satisfies CallToolResult;
    }

    if (name === WRONG_SHAPE_TOOL_NAME) {
      return {
        content: [{ type: 'text', text: 'this is text, not an image' }],
        isError: false,
      } satisfies CallToolResult;
    }

    if (name === UNDECLARED_TOOL_NAME) {
      return {
        content: [{ type: 'text', text: 'server knows this tool; connector class does not' }],
        isError: false,
      } satisfies CallToolResult;
    }

    throw new Error(`fake MCP server: unknown tool "${name}"`);
  });

  mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === KNOWN_RESOURCE_URI) {
      return {
        contents: [{ uri, mimeType: 'text/plain', text: 'hello resource' }],
      } satisfies ReadResourceResult;
    }

    throw new Error(`fake MCP server: unknown resource "${uri}"`);
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

describe('StreamableHttpMcpConnector (ADR-0026 §g/§h, real fake-HTTP MCP server round-trip)', () => {
  let fakeServer: FakeMcpServer;
  let getAccessToken: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let connector: TestConnector;
  const accessToken = 'fixture-access-token-abc123';

  beforeEach(async () => {
    fakeServer = await startFakeMcpServer();
    getAccessToken = vi.fn<() => Promise<string>>().mockResolvedValue(accessToken);
    connector = new TestConnector({
      connectorType: 'test-connector',
      serverUrl: fakeServer.serverUrl,
      getAccessToken,
    });
  });

  afterEach(async () => {
    await connector.disconnect();
    await fakeServer.close();
  });

  it('1. connect() sends "Authorization: Bearer <token>" (from getAccessToken()) on every request to the server', async () => {
    await connector.connect();

    expect(fakeServer.capturedAuthHeaders.length).toBeGreaterThan(0);
    expect(
      fakeServer.capturedAuthHeaders.every((header) => header === `Bearer ${accessToken}`),
    ).toBe(true);
  });

  it('2. getAccessToken() is called exactly once by connect(), and never called before connect() / by checkHealth()', async () => {
    expect(getAccessToken).not.toHaveBeenCalled();

    await connector.checkHealth();
    expect(getAccessToken).not.toHaveBeenCalled();

    await connector.connect();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('3. checkHealth() returns {status:"error", detail:"not connected"} before connect() has ever been called, and never throws', async () => {
    await expect(connector.checkHealth()).resolves.toEqual({
      status: 'error',
      detail: 'not connected',
    });
  });

  it('4. checkHealth() returns {status:"ok"} after a successful connect() (underlying ping succeeds)', async () => {
    await connector.connect();

    await expect(connector.checkHealth()).resolves.toEqual({ status: 'ok' });
  });

  it('5. checkHealth() returns {status:"error", detail:"not connected"} again after disconnect(), and never throws', async () => {
    await connector.connect();
    await connector.disconnect();

    await expect(connector.checkHealth()).resolves.toEqual({
      status: 'error',
      detail: 'not connected',
    });
  });

  it('6. callTool() throws InvalidObjectStateError when called before connect()', async () => {
    await expect(connector.callTool(ECHO_TOOL_NAME, {})).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
  });

  it('7. readResource() throws InvalidObjectStateError when called before connect()', async () => {
    await expect(connector.readResource(KNOWN_RESOURCE_URI)).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
  });

  it('8. callTool() throws InvalidObjectStateError again after disconnect() (state fully reset, not just "never connected")', async () => {
    await connector.connect();
    await connector.disconnect();

    await expect(connector.callTool(ECHO_TOOL_NAME, {})).rejects.toBeInstanceOf(
      InvalidObjectStateError,
    );
  });

  it('9. callTool() resolves with the validated content + isError:false for a known, schema-matching tool result (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.callTool(ECHO_TOOL_NAME, {});

    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
  });

  it('10. callTool() throws ValidationError (ZodValidationPipe\'s exact "message + zod issues array" convention) when the tool result fails the connector\'s declared zod schema', async () => {
    await connector.connect();

    let caught: unknown;
    try {
      await connector.callTool(WRONG_SHAPE_TOOL_NAME, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const validationError = caught as ValidationError;
    expect(typeof validationError.message).toBe('string');
    expect(validationError.message.length).toBeGreaterThan(0);
    expect(Array.isArray(validationError.details)).toBe(true);
    expect((validationError.details as unknown[]).length).toBeGreaterThan(0);
  });

  it('11. callTool() throws NotFoundError for a toolName the connector subclass never declared a schema for, even though the underlying MCP server itself has that tool', async () => {
    await connector.connect();

    await expect(connector.callTool(UNDECLARED_TOOL_NAME, {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('12. readResource() resolves with the validated content + mimeType for a known, schema-matching resource (happy path round-trip)', async () => {
    await connector.connect();

    const result = await connector.readResource(KNOWN_RESOURCE_URI);

    expect(result).toEqual({
      uri: KNOWN_RESOURCE_URI,
      mimeType: 'text/plain',
      content: { uri: KNOWN_RESOURCE_URI, mimeType: 'text/plain', text: 'hello resource' },
    });
  });

  it('13. disconnect() is safe to call without a prior connect(), and safe to call twice in a row (idempotent)', async () => {
    const freshConnector = new TestConnector({
      connectorType: 'test-connector',
      serverUrl: fakeServer.serverUrl,
      getAccessToken,
    });

    await expect(freshConnector.disconnect()).resolves.toBeUndefined();
    await expect(freshConnector.disconnect()).resolves.toBeUndefined();
  });
});
