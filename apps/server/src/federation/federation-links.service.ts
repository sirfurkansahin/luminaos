import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';

import {
  ConflictError,
  ForbiddenError,
  InvalidObjectStateError,
  ValidationError,
} from '@luminaos/shared';

import { canTransition, computePairKey } from './federation-link-state.js';
import { hasPostgresConstraintViolation } from '../common/postgres-error.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { federationLinks } from '../db/schema/federation-links.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { FederationLinkStatus } from './federation-link-state.js';
import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

export type FederationLink = typeof federationLinks.$inferSelect;

/**
 * F3-T14 PR1 (ADR-0048 §b/§c): CRUD-style (not event-sourced -- the ADR's
 * own code draft models `federation_links` as a plain Drizzle table, no
 * event stream of its own) service for the `FederationLink` state machine.
 * `initiate`/`accept`/`revoke` delegate the actual pending/active/revoked
 * legality check to the pure `canTransition` helper -- this class only
 * handles RBAC, the `pairKey` uniqueness conflict, and persistence.
 */
@Injectable()
export class FederationLinksService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async initiate(
    initiatorWorkspaceId: string,
    counterpartWorkspaceId: string,
    actorUserId: string,
    actorRole: MembershipRole,
  ): Promise<FederationLink> {
    if (!hasAtLeastRole(actorRole, 'admin')) {
      throw new ForbiddenError();
    }

    if (initiatorWorkspaceId === counterpartWorkspaceId) {
      throw new ValidationError('A workspace cannot federate with itself.');
    }

    const pairKey = computePairKey(initiatorWorkspaceId, counterpartWorkspaceId);

    const [existingActivePair] = await this.db
      .select({ id: federationLinks.id })
      .from(federationLinks)
      .where(and(eq(federationLinks.pairKey, pairKey), ne(federationLinks.status, 'revoked')))
      .limit(1);

    if (existingActivePair) {
      throw new ConflictError(
        'A pending or active federation link already exists between these two workspaces.',
      );
    }

    let row: FederationLink | undefined;
    try {
      [row] = await this.db
        .insert(federationLinks)
        .values({
          initiatorWorkspaceId,
          counterpartWorkspaceId,
          pairKey,
          initiatedByUserId: actorUserId,
        })
        .returning();
    } catch (error) {
      // The SELECT above is a best-effort pre-check, not a lock -- a
      // concurrent initiate() for the same pair can still race past it.
      // The partial unique index (`federation_links_pair_key_active_key`)
      // is the actual source of truth for the invariant; this maps its
      // violation onto the same ConflictError the pre-check throws
      // (security-reviewer finding, PR1: previously an unhandled 500).
      if (hasPostgresConstraintViolation(error, 'federation_links_pair_key_active_key')) {
        throw new ConflictError(
          'A pending or active federation link already exists between these two workspaces.',
        );
      }
      throw error;
    }

    if (!row) {
      throw new ConflictError('Failed to create federation link.');
    }

    return row;
  }

  async accept(
    linkId: string,
    actorUserId: string,
    actorRole: MembershipRole,
  ): Promise<FederationLink> {
    if (!hasAtLeastRole(actorRole, 'admin')) {
      throw new ForbiddenError();
    }

    const link = await this.getOrThrow(linkId);

    if (actorUserId === link.initiatedByUserId) {
      throw new ForbiddenError('The initiator cannot accept their own federation link proposal.');
    }

    this.assertTransition(link.status, 'active');

    const [row] = await this.db
      .update(federationLinks)
      .set({ status: 'active', acceptedByUserId: actorUserId, acceptedAt: new Date() })
      .where(eq(federationLinks.id, linkId))
      .returning();

    if (!row) {
      throw new InvalidObjectStateError('Failed to accept federation link.');
    }

    return row;
  }

  async revoke(
    linkId: string,
    actorUserId: string,
    actorRole: MembershipRole,
  ): Promise<FederationLink> {
    if (!hasAtLeastRole(actorRole, 'admin')) {
      throw new ForbiddenError();
    }

    const link = await this.getOrThrow(linkId);
    this.assertTransition(link.status, 'revoked');

    const [row] = await this.db
      .update(federationLinks)
      .set({ status: 'revoked', revokedByUserId: actorUserId, revokedAt: new Date() })
      .where(eq(federationLinks.id, linkId))
      .returning();

    if (!row) {
      throw new InvalidObjectStateError('Failed to revoke federation link.');
    }

    return row;
  }

  private assertTransition(from: FederationLinkStatus, to: FederationLinkStatus): void {
    if (!canTransition(from, to)) {
      throw new InvalidObjectStateError(
        `Cannot transition a federation link from "${from}" to "${to}".`,
      );
    }
  }

  private async getOrThrow(linkId: string): Promise<FederationLink> {
    const [row] = await this.db
      .select()
      .from(federationLinks)
      .where(eq(federationLinks.id, linkId))
      .limit(1);

    if (!row) {
      throw new InvalidObjectStateError('Federation link not found.');
    }

    return row;
  }
}
