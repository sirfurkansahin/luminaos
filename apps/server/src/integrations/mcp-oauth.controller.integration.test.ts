import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T10 PR1 (RED step), ADR-0026 §i/§j/§l/§m/§n — the FIRST public REST
 * endpoints this codebase adds for MCP connector OAuth (`McpOAuthController`,
 * `./mcp-oauth.controller.ts`, does NOT exist yet), full Nest app boot +
 * supertest (mirrors `../calendar/calendar-token-refresh.integration.test.ts`'s
 * shape, since -- unlike F2-T9 PR2's services -- this task DOES add a
 * controller, ADR-0026 §n).
 *
 * Routes under test (ADR-0026 §j -- note the CALLBACK path deliberately has
 * NO `:workspaceId`, a documented, human-approved deviation from the spec's
 * literal text, per ADR-0026 §j's own explanation: provider `redirect_uri`
 * registration is workspace-INDEPENDENT; workspace/user correlation happens
 * entirely via the `state` row):
 *   - `POST /workspaces/:workspaceId/integrations/:connectorType/oauth/authorize`
 *     (`SessionAuthGuard` + `WorkspaceMembershipGuard`)
 *   - `GET /integrations/:connectorType/oauth/callback` (no guards -- the
 *     provider's own top-level browser redirect lands here; correlation is
 *     via `state`, NEVER `req.user`, ADR-0026 §j/§i)
 *
 * ============================================================================
 * TESTABILITY DECISION (task brief explicitly leaves this to test-writer's
 * judgment): `mcp-oauth-provider-configs.ts`'s `authorizeUrl`/`tokenUrl` for
 * Notion are real, hardcoded, production URLs (ADR-0026 §l/§n) -- this file
 * does NOT hit `mcp.notion.com` over the real network. Instead, the REAL
 * controller/`OAuthStateService`/`ConnectorCredentialsService`/
 * `exchangeAuthorizationCode` code paths all run for real, end-to-end,
 * against the real (Testcontainers) Postgres -- only the one genuine
 * external-network boundary (`exchangeAuthorizationCode`'s `fetch` POST to
 * the token endpoint) is intercepted, via `vi.stubGlobal('fetch', ...)` (this
 * codebase's own established fetch-mocking convention, see
 * `./oauth2-authorization-code-flow.test.ts`'s header). This keeps the
 * controller test meaningful (every LuminaOS-owned line of code actually
 * runs) without being flaky (no dependency on a live Notion account) --
 * preferred here over Nest-level `overrideProvider` DI mocking, since
 * `buildAuthorizationUrl`/`exchangeAuthorizationCode` are plain exported
 * functions (ADR-0026 §l), not injectable classes with a DI token to
 * override.
 *
 * `NOTION_CLIENT_ID`/`NOTION_CLIENT_SECRET` are set in `beforeAll`, BEFORE
 * the dynamic `../app.module.js` import, so the real DI factory (ADR-0026
 * §m) registers the real Notion path rather than falling back to Mock/
 * unregistered.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `McpOAuthController`/`./oauth-state.service.ts`
 * do not exist, and `IntegrationsModule`/`McpConnectorsModule` are not yet
 * imported into `AppModule` (ADR-0025 §n's deliberately-deferred step, which
 * THIS task closes). Concretely: `beforeAll`'s dynamic
 * `import('./oauth-state.service.js')` rejects with "Cannot find module",
 * failing every test in this file at setup -- the correct red, not a
 * test-logic bug. (Once that module exists, the red shifts to every request
 * in this file 404ing as an unmatched route, until the controller/module
 * wiring lands too.)
 * ============================================================================
 */

interface OAuthStateServiceContract {
  issue(workspaceId: string, userId: string, connectorType: string): Promise<string>;
  consume(state: string): Promise<{ workspaceId: string; userId: string; connectorType: string }>;
}

type OAuthStateServiceConstructor = new (db: Database) => OAuthStateServiceContract;

interface ConnectorCredentialsServiceContract {
  retrieve(
    workspaceId: string,
    userId: string,
    connectorType: string,
  ): Promise<Record<string, unknown> | undefined>;
}

type ConnectorCredentialsServiceConstructor = new (
  db: Database,
) => ConnectorCredentialsServiceContract;

const FIXTURE_WEB_ORIGIN = 'https://lumina-fixture-web-origin.example.com';
const PASSWORD = 'correct-horse-battery-staple';

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `mcp-oauth-controller-test-user-${String(emailCounter)}@example.com`;
}

function stubFetchTokenExchangeSuccess(): void {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        access_token: 'fixture-access-token',
        refresh_token: 'fixture-refresh-token',
        expires_in: 3600,
      }),
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('McpOAuthController (ADR-0026 §i/§j/§l/§m/§n, real Postgres + real HTTP via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let oauthStateService: OAuthStateServiceContract;
  let credentialsService: ConnectorCredentialsServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    process.env['WEB_ORIGIN'] = FIXTURE_WEB_ORIGIN;
    process.env['NOTION_CLIENT_ID'] = 'fixture-notion-client-id';
    process.env['NOTION_CLIENT_SECRET'] = 'fixture-notion-client-secret';

    await runMigrations(container.getConnectionUri());

    // Imported only after every env var above is set, per the established
    // convention in every other integration test file here.
    const { AppModule } = await import('../app.module.js');

    // Deliberately unresolvable until `implementer` creates
    // `./oauth-state.service.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained
    // to this one line.
    const oauthStateModule: unknown = await import('./oauth-state.service.js');
    const OAuthStateServiceCtor = (
      oauthStateModule as { OAuthStateService: OAuthStateServiceConstructor }
    ).OAuthStateService;

    const credentialsModule: unknown = await import('./connector-credentials.service.js');
    const ConnectorCredentialsServiceCtor = (
      credentialsModule as { ConnectorCredentialsService: ConnectorCredentialsServiceConstructor }
    ).ConnectorCredentialsService;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
    oauthStateService = app.get(OAuthStateServiceCtor);
    credentialsService = app.get(ConnectorCredentialsServiceCtor);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
      `MCP OAuth test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  function authorizeUrl(workspaceId: string, connectorType: string): string {
    return `/workspaces/${workspaceId}/integrations/${connectorType}/oauth/authorize`;
  }

  function callbackUrl(connectorType: string): string {
    return `/integrations/${connectorType}/oauth/callback`;
  }

  async function expireState(state: string): Promise<void> {
    await rawDb.$client.query(
      `update oauth_state_tokens set expires_at = now() - interval '1 minute' where state = $1`,
      [state],
    );
  }

  it('1. authorize: unauthenticated request -> 401', async () => {
    const response = await request(server).post(
      authorizeUrl('00000000-0000-4000-8000-000000000001', 'notion'),
    );

    expect(response.status).toBe(401);
  });

  it('2. authorize: authenticated but NOT a workspace member -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: outsiderCookie } = await registerUser();

    const response = await request(server)
      .post(authorizeUrl(workspaceId, 'notion'))
      .set('Cookie', outsiderCookie);

    expect(response.status).toBe(403);
  });

  it('3. authorize: successful call (member) returns an authorizeUrl pointing at the Notion authorize endpoint, and issues a state row consumable back to the SAME (workspaceId, userId, connectorType)', async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(authorizeUrl(workspaceId, 'notion'))
      .set('Cookie', cookie);

    expect([200, 201]).toContain(response.status);
    const body = response.body as { authorizeUrl: string };
    expect(typeof body.authorizeUrl).toBe('string');

    const url = new URL(body.authorizeUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('fixture-notion-client-id');
    expect(url.searchParams.get('redirect_uri')).toBeTruthy();

    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();

    const consumed = await oauthStateService.consume(state as string);
    expect(consumed).toEqual({ workspaceId, userId, connectorType: 'notion' });
  });

  it('4. authorize: an unconfigured connectorType (no CLIENT_ID/SECRET env for it) is rejected, never silently succeeding with a broken authorizeUrl', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(authorizeUrl(workspaceId, 'slack'))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it("5. callback: valid state+code exchanges the code (fetch intercepted) and stores the resulting credentials via the REAL ConnectorCredentialsService, keyed by the state row's OWN (workspaceId, userId) -- never from the request", async () => {
    const { userId, workspaceId } = await registerOwnerWithWorkspace();
    const state = await oauthStateService.issue(workspaceId, userId, 'notion');
    stubFetchTokenExchangeSuccess();

    const response = await request(server).get(
      `${callbackUrl('notion')}?state=${state}&code=fixture-auth-code`,
    );

    expect(response.status).toBe(302);

    const stored = await credentialsService.retrieve(workspaceId, userId, 'notion');
    expect(stored).toBeDefined();
    expect(stored?.['accessToken']).toBe('fixture-access-token');
  });

  it('6. callback: the final redirect target is always the fixed env.webOrigin ("/"), regardless of a client-supplied ?returnTo= (open-redirect protection)', async () => {
    const { userId, workspaceId } = await registerOwnerWithWorkspace();
    const state = await oauthStateService.issue(workspaceId, userId, 'notion');
    stubFetchTokenExchangeSuccess();

    const response = await request(server).get(
      `${callbackUrl('notion')}?state=${state}&code=fixture-auth-code&returnTo=https://evil.example.com`,
    );

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${FIXTURE_WEB_ORIGIN}/`);
    expect(response.headers.location).not.toContain('evil.example.com');
  });

  it('7. callback: an unknown/never-issued state is rejected (403, ForbiddenError)', async () => {
    const response = await request(server).get(
      `${callbackUrl('notion')}?state=never-issued-state-token&code=fixture-auth-code`,
    );

    expect(response.status).toBe(403);
  });

  it('8. callback: a state that has ALREADY been consumed once is rejected on the second attempt (403, single-use)', async () => {
    const { userId, workspaceId } = await registerOwnerWithWorkspace();
    const state = await oauthStateService.issue(workspaceId, userId, 'notion');
    stubFetchTokenExchangeSuccess();

    const first = await request(server).get(
      `${callbackUrl('notion')}?state=${state}&code=fixture-auth-code`,
    );
    expect(first.status).toBe(302);

    const second = await request(server).get(
      `${callbackUrl('notion')}?state=${state}&code=fixture-auth-code`,
    );
    expect(second.status).toBe(403);
  });

  it('9. callback: an expired state is rejected (403), even though it was genuinely issued', async () => {
    const { userId, workspaceId } = await registerOwnerWithWorkspace();
    const state = await oauthStateService.issue(workspaceId, userId, 'notion');
    await expireState(state);
    stubFetchTokenExchangeSuccess();

    const response = await request(server).get(
      `${callbackUrl('notion')}?state=${state}&code=fixture-auth-code`,
    );

    expect(response.status).toBe(403);
  });

  it("10. callback: a state issued for one connectorType is rejected when consumed via a different connectorType's callback URL (403, same no-oracle message, no token exchange attempted, nothing stored for either connectorType)", async () => {
    const { userId, workspaceId } = await registerOwnerWithWorkspace();
    const state = await oauthStateService.issue(workspaceId, userId, 'notion');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(server).get(
      `${callbackUrl('slack')}?state=${state}&code=fixture-auth-code`,
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const storedAsNotion = await credentialsService.retrieve(workspaceId, userId, 'notion');
    expect(storedAsNotion).toBeUndefined();
    const storedAsSlack = await credentialsService.retrieve(workspaceId, userId, 'slack');
    expect(storedAsSlack).toBeUndefined();
  });
});
