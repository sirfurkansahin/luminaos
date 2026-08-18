import { z } from 'zod';

import { NotFoundError } from '@luminaos/shared';

import { StreamableHttpMcpConnector } from '../streamable-http-mcp-connector.js';

import type { ZodType } from 'zod';

/** Notion's real MCP tool/resource result shapes (ADR-0026 §h). Validates
 * the RAW `raw.content`/`raw.contents[0]` value `StreamableHttpMcpConnector`'s
 * pinned `callTool`/`readResource` bodies pass into `parseOrThrow` — an
 * array of MCP content blocks (`{type:'text', text: string}` etc.), not an
 * application-level shape. */
const TOOL_RESULT_SCHEMAS: Record<string, ZodType> = {
  'notion-search': z.array(z.object({ type: z.literal('text'), text: z.string() })),
  'notion-broken': z.array(z.object({ type: z.literal('image'), data: z.string() })),
};

const RESOURCE_CONTENT_SCHEMAS: Record<string, ZodType> = {
  'notion://workspace': z.object({
    uri: z.string(),
    text: z.string(),
    mimeType: z.string().optional(),
  }),
};

/**
 * Reference/first-proven `StreamableHttpMcpConnector` subclass — connects to
 * Notion's official, self-serve MCP server (`https://mcp.notion.com`).
 * See ADR-0026 §e/§h.
 */
export class NotionMcpConnector extends StreamableHttpMcpConnector {
  protected getToolResultSchema(toolName: string): ZodType {
    const schema = TOOL_RESULT_SCHEMAS[toolName];
    if (!schema) {
      throw new NotFoundError(`Unknown tool "${toolName}" for connector "notion"`);
    }
    return schema;
  }

  protected getResourceContentSchema(uri: string): ZodType {
    const schema = RESOURCE_CONTENT_SCHEMAS[uri];
    if (!schema) {
      throw new NotFoundError(`Unknown resource "${uri}" for connector "notion"`);
    }
    return schema;
  }
}
