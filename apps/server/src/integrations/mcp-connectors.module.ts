import { Module } from '@nestjs/common';

import { McpConnectorRegistry, NotionMcpConnector } from '@luminaos/integrations';
import type { McpConnector } from '@luminaos/integrations';
import { InvalidObjectStateError } from '@luminaos/shared';

import { env } from '../config/env.js';


export const MCP_CONNECTOR_REGISTRY = 'MCP_CONNECTOR_REGISTRY';
export const NOTION_MCP_CONNECTOR = 'NOTION_MCP_CONNECTOR';

/**
 * F2-T10 PR1 (ADR-0026 §m): the env-gated DI-factory pattern registering
 * REAL `McpConnector` implementations into a shared `McpConnectorRegistry`,
 * mirroring `../calendar/calendar-connector.module.ts`'s `useFactory`
 * pattern with a per-connector-type DI token.
 *
 * Registry membership here means "this connectorType is APPLICATION-LEVEL
 * configured" -- it does NOT mean "a live, per-user session exists" (Karar
 * m's central tension). The registered instance's `getAccessToken` callback
 * deliberately THROWS `InvalidObjectStateError` if ever invoked -- `connect()`
 * is the one public method that calls it, and `connect()` is NEVER called on
 * this shared, no-particular-user instance on any production code path in
 * this task (only test code, bypassing DI, exercises `connect()` directly
 * against a real per-user token). F2-T11 (Connected Search) must build its
 * OWN, per-call, per-user connector instance from
 * `ConnectorCredentialsService.retrieve(...)` instead of resolving this
 * token (ADR-0026 §m).
 */
@Module({
  providers: [
    {
      provide: MCP_CONNECTOR_REGISTRY,
      useValue: new McpConnectorRegistry(),
    },
    {
      provide: NOTION_MCP_CONNECTOR,
      inject: [MCP_CONNECTOR_REGISTRY],
      useFactory: (registry: McpConnectorRegistry): McpConnector | undefined => {
        if (!env.notionOAuth) {
          return undefined;
        }

        const connector = new NotionMcpConnector({
          connectorType: 'notion',
          serverUrl: 'https://mcp.notion.com',
          getAccessToken: () => {
            throw new InvalidObjectStateError(
              'The shared "notion" registry connector does not support establishing a per-user session (F2-T11 scope) -- callers must build a fresh, per-call connector instance from a real user token instead.',
            );
          },
        });

        registry.register(connector);
        return connector;
      },
    },
  ],
  exports: [MCP_CONNECTOR_REGISTRY, NOTION_MCP_CONNECTOR],
})
export class McpConnectorsModule {}
