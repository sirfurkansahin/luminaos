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

  /**
   * ADR-0048 §e: "kaldırılması da AYNI yetki gerektirir" -- removal requires
   * the SAME authority as `addObject` (the row's own `ownerWorkspaceId`'s
   * `admin+`), not merely "any admin of either side of the link". Without
   * this, an admin of the COUNTERPART workspace (or, before this fix, an
   * admin of any unrelated third workspace -- security-reviewer finding,
   * PR2) could tombstone an object the HOST never agreed to un-share.
   */
  async removeObject(
    linkId: string,
    objectId: string,
    ownerWorkspaceId: string,
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
          eq(federationScopeObjects.ownerWorkspaceId, ownerWorkspaceId),
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
   * Fail-closed scope check used by `FederationMcpController` (PR2). Scoped
   * by `ownerWorkspaceId === hostWorkspaceId` (not just `federationLinkId`),
   * matching `listActiveObjectIds`'s exact same invariant -- a bilateral
   * link can carry scope rows added by EITHER side, but only the HOST's own
   * additions are ever valid for a request this host is serving. Without
   * this, a scope row the grantee added in the reverse direction could
   * satisfy this check for the wrong host, letting a fail-closed host-side
   * audit event fire for an object this host never actually shared
   * (security-reviewer finding, PR2).
   */
  async isActiveScopeObject(
    linkId: string,
    hostWorkspaceId: string,
    objectId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: federationScopeObjects.id })
      .from(federationScopeObjects)
      .where(
        and(
          eq(federationScopeObjects.federationLinkId, linkId),
          eq(federationScopeObjects.ownerWorkspaceId, hostWorkspaceId),
          eq(federationScopeObjects.objectId, objectId),
          isNull(federationScopeObjects.removedAt),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * F3-T14 PR2 (ADR-0048 §g): all currently-active `objectId`s the HOST side
   * (`hostWorkspaceId`) has added to this link's scope -- used by
   * `filterFederatedContextGraph` to elide neighbor-entity nodes the host
   * never opted in to sharing. Deliberately scoped by `ownerWorkspaceId`
   * (not just `federationLinkId`) since a bilateral link can, in principle,
   * carry scope rows added by EITHER side; only the host's own additions are
   * ever relevant to a request this host is serving.
   */
  async listActiveObjectIds(linkId: string, hostWorkspaceId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ objectId: federationScopeObjects.objectId })
      .from(federationScopeObjects)
      .where(
        and(
          eq(federationScopeObjects.federationLinkId, linkId),
          eq(federationScopeObjects.ownerWorkspaceId, hostWorkspaceId),
          isNull(federationScopeObjects.removedAt),
        ),
      );

    return new Set(rows.map((row) => row.objectId));
  }

  /**
   * F3-T14 PR2 (REST surface, ADR-0016 §a): full active scope-object rows
   * for `FederationScopeController`'s `member+` list endpoint. `member+`
   * itself is never role-gated further (ADR-0016 §a), but the caller's
   * `workspaceId` MUST still be one of `linkId`'s two actual ends --
   * otherwise any member of a totally unrelated workspace could read a
   * foreign link's shared-object list by supplying its own `workspaceId`
   * (which passes `WorkspaceMembershipGuard`, which only checks membership,
   * not linkId association) alongside someone else's `linkId`
   * (security-reviewer finding, PR2).
   */
  async listActive(linkId: string, workspaceId: string): Promise<FederationScopeObject[]> {
    const link = await this.getLinkOrThrow(linkId);

    if (workspaceId !== link.initiatorWorkspaceId && workspaceId !== link.counterpartWorkspaceId) {
      throw new ForbiddenError();
    }

    return this.db
      .select()
      .from(federationScopeObjects)
      .where(
        and(
          eq(federationScopeObjects.federationLinkId, linkId),
          isNull(federationScopeObjects.removedAt),
        ),
      );
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
