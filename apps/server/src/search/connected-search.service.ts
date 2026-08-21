import { Injectable } from '@nestjs/common';

import {
  GithubMcpConnector,
  GmailMcpConnector,
  GoogleDriveMcpConnector,
  MCP_CONNECTOR_SERVER_URLS,
  NotionMcpConnector,
  SlackMcpConnector,
} from '@luminaos/integrations';
import type { McpConnector } from '@luminaos/integrations';

/**
 * TYPE-ONLY imports (ADR-0027 §a). `../integrations/connector-credentials.service.js`
 * transitively imports `../config/env.js`, which eagerly evaluates
 * `readEnv()` (and fails the process if `DATABASE_URL`/`REDIS_URL` are
 * unset) at MODULE-LOAD time -- a real (value) import here would make even
 * this file's plain, no-I/O unit test (`./connected-search.service.test.ts`)
 * crash the whole worker process just by statically resolving this module.
 * `mcp-oauth.controller.ts` is the one other consumer of
 * `ConnectorCredentialsService` and is deliberately covered ONLY by an
 * integration test (which sets `DATABASE_URL` via Testcontainers) for the
 * exact same reason. Real class references (needed as Nest DI tokens) live
 * in `./search.module.ts`'s explicit `useFactory`/`inject` wiring instead --
 * `search.module.ts` is never statically imported by a plain unit test.
 */
import type { ConnectorCredentialsService } from '../integrations/connector-credentials.service.js';
import type { ConnectorRateLimitService } from '../integrations/connector-rate-limit.service.js';

/** ADR-0027 §a: the 5 connectorTypes this service knows how to search. */
const KNOWN_CONNECTOR_TYPES = ['notion', 'google-drive', 'gmail', 'slack', 'github'] as const;
type KnownConnectorType = (typeof KNOWN_CONNECTOR_TYPES)[number];

/** ADR-0027 §a's pinned connectorType -> search-tool-name map. */
const SEARCH_TOOL_NAMES: Record<KnownConnectorType, string> = {
  notion: 'notion-search',
  'google-drive': 'drive-search',
  gmail: 'gmail-search-threads',
  slack: 'slack-search-messages',
  github: 'github-search-issues',
};

/** ADR-0027 §e point 5: same 2000ms default as `ConnectorHealthService`. */
const DEFAULT_TIMEOUT_MS = 2000;

/** ADR-0027 §d: same truncation length as `SearchService`'s own `snippet`. */
const SNIPPET_MAX_LENGTH = 300;
/** ADR-0027 §d: title is bounded to roughly the first ~80 characters. */
const TITLE_MAX_LENGTH = 80;

export interface ExternalSearchResult {
  connectorType: string;
  title: string;
  snippet: string;
}

export interface ConnectedSearchResponse {
  results: ExternalSearchResult[];
  /** connectorTypes skipped due to an expired token, an exceeded rate
   * limit, or a call error/timeout -- NOT connectorTypes the caller was
   * simply never connected to (ADR-0027 §e point 1). */
  degraded: string[];
}

interface StoredConnectorCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/**
 * Own copy of `ConnectorHealthService`'s `withTimeout` helper (not exported
 * from there, same reasoning as that file's own header comment).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs.toString()}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * F2-T11 (ADR-0027 §a/§d/§e): per-call, per-user MCP connector search
 * orchestration. Deliberately bypasses `McpConnectorRegistry` entirely --
 * every call builds a FRESH concrete connector instance fed with a real
 * per-user token read from `ConnectorCredentialsService`, per ADR-0026 §m's
 * explicitly-left gap.
 */
@Injectable()
export class ConnectedSearchService {
  constructor(
    private readonly credentials: ConnectorCredentialsService,
    private readonly rateLimit: ConnectorRateLimitService,
  ) {}

  async searchExternal(
    workspaceId: string,
    userId: string,
    query: string,
  ): Promise<ConnectedSearchResponse> {
    const degraded: string[] = [];

    const settled = await Promise.allSettled(
      KNOWN_CONNECTOR_TYPES.map(
        async (connectorType): Promise<ExternalSearchResult | undefined> => {
          const stored = await this.credentials.retrieve(workspaceId, userId, connectorType);
          if (stored === undefined) {
            // Never connected -- silently skip, never lands in `degraded`
            // (ADR-0027 §e point 1).
            return undefined;
          }

          const storedCredentials = stored as unknown as StoredConnectorCredentials;

          if (
            storedCredentials.expiresAt !== undefined &&
            new Date(storedCredentials.expiresAt) <= new Date()
          ) {
            degraded.push(connectorType);
            return undefined;
          }

          try {
            await this.rateLimit.assertNotRateLimited(workspaceId, connectorType, 1);
          } catch {
            degraded.push(connectorType);
            return undefined;
          }

          try {
            const connector = this.buildConnector(connectorType, storedCredentials.accessToken);
            return await withTimeout(
              this.runSearch(connector, connectorType, query),
              DEFAULT_TIMEOUT_MS,
            );
          } catch {
            degraded.push(connectorType);
            return undefined;
          }
        },
      ),
    );

    const results: ExternalSearchResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value !== undefined) {
        results.push(outcome.value);
      }
    }

    return { results, degraded };
  }

  private async runSearch(
    connector: McpConnector,
    connectorType: KnownConnectorType,
    query: string,
  ): Promise<ExternalSearchResult> {
    try {
      await connector.connect();
      const toolResult = await connector.callTool(SEARCH_TOOL_NAMES[connectorType], { query });
      const contentBlocks = Array.isArray(toolResult.content)
        ? (toolResult.content as Array<{ type?: string; text?: string }>)
        : [];
      const joinedText = contentBlocks
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('\n');

      return {
        connectorType,
        title: joinedText.slice(0, TITLE_MAX_LENGTH),
        snippet: joinedText.slice(0, SNIPPET_MAX_LENGTH),
      };
    } finally {
      await connector.disconnect();
    }
  }

  /** connectorType -> concrete-class switch; every call gets a TAZE instance. */
  private buildConnector(connectorType: KnownConnectorType, accessToken: string): McpConnector {
    const getAccessToken = (): Promise<string> => Promise.resolve(accessToken);

    switch (connectorType) {
      case 'notion':
        return new NotionMcpConnector({
          connectorType: 'notion',
          serverUrl: MCP_CONNECTOR_SERVER_URLS.notion,
          getAccessToken,
        });
      case 'google-drive':
        return new GoogleDriveMcpConnector({
          connectorType: 'google-drive',
          serverUrl: MCP_CONNECTOR_SERVER_URLS['google-drive'],
          getAccessToken,
        });
      case 'gmail':
        return new GmailMcpConnector({
          connectorType: 'gmail',
          serverUrl: MCP_CONNECTOR_SERVER_URLS.gmail,
          getAccessToken,
        });
      case 'slack':
        return new SlackMcpConnector({
          connectorType: 'slack',
          serverUrl: MCP_CONNECTOR_SERVER_URLS.slack,
          getAccessToken,
        });
      case 'github':
        return new GithubMcpConnector({
          connectorType: 'github',
          serverUrl: MCP_CONNECTOR_SERVER_URLS.github,
          getAccessToken,
        });
    }
  }
}
