import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { FieldPermissions, ObjectType } from '@luminaos/core-objects';
import { ConflictError, slugify } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { hasPostgresErrorCode } from '../common/postgres-error.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { memberships } from '../db/schema/memberships.js';
import { workspaces } from '../db/schema/workspaces.js';
import { FieldDefinitionsService } from '../fields/field-definitions.service.js';

import type { Database } from '../db/client.js';
import type { DefineFieldDefinitionInput } from '../fields/field-definitions.service.js';

/** Postgres error code for a unique-constraint violation. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

/** F1-T10 PR1: every newly created workspace gets `status`/`priority`
 * `select` field definitions seeded for the `task` object type — see the
 * plan's PR1 section and `workspaces.integration.test.ts` for the exact
 * pinned option value/label/isDone contract. */
const TASK_OBJECT_TYPE: ObjectType = 'task';

/** Owner/admin/member can edit the seeded fields, guest is view-only — a
 * reasonable default for a workspace-wide status/priority field, not a
 * business rule pinned by any spec beyond "the fields exist and are
 * ordinary, mutable field definitions". */
const SEEDED_FIELD_PERMISSIONS: FieldPermissions = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'view',
};

/** Recorded as the actor on seeded field-definition events: this is a
 * system-initiated action triggered by workspace creation, not a specific
 * user's direct field-management action. */
const SEED_ACTOR: Actor = { type: 'system', id: 'workspace-creation-seed' };

export interface WorkspaceResult {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly fieldDefinitionsService: FieldDefinitionsService,
  ) {}

  /**
   * Creates a workspace and its owner's membership row atomically: a
   * workspace must never exist without its creator's `owner` membership, so
   * both inserts happen in a single transaction (both succeed or both
   * fail/roll back together).
   */
  async createWorkspace(name: string, ownerId: string): Promise<WorkspaceResult> {
    const slug = slugify(name);

    let workspace: WorkspaceResult;

    try {
      workspace = await this.db.transaction(async (tx) => {
        const [inserted] = await tx.insert(workspaces).values({ name, slug }).returning({
          id: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          createdAt: workspaces.createdAt,
        });

        if (!inserted) {
          throw new ConflictError('Failed to create workspace: insert returned no row.');
        }

        await tx.insert(memberships).values({
          workspaceId: inserted.id,
          userId: ownerId,
          role: 'owner',
        });

        return inserted;
      });
    } catch (error) {
      if (hasPostgresErrorCode(error, POSTGRES_UNIQUE_VIOLATION)) {
        throw new ConflictError('A workspace with a conflicting slug already exists.');
      }
      throw error;
    }

    await this.seedTaskFields(workspace.id);

    return workspace;
  }

  /**
   * Seeds `status`/`priority` `select` field definitions for the `task`
   * object type in a newly created workspace, per F1-T10 PR1's plan. Runs
   * AFTER the workspace+membership transaction has committed (a seeding
   * failure must never roll back a successful workspace creation).
   *
   * Idempotency is defensive, not load-bearing on the normal path: this
   * method is only ever invoked once per workspace (right after creation),
   * but if it were ever invoked twice for the same workspace, a
   * `ConflictError` from `FieldDefinitionsService.define()` (meaning a field
   * with this key already exists) is caught and swallowed rather than
   * propagated, so `POST /workspaces` never fails because of a seeding
   * race.
   */
  private async seedTaskFields(workspaceId: string): Promise<void> {
    await this.defineSeedField(workspaceId, {
      key: 'status',
      label: 'Status',
      fieldType: 'select',
      config: {
        options: [
          { value: 'todo', label: 'Yapılacak' },
          { value: 'doing', label: 'Sürüyor' },
          { value: 'done', label: 'Bitti', isDone: true },
        ],
      },
      permissions: SEEDED_FIELD_PERMISSIONS,
    });

    await this.defineSeedField(workspaceId, {
      key: 'priority',
      label: 'Priority',
      fieldType: 'select',
      config: {
        options: [
          { value: 'low', label: 'Düşük' },
          { value: 'medium', label: 'Orta' },
          { value: 'high', label: 'Yüksek' },
          { value: 'urgent', label: 'Acil' },
        ],
      },
      permissions: SEEDED_FIELD_PERMISSIONS,
    });

    // F1-T10 PR5 (spec item 5): `remindAt`/`remindAcknowledged` reuse this
    // same Custom Fields seeding mechanism — no new query-layer/command/event
    // code, see this class's header note and
    // `workspaces.integration.test.ts`'s "F1-T10 PR5 ADDITION" comment for
    // the full rationale, including why `remindAcknowledged` needs an
    // explicit `defaultValue: false` (unlike `status`/`priority` above).
    await this.defineSeedField(workspaceId, {
      key: 'remindAt',
      label: 'Remind At',
      fieldType: 'datetime',
      config: {},
      permissions: SEEDED_FIELD_PERMISSIONS,
    });

    await this.defineSeedField(workspaceId, {
      key: 'remindAcknowledged',
      label: 'Reminder Acknowledged',
      fieldType: 'checkbox',
      config: {},
      defaultValue: false,
      permissions: SEEDED_FIELD_PERMISSIONS,
    });
  }

  /** Wraps a single `FieldDefinitionsService.define()` seed call with the
   * `ConflictError`-swallowing idempotency documented on `seedTaskFields`. */
  private async defineSeedField(
    workspaceId: string,
    input: DefineFieldDefinitionInput,
  ): Promise<void> {
    try {
      await this.fieldDefinitionsService.define(workspaceId, TASK_OBJECT_TYPE, SEED_ACTOR, input);
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        throw error;
      }
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
