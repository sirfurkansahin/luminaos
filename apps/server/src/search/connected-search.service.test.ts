import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpConnector, McpToolCallResult } from '@luminaos/integrations';
import { QuotaExceededError } from '@luminaos/shared';

import { ConnectedSearchService as ConnectedSearchServiceModuleExport } from './connected-search.service.js';

import type { ConnectorCredentialsService } from '../integrations/connector-credentials.service.js';
import type { ConnectorRateLimitService } from '../integrations/connector-rate-limit.service.js';

/**
 * `./connected-search.service.ts` does not exist yet, so a bare import's
 * binding would otherwise be `any`, cascading `@typescript-eslint/no-unsafe-*`
 * errors through every call site below -- same lint-avoidance pattern as
 * `../integrations/connector-health.test.ts`'s
 * `ModuleExport as unknown as Constructor` technique. `ExternalSearchResult`/
 * `ConnectedSearchResponse` are re-declared locally (ADR-0027 §a's exact
 * shape) rather than type-imported from the not-yet-existing module, for the
 * same reason.
 */
interface ExternalSearchResult {
  connectorType: string;
  title: string;
  snippet: string;
}

interface ConnectedSearchResponse {
  results: ExternalSearchResult[];
  degraded: string[];
}

interface ConnectedSearchServiceInstance {
  searchExternal(
    workspaceId: string,
    userId: string,
    query: string,
  ): Promise<ConnectedSearchResponse>;
}

interface ConnectedSearchServiceConstructor {
  new (
    credentials: ConnectorCredentialsService,
    rateLimit: ConnectorRateLimitService,
  ): ConnectedSearchServiceInstance;
}

const ConnectedSearchService =
  ConnectedSearchServiceModuleExport as unknown as ConnectedSearchServiceConstructor;

/**
 * F2-T11 (RED step), ADR-0027 §a/§d/§e — `ConnectedSearchService`
 * (`./connected-search.service.ts`, does NOT exist yet as of this commit).
 *
 * `@luminaos/integrations`'s 5 concrete connector classes
 * (`NotionMcpConnector`/`GoogleDriveMcpConnector`/`GmailMcpConnector`/
 * `SlackMcpConnector`/`GithubMcpConnector`) are already real, tested exports
 * (F2-T10) -- this file replaces just those 5 named exports with
 * constructor mocks (`vi.mock` + `vi.hoisted`, preserving every other real
 * export, e.g. `McpConnectorRegistry`/`MockMcpConnector`) so
 * `ConnectedSearchService.buildConnector`'s `new NotionMcpConnector(...)`
 * (ADR-0027 §a) resolves to a hand-controlled `FakeConnector` implementing
 * the real `McpConnector` interface, rather than attempting a live MCP
 * handshake. This mirrors `../integrations/connector-health.test.ts`'s own
 * hand-written `FakeConnector implements McpConnector` technique, applied at
 * the module level via `vi.mock` instead of direct `registry.register(...)`.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./connected-search.service.ts` does not exist
 * -- this file's own top-level `import { ConnectedSearchService } from
 * './connected-search.service.js'` fails module resolution ("Cannot find
 * module"), failing every test in this file at collection time. This is the
 * correct red (mirrors `packages/integrations/src/mcp/connectors/
 * notion-mcp-connector.test.ts`'s identical convention for a not-yet-built
 * concrete class), not a test-logic bug.
 * ============================================================================
 */

type KnownConnectorType = 'notion' | 'google-drive' | 'gmail' | 'slack' | 'github';

const ALL_CONNECTOR_TYPES: readonly KnownConnectorType[] = [
  'notion',
  'google-drive',
  'gmail',
  'slack',
  'github',
];

/** ADR-0027 §a's pinned connectorType -> search-tool-name map -- asserted
 * against directly so a wrong tool name for any connector fails loudly. */
const SEARCH_TOOL_NAMES: Record<KnownConnectorType, string> = {
  notion: 'notion-search',
  'google-drive': 'drive-search',
  gmail: 'gmail-search-threads',
  slack: 'slack-search-messages',
  github: 'github-search-issues',
};

interface FakeConnectorController {
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  callTool: ReturnType<
    typeof vi.fn<(toolName: string, args: Record<string, unknown>) => Promise<McpToolCallResult>>
  >;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const {
  connectorControllers,
  connectorConstructorMocks,
  NotionMcpConnectorMock,
  GoogleDriveMcpConnectorMock,
  GmailMcpConnectorMock,
  SlackMcpConnectorMock,
  GithubMcpConnectorMock,
} = vi.hoisted(() => {
  const controllers = new Map<string, FakeConnectorController>();
  const constructorMocks = new Map<string, ReturnType<typeof vi.fn>>();

  function makeConnectorClassMock(connectorType: string) {
    // `mockImplementation` MUST receive a `function` expression, not an
    // arrow function -- `ConnectedSearchService.buildConnector` invokes this
    // with `new` (matching the real `NotionMcpConnector`/etc. classes'
    // calling convention), and arrow functions are never constructable
    // (`new (() => {})()` throws "is not a constructor"). Vitest's own
    // runtime warning ("The vi.fn() mock did not use 'function' or 'class'
    // in its implementation") points at exactly this.
    const ctor = vi.fn().mockImplementation(function (options: {
      serverUrl: string;
    }): McpConnector {
      const controller = controllers.get(connectorType);
      if (!controller) {
        throw new Error(
          `FakeConnector: no controller registered for connectorType "${connectorType}" -- call registerConnector() in this test first. serverUrl was "${options.serverUrl}".`,
        );
      }

      return {
        connectorType,
        connect: controller.connect,
        disconnect: controller.disconnect,
        checkHealth: () => Promise.resolve({ status: 'ok' as const }),
        callTool: controller.callTool,
        readResource: () =>
          Promise.reject(
            new Error('FakeConnector.readResource is unused by ConnectedSearchService'),
          ),
      };
    });
    constructorMocks.set(connectorType, ctor);
    return ctor;
  }

  return {
    connectorControllers: controllers,
    connectorConstructorMocks: constructorMocks,
    NotionMcpConnectorMock: makeConnectorClassMock('notion'),
    GoogleDriveMcpConnectorMock: makeConnectorClassMock('google-drive'),
    GmailMcpConnectorMock: makeConnectorClassMock('gmail'),
    SlackMcpConnectorMock: makeConnectorClassMock('slack'),
    GithubMcpConnectorMock: makeConnectorClassMock('github'),
  };
});

vi.mock('@luminaos/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@luminaos/integrations')>();
  return {
    ...actual,
    NotionMcpConnector: NotionMcpConnectorMock,
    GoogleDriveMcpConnector: GoogleDriveMcpConnectorMock,
    GmailMcpConnector: GmailMcpConnectorMock,
    SlackMcpConnector: SlackMcpConnectorMock,
    GithubMcpConnector: GithubMcpConnectorMock,
  };
});

function connectorClassMockFor(connectorType: KnownConnectorType): ReturnType<typeof vi.fn> {
  const ctor = connectorConstructorMocks.get(connectorType);
  if (!ctor) {
    throw new Error(`no connector constructor mock registered for "${connectorType}"`);
  }
  return ctor;
}

function registerConnector(
  connectorType: KnownConnectorType,
  overrides: {
    connect?: () => Promise<void>;
    callTool?: (toolName: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
    disconnect?: () => Promise<void>;
  } = {},
): FakeConnectorController {
  const controller: FakeConnectorController = {
    connect: vi.fn(overrides.connect ?? (() => Promise.resolve())),
    callTool: vi.fn(
      overrides.callTool ??
        (() =>
          Promise.resolve({ content: [{ type: 'text', text: 'default result' }], isError: false })),
    ),
    disconnect: vi.fn(overrides.disconnect ?? (() => Promise.resolve())),
  };
  connectorControllers.set(connectorType, controller);
  return controller;
}

function textResult(text: string): McpToolCallResult {
  return { content: [{ type: 'text', text }], isError: false };
}

function futureIso(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function pastIso(): string {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

function createCredentialsServiceMock(): {
  retrieve: ReturnType<typeof vi.fn<ConnectorCredentialsService['retrieve']>>;
  service: ConnectorCredentialsService;
} {
  const retrieve = vi.fn<ConnectorCredentialsService['retrieve']>().mockResolvedValue(undefined);
  return { retrieve, service: { retrieve } as unknown as ConnectorCredentialsService };
}

function createRateLimitServiceMock(): {
  assertNotRateLimited: ReturnType<typeof vi.fn<ConnectorRateLimitService['assertNotRateLimited']>>;
  service: ConnectorRateLimitService;
} {
  const assertNotRateLimited = vi
    .fn<ConnectorRateLimitService['assertNotRateLimited']>()
    .mockResolvedValue(undefined);
  return {
    assertNotRateLimited,
    service: { assertNotRateLimited } as unknown as ConnectorRateLimitService,
  };
}

beforeEach(() => {
  connectorControllers.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConnectedSearchService.searchExternal (ADR-0027 §a/§d/§e)', () => {
  it('1. (Kabul Kriteri: "bağlı olmayan connectorType için hiçbir çağrı yapılmaz") no connectorType connected -> {results: [], degraded: []}, and NEVER appears in degraded (never-connected != degraded)', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { assertNotRateLimited, service: rateLimitService } = createRateLimitServiceMock();
    retrieve.mockResolvedValue(undefined);

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response: ConnectedSearchResponse = await service.searchExternal(
      'ws-1',
      'user-1',
      'roadmap',
    );

    expect(response).toEqual({ results: [], degraded: [] });
    // Never-connected must not even reach the rate-limit check.
    expect(assertNotRateLimited).not.toHaveBeenCalled();
    for (const connectorType of ALL_CONNECTOR_TYPES) {
      expect(connectorClassMockFor(connectorType)).not.toHaveBeenCalled();
    }
  });

  it('2. (ADR §d, short text under both caps) one connected connectorType with valid creds + OK rate limit -> a single ExternalSearchResult with title/snippet reproducing the joined content verbatim', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { service: rateLimitService } = createRateLimitServiceMock();

    const shortText = 'Quarterly Roadmap Notes';
    retrieve.mockImplementation((_workspaceId, _userId, connectorType) =>
      connectorType === 'notion'
        ? Promise.resolve({ accessToken: 'token-notion-abc', expiresAt: futureIso() })
        : Promise.resolve(undefined),
    );
    const notionController = registerConnector('notion', {
      callTool: () => Promise.resolve(textResult(shortText)),
    });

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response = await service.searchExternal('ws-1', 'user-1', 'roadmap');

    expect(response.degraded).toEqual([]);
    expect(response.results).toHaveLength(1);
    const [result] = response.results as [ExternalSearchResult];
    expect(Object.keys(result).sort()).toEqual(['connectorType', 'snippet', 'title']);
    expect(result.connectorType).toBe('notion');
    // Under both the ~80 and ~300 caps -- unambiguous, exact reproduction.
    expect(result.title).toBe(shortText);
    expect(result.snippet).toBe(shortText);

    expect(notionController.connect).toHaveBeenCalledTimes(1);
    expect(notionController.callTool).toHaveBeenCalledTimes(1);
    expect(notionController.callTool).toHaveBeenCalledWith(SEARCH_TOOL_NAMES.notion, {
      query: 'roadmap',
    });
    expect(notionController.disconnect).toHaveBeenCalledTimes(1);
  });

  it('3. (ADR §d, snippet truncation) a long joined content is truncated to EXACTLY the first 300 characters for snippet, and title is bounded to <=80 characters and remains a genuine prefix of the joined text', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { service: rateLimitService } = createRateLimitServiceMock();

    const longText = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(20);
    expect(longText.length).toBeGreaterThan(1000);

    retrieve.mockImplementation((_workspaceId, _userId, connectorType) =>
      connectorType === 'github'
        ? Promise.resolve({ accessToken: 'token-github-xyz' })
        : Promise.resolve(undefined),
    );
    registerConnector('github', { callTool: () => Promise.resolve(textResult(longText)) });

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response = await service.searchExternal('ws-1', 'user-1', 'anything');

    expect(response.degraded).toEqual([]);
    const [result] = response.results as [ExternalSearchResult];
    expect(result.connectorType).toBe('github');
    // snippet: EXACT slice(0, 300) equality, mirroring SearchService's own
    // `(entry.docText ?? '').slice(0, 300)` contract (ADR-0027 §d).
    expect(result.snippet).toBe(longText.slice(0, 300));
    // title: bounded to ~80 chars and a genuine prefix -- deliberately NOT
    // asserted as an exact slice(0, 80) equality, since ADR-0027 §d leaves
    // the precise word-boundary behavior to implementer; this test only
    // pins the two properties the ADR text unambiguously commits to.
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(longText.startsWith(result.title)).toBe(true);
  });

  it('4. (ADR §d) joined content from MULTIPLE text blocks is joined with "\\n" before title/snippet are derived', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { service: rateLimitService } = createRateLimitServiceMock();

    retrieve.mockImplementation((_workspaceId, _userId, connectorType) =>
      connectorType === 'slack'
        ? Promise.resolve({ accessToken: 'token-slack-abc' })
        : Promise.resolve(undefined),
    );
    registerConnector('slack', {
      callTool: () =>
        Promise.resolve({
          content: [
            { type: 'text', text: 'First block' },
            { type: 'text', text: 'Second block' },
          ],
          isError: false,
        }),
    });

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response = await service.searchExternal('ws-1', 'user-1', 'anything');

    const [result] = response.results as [ExternalSearchResult];
    expect(result.snippet).toBe('First block\nSecond block');
  });

  it('5. (Kabul Kriteri: expired token) a connectorType whose stored credentials have an expiresAt in the past is skipped, lands in degraded, and callTool is NEVER invoked', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { assertNotRateLimited, service: rateLimitService } = createRateLimitServiceMock();

    retrieve.mockImplementation((_workspaceId, _userId, connectorType) =>
      connectorType === 'slack'
        ? Promise.resolve({ accessToken: 'token-slack-expired', expiresAt: pastIso() })
        : Promise.resolve(undefined),
    );
    const slackController = registerConnector('slack');

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response = await service.searchExternal('ws-1', 'user-1', 'anything');

    expect(response.results).toEqual([]);
    expect(response.degraded).toEqual(['slack']);
    expect(slackController.callTool).not.toHaveBeenCalled();
    expect(slackController.connect).not.toHaveBeenCalled();
    // Expiry is checked BEFORE the rate-limit step (ADR-0027 §e step order).
    expect(assertNotRateLimited).not.toHaveBeenCalledWith('ws-1', 'slack', expect.anything());
  });

  it('6. (Kabul Kriteri: oran sınırı) a connectorType whose rate limit is exceeded (QuotaExceededError) is skipped, lands in degraded, and the connector is NEVER constructed', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { assertNotRateLimited, service: rateLimitService } = createRateLimitServiceMock();

    retrieve.mockImplementation((_workspaceId, _userId, connectorType) =>
      connectorType === 'github'
        ? Promise.resolve({ accessToken: 'token-github-abc' })
        : Promise.resolve(undefined),
    );
    assertNotRateLimited.mockImplementation((_workspaceId, connectorType) => {
      if (connectorType === 'github') {
        return Promise.reject(
          new QuotaExceededError('rate limit exceeded', {
            workspaceId: 'ws-1',
            connectorType: 'github',
          }),
        );
      }
      return Promise.resolve(undefined);
    });

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response = await service.searchExternal('ws-1', 'user-1', 'anything');

    expect(response.results).toEqual([]);
    expect(response.degraded).toEqual(['github']);
    expect(connectorClassMockFor('github')).not.toHaveBeenCalled();
  });

  it('7. (Kabul Kriteri: Promise.allSettled izolasyonu) one of several connected connectorTypes fails/times out -- the OTHERS still surface results, run concurrently rather than sequentially', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { service: rateLimitService } = createRateLimitServiceMock();

    retrieve.mockImplementation((_workspaceId, _userId, connectorType) => {
      if (connectorType === 'notion' || connectorType === 'gmail') {
        return Promise.resolve({ accessToken: `token-${connectorType}` });
      }
      return Promise.resolve(undefined);
    });

    const DELAY_MS = 80;
    registerConnector('notion', {
      callTool: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(textResult('Notion is healthy'));
          }, DELAY_MS);
        }),
    });
    const gmailController = registerConnector('gmail', {
      callTool: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('simulated network timeout'));
          }, DELAY_MS);
        }),
    });

    const service = new ConnectedSearchService(credentialsService, rateLimitService);

    const start = Date.now();
    const response = await service.searchExternal('ws-1', 'user-1', 'anything');
    const elapsedMs = Date.now() - start;

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.connectorType).toBe('notion');
    expect(response.degraded).toEqual(['gmail']);
    expect(gmailController.disconnect).toHaveBeenCalledTimes(1);

    // If the two connectorTypes ran sequentially this would take >= 2 *
    // DELAY_MS; a generous bound well under that proves genuine
    // concurrency (Promise.allSettled), not sequential await-in-a-loop.
    expect(elapsedMs).toBeLessThan(DELAY_MS * 2);
  }, 5_000);

  it("8. (cross-user/cross-workspace isolation, security-critical) credentials.retrieve is ALWAYS called with the exact (workspaceId, userId) passed into searchExternal -- a search for user A never triggers a retrieve call with user B's id, and A's results never leak B's data", async () => {
    const WORKSPACE_A = 'ws-aaaa';
    const USER_A = 'user-aaaa';
    const WORKSPACE_B = 'ws-bbbb';
    const USER_B = 'user-bbbb';

    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { service: rateLimitService } = createRateLimitServiceMock();

    const retrieveCalls: Array<{ workspaceId: string; userId: string; connectorType: string }> = [];
    retrieve.mockImplementation((workspaceId, userId, connectorType) => {
      retrieveCalls.push({ workspaceId, userId, connectorType });
      if (workspaceId === WORKSPACE_A && userId === USER_A && connectorType === 'notion') {
        return Promise.resolve({ accessToken: 'token-belongs-to-A' });
      }
      if (workspaceId === WORKSPACE_B && userId === USER_B && connectorType === 'notion') {
        return Promise.resolve({ accessToken: 'token-belongs-to-B' });
      }
      return Promise.resolve(undefined);
    });
    registerConnector('notion', {
      callTool: () => Promise.resolve(textResult('shared fixture text')),
    });

    const service = new ConnectedSearchService(credentialsService, rateLimitService);

    await service.searchExternal(WORKSPACE_A, USER_A, 'query-a');
    const callsDuringA = [...retrieveCalls];
    expect(
      callsDuringA.every((call) => call.workspaceId === WORKSPACE_A && call.userId === USER_A),
    ).toBe(true);
    expect(
      callsDuringA.some((call) => call.workspaceId === WORKSPACE_B || call.userId === USER_B),
    ).toBe(false);

    retrieveCalls.length = 0;
    await service.searchExternal(WORKSPACE_B, USER_B, 'query-b');
    expect(
      retrieveCalls.every((call) => call.workspaceId === WORKSPACE_B && call.userId === USER_B),
    ).toBe(true);
    expect(
      retrieveCalls.some((call) => call.workspaceId === WORKSPACE_A || call.userId === USER_A),
    ).toBe(false);

    // The per-call connector construction must be fed the CORRECT
    // per-user token -- proving no cross-user token bleed into the
    // freshly-built connector instance (ADR-0027 §a).
    const notionCalls = connectorClassMockFor('notion').mock.calls as Array<
      [{ getAccessToken: () => Promise<string> }]
    >;
    expect(notionCalls).toHaveLength(2);
    await expect(notionCalls[0]?.[0].getAccessToken()).resolves.toBe('token-belongs-to-A');
    await expect(notionCalls[1]?.[0].getAccessToken()).resolves.toBe('token-belongs-to-B');
  });

  it('9. (cleanup guarantee) disconnect() is called even when callTool() throws', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { service: rateLimitService } = createRateLimitServiceMock();

    retrieve.mockImplementation((_workspaceId, _userId, connectorType) =>
      connectorType === 'google-drive'
        ? Promise.resolve({ accessToken: 'token-drive-abc' })
        : Promise.resolve(undefined),
    );
    const driveController = registerConnector('google-drive', {
      callTool: () => Promise.reject(new Error('simulated connector callTool failure')),
    });

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response = await service.searchExternal('ws-1', 'user-1', 'anything');

    expect(response.results).toEqual([]);
    expect(response.degraded).toEqual(['google-drive']);
    expect(driveController.connect).toHaveBeenCalledTimes(1);
    expect(driveController.callTool).toHaveBeenCalledTimes(1);
    expect(driveController.disconnect).toHaveBeenCalledTimes(1);
  });

  it('10. every connectorType is checked -- 5 connected connectorTypes with independent credentials each produce their own ExternalSearchResult, tagged with the correct connectorType', async () => {
    const { retrieve, service: credentialsService } = createCredentialsServiceMock();
    const { service: rateLimitService } = createRateLimitServiceMock();

    retrieve.mockImplementation((_workspaceId, _userId, connectorType) =>
      Promise.resolve({ accessToken: `token-${connectorType}` }),
    );

    for (const connectorType of ALL_CONNECTOR_TYPES) {
      registerConnector(connectorType, {
        callTool: () => Promise.resolve(textResult(`${connectorType} fixture content`)),
      });
    }

    const service = new ConnectedSearchService(credentialsService, rateLimitService);
    const response = await service.searchExternal('ws-1', 'user-1', 'anything');

    expect(response.degraded).toEqual([]);
    expect(response.results).toHaveLength(5);
    const resultConnectorTypes = response.results.map((result) => result.connectorType).sort();
    expect(resultConnectorTypes).toEqual([...ALL_CONNECTOR_TYPES].sort());

    for (const connectorType of ALL_CONNECTOR_TYPES) {
      const match = response.results.find((result) => result.connectorType === connectorType);
      expect(match?.title).toBe(`${connectorType} fixture content`);
      expect(connectorClassMockFor(connectorType)).toHaveBeenCalledTimes(1);
    }
  });
});
