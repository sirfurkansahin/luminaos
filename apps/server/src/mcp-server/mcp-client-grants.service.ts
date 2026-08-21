import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

import { NotFoundError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { mcpClientGrants } from '../db/schema/mcp-client-grants.js';

import type { Database } from '../db/client.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type McpClientGrant = typeof mcpClientGrants.$inferSelect;

/**
 * F2-T12 PR1 (ADR-0028 §a/§b/§l): CRUD + validation for `mcp_client_grants`
 * PAT rows. `crypto.randomBytes(32).toString('base64url')` for the raw
 * token (mirrors `OAuthStateService.issue`'s already-established pattern,
 * ADR-0028 §a), `sha256` hex digest persisted, raw token returned exactly
 * once (from `grant()`), never again. `expiresAt` is always computed
 * server-side from a fixed day-count (ADR-0028 §l) -- never accepted as a
 * client-supplied absolute date.
 */
@Injectable()
export class McpClientGrantsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async grant(
    workspaceId: string,
    userId: string,
    name: string,
    expiresAtDays: 30 | 90 | 365,
  ): Promise<{ grant: McpClientGrant; rawToken: string }> {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const tokenPrefix = rawToken.slice(0, 12);
    const expiresAt = new Date(Date.now() + expiresAtDays * MS_PER_DAY);

    const [row] = await this.db
      .insert(mcpClientGrants)
      .values({
        workspaceId,
        userId,
        name,
        tokenHash,
        tokenPrefix,
        expiresAt,
      })
      .returning();

    if (!row) {
      throw new NotFoundError('Failed to create MCP client grant.');
    }

    return { grant: row, rawToken };
  }

  /**
   * Scoped by (workspaceId, userId) IN THE `WHERE` CLAUSE itself -- a grant
   * belonging to a different tenant never matches, so `revoke` cannot be
   * tricked into revoking someone else's row even given its real `grantId`
   * (ADR-0028 §i's broader discipline of never distinguishing WHY a caller
   * is denied, applied here as "acts as if the row doesn't exist").
   */
  async revoke(workspaceId: string, userId: string, grantId: string): Promise<McpClientGrant> {
    const [row] = await this.db
      .update(mcpClientGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpClientGrants.id, grantId),
          eq(mcpClientGrants.workspaceId, workspaceId),
          eq(mcpClientGrants.userId, userId),
        ),
      )
      .returning();

    if (!row) {
      throw new NotFoundError('MCP client grant not found.');
    }

    return row;
  }

  async list(workspaceId: string, userId: string): Promise<McpClientGrant[]> {
    return this.db
      .select()
      .from(mcpClientGrants)
      .where(and(eq(mcpClientGrants.workspaceId, workspaceId), eq(mcpClientGrants.userId, userId)));
  }

  /**
   * Collapses "never issued" / "revoked" / "expired" into a single
   * `undefined` return -- ADR-0028 §i's discipline of never letting a
   * caller distinguish WHY a token failed to validate.
   */
  async validateToken(rawToken: string): Promise<{ grant: McpClientGrant } | undefined> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const now = new Date();

    const [row] = await this.db
      .select()
      .from(mcpClientGrants)
      .where(
        and(
          eq(mcpClientGrants.tokenHash, tokenHash),
          isNull(mcpClientGrants.revokedAt),
          or(isNull(mcpClientGrants.expiresAt), gt(mcpClientGrants.expiresAt, now)),
        ),
      )
      .limit(1);

    return row ? { grant: row } : undefined;
  }
}
