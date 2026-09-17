import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { ForbiddenError, NotFoundError, ValidationError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { federationLinkCredentials } from '../db/schema/federation-link-credentials.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ALLOWED_EXPIRES_AT_DAYS = new Set<number>([30, 90, 365]);
const DEFAULT_EXPIRES_AT_DAYS = 90;

export type FederationLinkCredential = typeof federationLinkCredentials.$inferSelect;

/**
 * F3-T14 PR1 (ADR-0048 §d, İNSAN ONAYLI): a 1:1 clone of
 * `McpClientGrantsService`'s PAT generation/hash/prefix/revoke pattern
 * (ADR-0028 §a/§b/§l), keyed by `federationLinkId`+`granteeWorkspaceId`
 * instead of `workspaceId`+`userId`. `expiresAtDays` accepts the SAME closed
 * 30/90/365-day union, default 90 -- "süresiz" is never offered (İnsan
 * kararı 4). The runtime check below (`ALLOWED_EXPIRES_AT_DAYS`) exists
 * BECAUSE the TS union alone cannot protect an untyped JSON request body at
 * a real HTTP boundary (PR2's REST controller).
 */
@Injectable()
export class FederationLinkCredentialsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async grant(
    linkId: string,
    granteeWorkspaceId: string,
    name: string,
    expiresAtDays: 30 | 90 | 365 | undefined,
    actorUserId: string,
    actorRole: MembershipRole,
  ): Promise<{ credential: FederationLinkCredential; rawToken: string }> {
    if (!hasAtLeastRole(actorRole, 'admin')) {
      throw new ForbiddenError();
    }

    const resolvedDays = expiresAtDays ?? DEFAULT_EXPIRES_AT_DAYS;
    if (!ALLOWED_EXPIRES_AT_DAYS.has(resolvedDays)) {
      throw new ValidationError(
        `expiresAtDays must be one of 30, 90, or 365 -- received ${String(resolvedDays)}.`,
      );
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const tokenPrefix = rawToken.slice(0, 12);
    const expiresAt = new Date(Date.now() + resolvedDays * MS_PER_DAY);

    const [row] = await this.db
      .insert(federationLinkCredentials)
      .values({
        federationLinkId: linkId,
        granteeWorkspaceId,
        name,
        tokenHash,
        tokenPrefix,
        createdByUserId: actorUserId,
        expiresAt,
      })
      .returning();

    if (!row) {
      throw new NotFoundError('Failed to create federation link credential.');
    }

    return { credential: row, rawToken };
  }

  /**
   * Scoped by `(linkId, granteeWorkspaceId)` in the `WHERE` clause itself --
   * mirrors `McpClientGrantsService.revoke`'s "acts as if the row doesn't
   * exist" discipline for a credential belonging to a different tenant.
   */
  async revoke(
    linkId: string,
    granteeWorkspaceId: string,
    credentialId: string,
  ): Promise<FederationLinkCredential> {
    const [row] = await this.db
      .update(federationLinkCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(federationLinkCredentials.id, credentialId),
          eq(federationLinkCredentials.federationLinkId, linkId),
          eq(federationLinkCredentials.granteeWorkspaceId, granteeWorkspaceId),
        ),
      )
      .returning();

    if (!row) {
      throw new NotFoundError('Federation link credential not found.');
    }

    return row;
  }
}
