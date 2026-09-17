import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { ForbiddenError, NotFoundError, ValidationError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { federationLinks } from '../db/schema/federation-links.js';
import { federationScopeObjects } from '../db/schema/federation-scope-objects.js';
import { objectsView } from '../db/schema/objects-view.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

export type FederationScopeObject = typeof federationScopeObjects.$inferSelect;

/**
 * F3-T14 PR1 (ADR-0048 §e): tek-tek, kasıtlı opt-in allowlist management for
 * a `FederationLink`'s shared object scope. `removeObject` tombstones
 * (`removedAt`), never hard-deletes -- mirrors `mcp_client_grants`/
 * `MemoryAccessPolicy`'s revoke convention. A re-`addObject` after a
 * tombstone produces a brand-new row (the partial-unique index on
 * `(federationLinkId, objectId) WHERE removedAt IS NULL` permits this).
 */
@Injectable()
export class FederationScopeService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async addObject(
    linkId: string,
    objectId: string,
    ownerWorkspaceId: string,
    actorUserId: string,
    actorRole: MembershipRole,
  ): Promise<FederationScopeObject> {
    const link = await this.getLinkOrThrow(linkId);

    if (
      ownerWorkspaceId !== link.initiatorWorkspaceId &&
      ownerWorkspaceId !== link.counterpartWorkspaceId
    ) {
      throw new ValidationError(
        'ownerWorkspaceId must be one of the two workspaces on this federation link.',
      );
    }

    if (!hasAtLeastRole(actorRole, 'admin')) {
      throw new ForbiddenError();
    }

    await this.assertObjectExists(ownerWorkspaceId, objectId);

    const [row] = await this.db
      .insert(federationScopeObjects)
      .values({
        federationLinkId: linkId,
        objectId,
        ownerWorkspaceId,
        addedByUserId: actorUserId,
      })
      .returning();

    if (!row) {
      throw new NotFoundError('Failed to add object to federation scope.');
    }

    return row;
  }

  async removeObject(
    linkId: string,
    objectId: string,
    actorRole: MembershipRole,
  ): Promise<FederationScopeObject> {
    if (!hasAtLeastRole(actorRole, 'admin')) {
      throw new ForbiddenError();
    }

    const [row] = await this.db
      .update(federationScopeObjects)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(federationScopeObjects.federationLinkId, linkId),
          eq(federationScopeObjects.objectId, objectId),
          isNull(federationScopeObjects.removedAt),
        ),
      )
      .returning();

    if (!row) {
      throw new NotFoundError('Active federation scope object not found.');
    }

    return row;
  }

  /**
   * Fail-closed scope check used by `FederationMcpController` (PR2) -- NOT
   * exercised by this PR's own tests, but included here since it depends
   * only on this table.
   */
  async isActiveScopeObject(linkId: string, objectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: federationScopeObjects.id })
      .from(federationScopeObjects)
      .where(
        and(
          eq(federationScopeObjects.federationLinkId, linkId),
          eq(federationScopeObjects.objectId, objectId),
          isNull(federationScopeObjects.removedAt),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  private async getLinkOrThrow(linkId: string): Promise<typeof federationLinks.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(federationLinks)
      .where(eq(federationLinks.id, linkId))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Federation link not found.');
    }

    return row;
  }

  /**
   * Mirrors `RelationsService.assertObjectExists`'s exact
   * existence-plus-workspace-scope query shape (Bağlam madde 4).
   */
  private async assertObjectExists(workspaceId: string, objectId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: objectsView.id })
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Lumina Object not found');
    }
  }
}
