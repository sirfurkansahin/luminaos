import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { QuotaExceededError } from '@luminaos/shared';

import { FederationLinkCredentialsService } from './federation-link-credentials.service.js';
import { FederationLinksService } from './federation-links.service.js';
import { FederationScopeService } from './federation-scope.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { ContextService } from '../context/context.service.js';
import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F3-T14 PR2 (RED step), ADR-0048 §g/§h — `POST /federation-mcp`
 * (`FederationMcpController`, `apps/server/src/federation/federation-mcp.controller.ts`,
 * does NOT exist yet), full end-to-end proof over real HTTP + real Postgres +
 * real Redis via Testcontainers, mirroring
 * `../mcp-server/mcp.controller.integration.test.ts`'s harness exactly
 * (`Test.createTestingModule({ imports: [AppModule] })`, real `supertest`,
 * `app.get(...)` for DI resolution).
 *
 * ============================================================================
 * WIRE FORMAT: same raw JSON-RPC 2.0 `tools/call` POST convention as
 * `POST /mcp` (see that file's header for the full SDK-behavior rationale) --
 * a thrown error inside the registered `get_federated_context` tool callback
 * is caught by `McpServer` and surfaces as a SUCCESSFUL HTTP 200 whose
 * JSON-RPC `result.isError === true`, NOT a raw HTTP 4xx/5xx. The rate-limit
 * check (ADR-0048 §g's literal draft: `await this.rateLimit
 * .assertNotRateLimited(...)` called BEFORE the tool is even registered, at
 * the top of `handleFederationMcp`) is the one exception -- a rejection there
 * escapes to Nest's own `AppErrorFilter` as a real HTTP 429, exactly like
 * `POST /mcp`'s own rate-limit test.
 *
 * SPY STRATEGY: rather than `overrideProvider` (which requires rebuilding the
 * whole `TestingModule`, one boot per scenario), this file resolves the REAL,
 * already-DI-wired singleton instances of `ContextService`/
 * `FederationAuditService`/`FederationRateLimitService` via `app.get(...)`
 * ONCE in `beforeAll`, then uses `vi.spyOn(instance, 'method')` per test
 * (restored in `afterEach`) -- the exact technique
 * `../mcp-server/mcp.controller.integration.test.ts`'s sibling files use for
 * `ContextGraphSyncWorker`. `FederationAuditService`/`FederationRateLimitService`
 * are loaded via dynamic `import()` in `beforeAll` (they don't exist yet)
 * purely to obtain their class tokens for `app.get(Ctor)` -- the app itself
 * is still built from the real, unmodified `AppModule`.
 *
 * JUDGMENT CALLS flagged for `implementer`:
 * 1. ADR-0048 §g's own code draft calls `this.scopeService.isActiveScopeObject
 *    (linkId, hostWorkspaceId, objectId)` (3 args) and
 *    `this.scopeService.listActiveObjectIds(linkId, hostWorkspaceId)` -- but
 *    PR1's ACTUAL, already-merged `FederationScopeService.isActiveScopeObject`
 *    signature is `(linkId, objectId)` (2 args, no `hostWorkspaceId`), and
 *    `listActiveObjectIds` does not exist on `FederationScopeService` at all
 *    yet. `implementer` must either add `listActiveObjectIds(linkId,
 *    hostWorkspaceId)` to `FederationScopeService` (PR1's file, framework-
 *    minimal, no test-file boundary issue since `test-writer` cannot touch
 *    non-test files) or adapt `FederationMcpController` to the 2-arg
 *    `isActiveScopeObject` PR1 actually shipped -- this file's assertions are
 *    written against OBSERVABLE HTTP behavior only (not against the exact
 *    scope-service call signature), so either choice keeps these tests valid.
 * 2. `FederationAuditService`/`FederationRateLimitService` method names
 *    (`recordAccessedFailClosed`/`recordRequestedBestEffort`/
 *    `assertNotRateLimited`) are pinned VERBATIM by ADR-0048 §g's code draft,
 *    not guessed here.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `FederationMcpController` does not exist (no
 * route registered for `/federation-mcp` at all -- every request below
 * 404s), and neither does `./federation-audit.service.ts` /
 * `./federation-rate-limit.service.ts` (`beforeAll`'s dynamic imports of
 * those two reject with "Cannot find module" errors, failing every test in
 * this file at setup). This is the correct red, not a test-logic bug.
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

interface FederationAuditServiceLike {
  recordAccessedFailClosed(params: Record<string, unknown>): Promise<void>;
  recordRequestedBestEffort(params: Record<string, unknown>): Promise<void>;
}

interface FederationRateLimitServiceLike {
  assertNotRateLimited(hostWorkspaceId: string, credentialId: string, cost: number): Promise<void>;
}

interface FederationAuditServiceConstructor {
  new (...args: unknown[]): FederationAuditServiceLike;
}
interface FederationRateLimitServiceConstructor {
  new (...args: unknown[]): FederationRateLimitServiceLike;
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `federation-mcp-controller-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

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
      `No JSON-RPC data payload found in federation-mcp response body (status ${String(response.status)}): ${response.text}`,
    );
  }

  return JSON.parse(lastData) as JsonRpcResponseBody;
}

describe('F3-T14 PR2 (RED step): POST /federation-mcp (real Postgres + Redis via Testcontainers, ADR-0048 §g/§h)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let requestIdCounter = 0;

  let contextService: ContextService;
  let auditService: FederationAuditServiceLike;
  let rateLimitService: FederationRateLimitServiceLike;

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

    // Deliberately unresolvable until `implementer` creates these two files --
    // used ONLY to obtain class tokens for `app.get(Ctor)` below, see this
    // file's header for the full rationale.
    const auditModule: unknown = await import('./federation-audit.service.js');
    const FederationAuditServiceCtor = (
      auditModule as { FederationAuditService: FederationAuditServiceConstructor }
    ).FederationAuditService;

    const rateLimitModule: unknown = await import('./federation-rate-limit.service.js');
    const FederationRateLimitServiceCtor = (
      rateLimitModule as { FederationRateLimitService: FederationRateLimitServiceConstructor }
    ).FederationRateLimitService;

    // Dynamic for the same reason as the two modules above (and every other
    // sibling integration test in this codebase): a static top-level import
    // of anything that transitively pulls in `env.js` would be hoisted and
    // evaluated BEFORE this beforeAll sets DATABASE_URL/REDIS_URL above.
    const contextServiceModule: unknown = await import('../context/context.service.js');
    const ContextServiceCtor = (
      contextServiceModule as { ContextService: new (...args: unknown[]) => ContextService }
    ).ContextService;

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

    contextService = app.get(ContextServiceCtor);
    auditService = app.get(FederationAuditServiceCtor);
    rateLimitService = app.get(FederationRateLimitServiceCtor);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  async function registerOwnerWithWorkspace(label: string): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `federation-mcp test workspace ${label}`);
    return { cookie, userId, workspaceId };
  }

  async function createObject(cookie: string, workspaceId: string, title: string): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });
    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  /** Sets up a real, ACTIVE `FederationLink` (host = initiator, grantee =
   * counterpart) with one real object added to scope, and mints a real
   * federation credential -- all via the PR1 services directly (their own
   * REST controllers are also PR2 scope, not yet wired). */
  async function setupActiveLinkWithScopedObject(label: string): Promise<{
    linkId: string;
    hostWorkspaceId: string;
    hostCookie: string;
    granteeWorkspaceId: string;
    objectId: string;
    rawToken: string;
  }> {
    const host = await registerOwnerWithWorkspace(`${label}-host`);
    const grantee = await registerOwnerWithWorkspace(`${label}-grantee`);

    const objectId = await createObject(host.cookie, host.workspaceId, `${label} scoped object`);
    await syncOnce();

    const linksService = app.get(FederationLinksService);
    const scopeService = app.get(FederationScopeService);
    const credentialsService = app.get(FederationLinkCredentialsService);

    const link = await linksService.initiate(
      host.workspaceId,
      grantee.workspaceId,
      host.userId,
      'admin',
    );
    await linksService.accept(link.id, grantee.userId, 'admin');

    await scopeService.addObject(link.id, objectId, host.workspaceId, host.userId, 'admin');

    const { rawToken } = await credentialsService.grant(
      link.id,
      grantee.workspaceId,
      `${label} credential`,
      90,
      grantee.userId,
      'admin',
    );

    return {
      linkId: link.id,
      hostWorkspaceId: host.workspaceId,
      hostCookie: host.cookie,
      granteeWorkspaceId: grantee.workspaceId,
      objectId,
      rawToken,
    };
  }

  async function callGetFederatedContext(
    rawToken: string,
    objectId: string,
  ): Promise<request.Response> {
    requestIdCounter += 1;
    return request(server)
      .post('/federation-mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({
        jsonrpc: '2.0',
        id: requestIdCounter,
        method: 'tools/call',
        params: { name: 'get_federated_context', arguments: { objectId } },
      });
  }

  it("1. an objectId NOT in the federation scope -> ContextService.getContext is called ZERO times (fail-closed scope check), and the tool call reports an error, never the object's data", async () => {
    const setup = await setupActiveLinkWithScopedObject('out-of-scope');
    const outOfScopeObjectId = await createObject(
      setup.hostCookie,
      setup.hostWorkspaceId,
      'never added to federation scope',
    );
    await syncOnce();

    const getContextSpy = vi.spyOn(contextService, 'getContext');

    const response = await callGetFederatedContext(setup.rawToken, outOfScopeObjectId);

    expect(response.status).toBe(200);
    const jsonRpcBody = parseJsonRpcResponse(response);
    expect(jsonRpcBody.result?.isError).toBe(true);
    expect(getContextSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(jsonRpcBody)).not.toContain('never added to federation scope');
  });

  it('2. an objectId IN the federation scope -> ContextService.getContext is called with (hostWorkspaceId, objectId, "owner") -- the synthetic owner role bypassing field-level redaction (İnsan kararı 2)', async () => {
    const setup = await setupActiveLinkWithScopedObject('in-scope-role');
    const getContextSpy = vi.spyOn(contextService, 'getContext');

    const response = await callGetFederatedContext(setup.rawToken, setup.objectId);

    expect(response.status).toBe(200);
    const jsonRpcBody = parseJsonRpcResponse(response);
    expect(jsonRpcBody.result?.isError).not.toBe(true);
    expect(getContextSpy).toHaveBeenCalledWith(setup.hostWorkspaceId, setup.objectId, 'owner');
  });

  it('3. HOST-SIDE fail-closed audit: when recordAccessedFailClosed rejects, ContextService.getContext is NEVER called, and the tool call reports an error -- no read happens without the host audit write succeeding first', async () => {
    const setup = await setupActiveLinkWithScopedObject('host-audit-fails');
    const getContextSpy = vi.spyOn(contextService, 'getContext');
    vi.spyOn(auditService, 'recordAccessedFailClosed').mockRejectedValue(
      new Error('simulated host-side audit write failure'),
    );

    const response = await callGetFederatedContext(setup.rawToken, setup.objectId);

    expect(response.status).toBe(200);
    const jsonRpcBody = parseJsonRpcResponse(response);
    expect(jsonRpcBody.result?.isError).toBe(true);
    expect(getContextSpy).not.toHaveBeenCalled();
  });

  it('4. GRANTEE-SIDE best-effort audit: when recordRequestedBestEffort rejects, the tool call STILL succeeds -- the response does not depend on the second, best-effort write', async () => {
    const setup = await setupActiveLinkWithScopedObject('grantee-audit-fails');
    vi.spyOn(auditService, 'recordRequestedBestEffort').mockRejectedValue(
      new Error('simulated grantee-side audit write failure'),
    );

    const response = await callGetFederatedContext(setup.rawToken, setup.objectId);

    expect(response.status).toBe(200);
    const jsonRpcBody = parseJsonRpcResponse(response);
    expect(jsonRpcBody.result?.isError).not.toBe(true);
    const toolText = jsonRpcBody.result?.content[0]?.text;
    expect(toolText).toBeDefined();
  });

  it('5. rate limit exceeded (keyed by hostWorkspaceId+credentialId) -> HTTP 429, before any tool/context logic runs', async () => {
    const setup = await setupActiveLinkWithScopedObject('rate-limited');
    const getContextSpy = vi.spyOn(contextService, 'getContext');
    vi.spyOn(rateLimitService, 'assertNotRateLimited').mockRejectedValue(
      new QuotaExceededError('simulated federation rate limit exceeded'),
    );

    const response = await callGetFederatedContext(setup.rawToken, setup.objectId);

    expect(response.status).toBe(429);
    expect(getContextSpy).not.toHaveBeenCalled();
  });

  it('6. an invalid/unknown federation credential -> HTTP 401, never reaching the rate-limit or scope logic', async () => {
    requestIdCounter += 1;
    const response = await request(server)
      .post('/federation-mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer never-issued-federation-token')
      .send({
        jsonrpc: '2.0',
        id: requestIdCounter,
        method: 'tools/call',
        params: { name: 'get_federated_context', arguments: { objectId: 'irrelevant' } },
      });

    expect(response.status).toBe(401);
  });
});
