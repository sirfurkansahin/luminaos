import { z } from 'zod';

import { NotFoundError } from '@luminaos/shared';

import { StreamableHttpMcpConnector } from '../streamable-http-mcp-connector.js';

import type { ZodType } from 'zod';

/** GitHub's MCP tool/resource result shapes (ADR-0026 §h), mirroring
 * `notion-mcp-connector.ts`'s pattern. Validates the RAW `raw.content`/
 * `raw.contents[0]` value `StreamableHttpMcpConnector`'s pinned
 * `callTool`/`readResource` bodies pass into `parseOrThrow` — an array of MCP
 * content blocks (`{type:'text', text: string}` etc.), not an
 * application-level shape. */
const TOOL_RESULT_SCHEMAS: Record<string, ZodType> = {
  'github-search-issues': z.array(z.object({ type: z.literal('text'), text: z.string() })),
  'github-broken': z.array(z.object({ type: z.literal('image'), data: z.string() })),
};

const RESOURCE_CONTENT_SCHEMAS: Record<string, ZodType> = {
  'github://repo/fixture-owner/fixture-repo': z.object({
    uri: z.string(),
    text: z.string(),
    mimeType: z.string().optional(),
  }),
};

/**
 * `StreamableHttpMcpConnector` subclass for GitHub's official MCP server
 * (`https://api.githubcopilot.com/mcp/`, ADR-0026 §e). Mechanical repeat of
 * `NotionMcpConnector`'s pattern (ADR-0026 §d/§h).
 */
export class GithubMcpConnector extends StreamableHttpMcpConnector {
  protected getToolResultSchema(toolName: string): ZodType {
    const schema = TOOL_RESULT_SCHEMAS[toolName];
    if (!schema) {
      throw new NotFoundError(`Unknown tool "${toolName}" for connector "github"`);
    }
    return schema;
  }

  protected getResourceContentSchema(uri: string): ZodType {
    const schema = RESOURCE_CONTENT_SCHEMAS[uri];
    if (!schema) {
      throw new NotFoundError(`Unknown resource "${uri}" for connector "github"`);
    }
    return schema;
  }
}
