import { z } from 'zod';

import { NotFoundError } from '@luminaos/shared';

import { StreamableHttpMcpConnector } from '../streamable-http-mcp-connector.js';

import type { ZodType } from 'zod';

/** Gmail's MCP tool/resource result shapes (ADR-0026 §h), mirroring
 * `notion-mcp-connector.ts`'s pattern. Validates the RAW `raw.content`/
 * `raw.contents[0]` value `StreamableHttpMcpConnector`'s pinned
 * `callTool`/`readResource` bodies pass into `parseOrThrow` — an array of MCP
 * content blocks (`{type:'text', text: string}` etc.), not an
 * application-level shape. */
const TOOL_RESULT_SCHEMAS: Record<string, ZodType> = {
  'gmail-search-threads': z.array(z.object({ type: z.literal('text'), text: z.string() })),
  'gmail-broken': z.array(z.object({ type: z.literal('image'), data: z.string() })),
};

const RESOURCE_CONTENT_SCHEMAS: Record<string, ZodType> = {
  'gmail://thread/fixture-thread-id': z.object({
    uri: z.string(),
    text: z.string(),
    mimeType: z.string().optional(),
  }),
};

/**
 * `StreamableHttpMcpConnector` subclass for Gmail's MCP server
 * (`https://gmailmcp.googleapis.com/mcp/v1`, ADR-0026 §e). Mechanical repeat
 * of `NotionMcpConnector`'s pattern (ADR-0026 §d/§h).
 */
export class GmailMcpConnector extends StreamableHttpMcpConnector {
  protected getToolResultSchema(toolName: string): ZodType {
    const schema = TOOL_RESULT_SCHEMAS[toolName];
    if (!schema) {
      throw new NotFoundError(`Unknown tool "${toolName}" for connector "gmail"`);
    }
    return schema;
  }

  protected getResourceContentSchema(uri: string): ZodType {
    const schema = RESOURCE_CONTENT_SCHEMAS[uri];
    if (!schema) {
      throw new NotFoundError(`Unknown resource "${uri}" for connector "gmail"`);
    }
    return schema;
  }
}
