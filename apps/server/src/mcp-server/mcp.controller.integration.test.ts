import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T12 PR1 (RED step), ADR-0028 §j/§m — `POST /mcp` (workspace-independent
 * URL, `McpController`/`McpTokenAuthGuard`/`McpClientGrantsService`/
 * `InboundMcpRateLimitService`, `apps/server/src/mcp-server/`), full
 * end-to-end proof over real HTTP + real Postgres + real Redis via
 * Testcontainers, mirroring `../search/search.integration.test.ts`'s harness
 * exactly (`postgres:16` + `redis:7`, `runMigrations`, dynamic
 * `import('../app.module.js')`, `app.get(...)` for DI resolution, `supertest`
 * over the real HTTP server).
 *
 * ============================================================================
 * MCP WIRE FORMAT (this file's own judgment call, since ADR-0028 doesn't pin
 * a raw HTTP fixture -- it only pins the SDK server-side classes/wiring code,
 * §m): a raw JSON-RPC 2.0 `tools/call` request is POSTed directly (no prior
 * `initialize` handshake), with `Accept: application/json, text/event-stream`
 * and `Content-Type: application/json`, per the installed
 * `@modelcontextprotocol/sdk@1.x`'s OWN `webStandardStreamableHttp.js`
 * (read in full this session): in STATELESS mode (`sessionIdGenerator:
 * undefined`, ADR-0028 §j/§m's literal transport construction),
 * `validateSession` returns immediately with no error whenever
 * `sessionIdGenerator === undefined`, entirely independent of whether an
 * `initialize` request was ever received on this transport instance -- and
 * `McpServer`'s own `CallToolRequestSchema` handler (`server/mcp.js`) has no
 * "must initialize first" state-machine check of its own either. A prior
 * `initialize` round-trip is therefore NOT required for a single `tools/call`
 * POST to be processed correctly against this specific (fresh-per-request,
 * ADR-0028 §j) transport -- this is deliberately simpler than driving the
 * real `@modelcontextprotocol/sdk` CLIENT class end-to-end, while still
 * exercising the REAL server-side SDK pieces (`McpServer` +
 * `StreamableHTTPServerTransport`) `McpController` actually wires up.
 *
 * The SDK's default response mode is SSE streaming (`event: message\ndata:
 * <json>\n\n`), not a plain JSON body -- `parseMcpToolCallResult` below
 * extracts the JSON-RPC payload from either shape (SSE `data:` line, or a
 * bare JSON body, in case a future PR ever sets `enableJsonResponse`).
 *
 * A THROWN error inside a registered tool callback (e.g. `ContextService`'s
 * `NotFoundError` for a missing/cross-workspace `objectId`, or `McpServer`'s
 * own "tool not found" `McpError`) is caught internally by `McpServer`
 * (`server/mcp.js`, read in full this session) and converted into a
 * SUCCESSFUL JSON-RPC response whose `result.isError === true` -- this is
 * standard MCP tool-execution-error semantics (the protocol layer itself
 * never errors), NOT a crash/500. Every test below that expects a "not
 * found"/"unsupported tool" outcome asserts `result.isError === true` at the
 * HTTP-200 JSON-RPC level, per this SDK behavior -- 401/403 are the only
 * genuinely non-200 HTTP statuses in this file, both produced by
 * `McpTokenAuthGuard` BEFORE any MCP/JSON-RPC handling ever runs.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): none of `McpController`/`McpTokenAuthGuard`/
 * `McpClientGrantsService`/`InboundMcpRateLimitService`/`McpServerModule`
 * exist yet, nor does the `mcp_client_grants`/`mcp_rate_limit_buckets`
 * migration. Every request below to `/mcp` 404s (route doesn't exist), and
 * `beforeAll`'s dynamic `import('./mcp-client-grants.service.js')` (used only
 * to MINT fixture tokens for these tests, not itself under test here) rejects
 * with a "Cannot find module" error, failing every test at setup -- this is
 * the correct red, not a test-logic bug.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}
interface WorkspaceEnvelope {
  workspace: { id: string };
}
interface ObjectEnvelope {
  object: { id: string; fieldValues: Record<string, unknown> };
}
interface FieldDefinitionEnvelope {
  fieldDefinition: { id: string; key: string };
}
interface ContextResponseBody {
  asOf: string;
  entity: {
    entityId: string;
    objectType: string;
    title: string;
    fieldValues: Record<string, unknown>;
  };
  edges: unknown[];
}

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface McpClientGrantContract {
  id: string;
  workspaceId: string;
  userId: string;
}

interface McpClientGrantsServiceContract {
  grant(
    workspaceId: string,
    userId: string,
    name: string,
    expiresAtDays: 30 | 90 | 365,
  ): Promise<{ grant: McpClientGrantContract; rawToken: string }>;
}

type McpClientGrantsServiceConstructor = new (db: Database) => McpClientGrantsServiceContract;

interface CallToolResultBody {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface JsonRpcResponseBody {
  jsonrpc: '2.0';
  id: number;
  result?: CallToolResultBody;
  error?: { code: number; message: string };
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `mcp-controller-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

/** Extracts the JSON-RPC message from either the SDK's default SSE response
 * body (`event: message\ndata: <json>\n\n`) or a bare JSON body -- see this
 * file's header for why both shapes are handled. */
function parseJsonRpcResponse(response: request.Response): JsonRpcResponseBody {
  const contentType = response.headers['content-type'] ?? '';

  if (contentType.includes('application/json')) {
    return JSON.parse(response.text) as JsonRpcResponseBody;
  }

  const dataLines = response.text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((data) => data.length > 0);

  const lastData = dataLines[dataLines.length - 1];
  if (!lastData) {
    throw new Error(
      `No JSON-RPC data payload found in MCP response body (status ${String(response.status)}): ${response.text}`,
    );
  }

  return JSON.parse(lastData) as JsonRpcResponseBody;
}

describe('F2-T12 PR1 (RED step): POST /mcp (real Postgres + Redis via Testcontainers, ADR-0028)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let grantsService: McpClientGrantsServiceContract;
  let requestIdCounter = 0;

  interface ContextGraphSyncWorkerLike {
    syncOnce(): Promise<void>;
  }
  interface ContextGraphSyncWorkerConstructor {
    new (...args: unknown[]): ContextGraphSyncWorkerLike;
  }
  let ContextGraphSyncWorker: ContextGraphSyncWorkerConstructor;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    const workerModule = (await import('../context/context-graph-sync.worker.js')) as unknown as {
      ContextGraphSyncWorker: ContextGraphSyncWorkerConstructor;
    };
    ContextGraphSyncWorker = workerModule.ContextGraphSyncWorker;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());

    // Only used here to MINT fixture Bearer tokens for these HTTP tests --
    // `McpClientGrantsService` itself has its own dedicated RED-step coverage
    // in `./mcp-client-grants.service.test.ts`.
    const grantsModule: unknown = await import('./mcp-client-grants.service.js');
    const McpClientGrantsServiceCtor = (
      grantsModule as { McpClientGrantsService: McpClientGrantsServiceConstructor }
    ).McpClientGrantsService;
    grantsService = new McpClientGrantsServiceCtor(rawDb);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function syncOnce(): Promise<void> {
    const worker = app.get(ContextGraphSyncWorker);
    await worker.syncOnce();
  }

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId };
  }

  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });
    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerOwnerWithWorkspace(): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `MCP controller test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
  }

  async function removeMembership(workspaceId: string, userId: string): Promise<void> {
    await rawDb.$client.query(`delete from memberships where workspace_id = $1 and user_id = $2`, [
      workspaceId,
      userId,
    ]);
  }

  async function createObject(cookie: string, workspaceId: string, title: string): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });
    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  async function defineField(
    cookie: string,
    workspaceId: string,
    body: {
      key: string;
      label: string;
      fieldType: string;
      config: unknown;
      permissions: FieldPermissionsBody;
    },
  ): Promise<void> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/object-types/task/fields`)
      .set('Cookie', cookie)
      .send(body);
    expect(response.status).toBe(201);
    void (response.body as FieldDefinitionEnvelope);
  }

  async function setFieldValues(
    cookie: string,
    workspaceId: string,
    objectId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const response = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values });
    expect(response.status).toBe(200);
  }

  async function mintToken(
    workspaceId: string,
    userId: string,
  ): Promise<{ rawToken: string; grantId: string }> {
    const { grant: createdGrant, rawToken } = await grantsService.grant(
      workspaceId,
      userId,
      'MCP controller test token',
      90,
    );
    return { rawToken, grantId: createdGrant.id };
  }

  async function callGetContext(
    rawToken: string | undefined,
    objectId: string,
  ): Promise<request.Response> {
    requestIdCounter += 1;
    const req = request(server)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: requestIdCounter,
        method: 'tools/call',
        params: { name: 'get_context', arguments: { objectId } },
      });

    if (rawToken !== undefined) {
      req.set('Authorization', `Bearer ${rawToken}`);
    }

    return req;
  }

  async function callTool(
    rawToken: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<request.Response> {
    requestIdCounter += 1;
    return request(server)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({
        jsonrpc: '2.0',
        id: requestIdCounter,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
  }

  it('1. get_context via MCP returns the SAME context payload the direct GET /workspaces/:workspaceId/context/:objectId endpoint returns, for an object the token owner can see', async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();
    const objectId = await createObject(cookie, workspaceId, 'MCP Pipeline Proof Object');
    await syncOnce();

    const directResponse = await request(server)
      .get(`/workspaces/${workspaceId}/context/${objectId}`)
      .set('Cookie', cookie);
    expect(directResponse.status).toBe(200);
    const directBody = directResponse.body as ContextResponseBody;

    const { rawToken } = await mintToken(workspaceId, userId);
    const mcpResponse = await callGetContext(rawToken, objectId);

    expect(mcpResponse.status).toBe(200);
    const jsonRpcBody = parseJsonRpcResponse(mcpResponse);
    expect(jsonRpcBody.result?.isError).not.toBe(true);
    const toolText = jsonRpcBody.result?.content[0]?.text;
    expect(toolText).toBeDefined();
    const mcpContextBody = JSON.parse(toolText as string) as ContextResponseBody;

    expect(mcpContextBody.entity.entityId).toBe(directBody.entity.entityId);
    expect(mcpContextBody.entity.title).toBe(directBody.entity.title);
    expect(mcpContextBody.entity.objectType).toBe(directBody.entity.objectType);
    expect(mcpContextBody.entity.fieldValues).toEqual(directBody.entity.fieldValues);
  });

  it('2. missing/invalid Bearer token -> HTTP 401, no context data anywhere in the response body', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const objectId = await createObject(cookie, workspaceId, 'Secret Unauthorized Test Object');
    await syncOnce();

    const missingHeaderResponse = await callGetContext(undefined, objectId);
    expect(missingHeaderResponse.status).toBe(401);
    expect(JSON.stringify(missingHeaderResponse.body)).not.toContain(objectId);
    expect(JSON.stringify(missingHeaderResponse.body)).not.toContain('Secret Unauthorized');

    const invalidTokenResponse = await callGetContext('never-issued-token-value', objectId);
    expect(invalidTokenResponse.status).toBe(401);
    expect(JSON.stringify(invalidTokenResponse.body)).not.toContain(objectId);
  });

  it("3. a token whose owner is no longer a member of the token's workspace -> HTTP 403, no context data leaks", async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const objectId = await createObject(ownerCookie, workspaceId, 'Removed Member Test Object');
    await syncOnce();

    const { userId: memberUserId } = await addMemberWithRole(workspaceId, 'member');
    const { rawToken } = await mintToken(workspaceId, memberUserId);

    // Sanity: the token works BEFORE membership is removed.
    const beforeRemoval = await callGetContext(rawToken, objectId);
    expect(beforeRemoval.status).toBe(200);

    await removeMembership(workspaceId, memberUserId);

    const afterRemoval = await callGetContext(rawToken, objectId);
    expect(afterRemoval.status).toBe(403);
    expect(JSON.stringify(afterRemoval.body)).not.toContain(objectId);
    expect(JSON.stringify(afterRemoval.body)).not.toContain('Removed Member Test Object');
  });

  it("4. cross-user/cross-workspace isolation (security-critical): user A's token can NEVER retrieve context data scoped to a different workspace, even when asked for an objectId that only exists in that other workspace", async () => {
    const {
      cookie: cookieA,
      userId: userIdA,
      workspaceId: workspaceA,
    } = await registerOwnerWithWorkspace();
    const { cookie: cookieB, workspaceId: workspaceB } = await registerOwnerWithWorkspace();

    await createObject(cookieA, workspaceA, "A's own object");
    const objectIdB = await createObject(cookieB, workspaceB, "B's secret object");
    await syncOnce();

    const { rawToken: tokenA } = await mintToken(workspaceA, userIdA);

    // A's token is bound to workspaceA -- asking for B's real objectId must
    // behave as "not found" (ContextService's existing scoping), never
    // resolve/leak B's data.
    const response = await callGetContext(tokenA, objectIdB);

    expect(response.status).toBe(200);
    const jsonRpcBody = parseJsonRpcResponse(response);
    expect(jsonRpcBody.result?.isError).toBe(true);
    expect(JSON.stringify(jsonRpcBody)).not.toContain("B's secret object");
  });

  it("5. field-level permission filtering still applies through MCP -- a hidden field for the token owner's role is filtered out identically to the direct HTTP endpoint", async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: guestCookie, userId: guestUserId } = await addMemberWithRole(
      workspaceId,
      'guest',
    );

    await defineField(ownerCookie, workspaceId, {
      key: 'secret-note',
      label: 'Secret Note',
      fieldType: 'text',
      config: {},
      permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'hidden' },
    });
    await defineField(ownerCookie, workspaceId, {
      key: 'visible-note',
      label: 'Visible Note',
      fieldType: 'text',
      config: {},
      permissions: { owner: 'edit', admin: 'edit', member: 'view', guest: 'view' },
    });

    const objectId = await createObject(ownerCookie, workspaceId, 'Field Filtering Test Object');
    await setFieldValues(ownerCookie, workspaceId, objectId, {
      'secret-note': 'shh',
      'visible-note': 'ok',
    });
    await syncOnce();

    const directGuestResponse = await request(server)
      .get(`/workspaces/${workspaceId}/context/${objectId}`)
      .set('Cookie', guestCookie);
    expect(directGuestResponse.status).toBe(200);
    const directBody = directGuestResponse.body as ContextResponseBody;
    expect(directBody.entity.fieldValues).not.toHaveProperty('secret-note');
    expect(directBody.entity.fieldValues['visible-note']).toBe('ok');

    const { rawToken } = await mintToken(workspaceId, guestUserId);
    const mcpResponse = await callGetContext(rawToken, objectId);
    expect(mcpResponse.status).toBe(200);
    const jsonRpcBody = parseJsonRpcResponse(mcpResponse);
    expect(jsonRpcBody.result?.isError).not.toBe(true);
    const toolText = jsonRpcBody.result?.content[0]?.text as string;
    const mcpBody = JSON.parse(toolText) as ContextResponseBody;

    expect(mcpBody.entity.fieldValues).not.toHaveProperty('secret-note');
    expect(mcpBody.entity.fieldValues['visible-note']).toBe('ok');
    expect(JSON.stringify(mcpResponse.body ?? mcpResponse.text)).not.toContain('shh');
  });

  it('6. inbound rate limit: a bucket already at zero tokens rejects the very next call (bypass-proof)', async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();
    const objectId = await createObject(cookie, workspaceId, 'Rate Limit Test Object');
    await syncOnce();

    const { rawToken, grantId } = await mintToken(workspaceId, userId);

    // Seed the bucket directly, already fully exhausted -- mirrors
    // `../integrations/connector-rate-limit.integration.test.ts`'s own
    // seeding convention for the outbound case (ADR-0028 §h reuses the same
    // `checkRateLimit` math/persistence shape, just keyed differently).
    await rawDb.$client.query(
      `insert into mcp_rate_limit_buckets
         (workspace_id, mcp_client_grant_id, capacity, tokens_available, refill_per_ms, last_refill_at_ms)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (workspace_id, mcp_client_grant_id) do update set
         capacity = excluded.capacity,
         tokens_available = excluded.tokens_available,
         refill_per_ms = excluded.refill_per_ms,
         last_refill_at_ms = excluded.last_refill_at_ms`,
      [workspaceId, grantId, 60, 0, 0, Date.now()],
    );

    const response = await callGetContext(rawToken, objectId);
    expect(response.status).toBe(429);
    expect(JSON.stringify(response.body)).not.toContain(objectId);
  });

  it('7. v0 has NO mutation tool -- calling an unknown/unsupported tool name fails gracefully (no crash, no 5xx), and the server keeps serving subsequent requests normally', async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();
    const objectId = await createObject(cookie, workspaceId, 'Unsupported Tool Test Object');
    await syncOnce();

    const { rawToken } = await mintToken(workspaceId, userId);

    const unsupportedResponse = await callTool(rawToken, 'create_object', { title: 'hacked in' });
    expect(unsupportedResponse.status).toBeLessThan(500);
    const jsonRpcBody = parseJsonRpcResponse(unsupportedResponse);
    // Either a JSON-RPC protocol-level `error`, or a successful envelope
    // whose CallToolResult carries `isError: true` -- either way, NOT a
    // successful object-creation result and NOT a server crash.
    const succeededAsToolCall =
      jsonRpcBody.result !== undefined && jsonRpcBody.result.isError !== true;
    expect(succeededAsToolCall).toBe(false);

    // The server must still work normally for a legitimate subsequent call.
    const followUpResponse = await callGetContext(rawToken, objectId);
    expect(followUpResponse.status).toBe(200);
    const followUpBody = parseJsonRpcResponse(followUpResponse);
    expect(followUpBody.result?.isError).not.toBe(true);
  });
});
