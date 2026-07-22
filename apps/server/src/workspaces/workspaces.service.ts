import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { ConflictError, slugify } from '@luminaos/shared';

import { hasPostgresErrorCode } from '../common/postgres-error.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { memberships } from '../db/schema/memberships.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/** Postgres error code for a unique-constraint violation. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

export interface WorkspaceResult {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Creates a workspace and its owner's membership row atomically: a
   * workspace must never exist without its creator's `owner` membership, so
   * both inserts happen in a single transaction (both succeed or both
   * fail/roll back together).
   */
  async createWorkspace(name: string, ownerId: string): Promise<WorkspaceResult> {
    const slug = slugify(name);

    try {
      return await this.db.transaction(async (tx) => {
        const [workspace] = await tx.insert(workspaces).values({ name, slug }).returning({
          id: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          createdAt: workspaces.createdAt,
        });

        if (!workspace) {
          throw new ConflictError('Failed to create workspace: insert returned no row.');
        }

        await tx.insert(memberships).values({
          workspaceId: workspace.id,
          userId: ownerId,
          role: 'owner',
        });

        return workspace;
      });
    } catch (error) {
      if (hasPostgresErrorCode(error, POSTGRES_UNIQUE_VIOLATION)) {
        throw new ConflictError('A workspace with a conflicting slug already exists.');
      }
      throw error;
    }
  }

  async getWorkspaceById(workspaceId: string): Promise<WorkspaceResult | null> {
    const [workspace] = await this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        createdAt: workspaces.createdAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    return workspace ?? null;
  }
}
