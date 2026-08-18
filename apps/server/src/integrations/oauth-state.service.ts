import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';

import { ForbiddenError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { oauthStateTokens } from '../db/schema/oauth-state-tokens.js';

import type { Database } from '../db/client.js';

/** 10 minutes -- ADR-0026 §i's chosen TTL. */
const STATE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Never mentions "expired"/"not found" -- deliberately identical for every
 * failure branch of `consume` (never-issued, already-consumed, expired), so
 * a caller (and any attacker probing the endpoint) cannot distinguish WHICH
 * failure occurred, standard CSRF-token-verification discipline (ADR-0026
 * §i). */
const INVALID_STATE_MESSAGE = 'OAuth state token is invalid.';

/**
 * F2-T10 PR1 (ADR-0026 §i): DB-backed, single-use OAuth `state`/CSRF tokens
 * for the MCP connector authorize->callback flow. `state` is an opaque,
 * unsigned `base64url(randomBytes(32))` value -- correlation to
 * (workspaceId, userId, connectorType) happens ONLY via the
 * `oauth_state_tokens` row, never encoded into the token itself.
 */
@Injectable()
export class OAuthStateService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async issue(workspaceId: string, userId: string, connectorType: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + STATE_TOKEN_TTL_MS);

    await this.db.insert(oauthStateTokens).values({
      state,
      workspaceId,
      userId,
      connectorType,
      expiresAt,
    });

    return state;
  }

  /**
   * Single-use: atomically deletes the matching, NOT-YET-EXPIRED row and
   * returns it in one `DELETE ... WHERE state = $1 AND expires_at > now()
   * RETURNING *` statement -- no `pg_advisory_lock` needed (a concurrent
   * double-consume is already meaningless; the second attempt simply finds
   * nothing, ADR-0026 §i). An EXPIRED row is deliberately left untouched (no
   * proactive cleanup, ADR-0026 §i) -- the `expires_at > now()` predicate in
   * the `WHERE` clause means the `DELETE` affects zero rows for an expired
   * token, rather than deleting-then-rejecting it.
   */
  async consume(
    state: string,
  ): Promise<{ workspaceId: string; userId: string; connectorType: string }> {
    const [row] = await this.db
      .delete(oauthStateTokens)
      .where(and(eq(oauthStateTokens.state, state), gt(oauthStateTokens.expiresAt, new Date())))
      .returning();

    if (!row) {
      throw new ForbiddenError(INVALID_STATE_MESSAGE);
    }

    return {
      workspaceId: row.workspaceId,
      userId: row.userId,
      connectorType: row.connectorType,
    };
  }
}
