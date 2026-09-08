import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AUTONOMY_GOVERNANCE_FLOOR } from '@luminaos/agent-runtime';
import type { AutonomyTier, TaskAutonomySetting } from '@luminaos/agent-runtime';
import { AppError, deriveDeterministicUuid, ForbiddenError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { TaskAutonomySettingProjection } from './autonomy-tier-settings.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { taskAutonomySettings } from '../db/schema/task-autonomy-settings.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const TASK_AUTONOMY_SETTING_STREAM_TYPE = 'task-autonomy-setting';

/**
 * Fixed, arbitrary namespace UUID for deriving per-(workspace, actionType)
 * task-autonomy-setting streamIds. MUST NEVER CHANGE once real data exists
 * — mirrors `AgentPermissionManifestsService`'s identical
 * `AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE` reasoning. MUST match the
 * literal pinned in `autonomy-tier-settings.service.integration.test.ts`.
 */
export const TASK_AUTONOMY_SETTING_UUID_NAMESPACE = '7e2f9c14-3a5d-4b8e-9f21-6c8a0d4e2b77';

type TaskAutonomySettingRow = typeof taskAutonomySettings.$inferSelect;

/**
 * Signals a database invariant violation (an upsert that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors
 * `AgentPermissionManifestsService`'s `UnexpectedQueryResultError` pattern.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

function toTaskAutonomySetting(row: TaskAutonomySettingRow): TaskAutonomySetting {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actionType: row.actionType,
    tier: row.tier as AutonomyTier,
    updatedBy: { type: row.updatedByType, id: row.updatedById } as Actor,
    updatedAt: row.updatedAt,
  };
}

/**
 * F3-T5 (ADR-0039 Karar a/b/c/i): `AutonomyTierSettingsService`, an
 * event-sourced, workspace-scoped `(workspaceId, actionType)` setting —
 * structurally the same shape as `AgentPermissionManifestsService`: flat
 * `admin`+/`member`+ RBAC, deterministic per-key `streamId` (no stored
 * `streamId` column), upsert-on-write (a "set" always overwrites, no
 * separate history).
 *
 * `set` additionally enforces the governance floor (ADR-0039 Karar c): for
 * any `actionType` in `AUTONOMY_GOVERNANCE_FLOOR`, a request to raise the
 * tier above `'propose'` is rejected even for an admin caller — setting it
 * TO `'propose'` (the already-default value) is allowed.
 */
@Injectable()
export class AutonomyTierSettingsService {
  private readonly projection = new TaskAutonomySettingProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async set(
    workspaceId: string,
    actionType: string,
    tier: AutonomyTier,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<TaskAutonomySetting> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    if (tier !== 'propose' && AUTONOMY_GOVERNANCE_FLOOR.includes(actionType)) {
      throw new ForbiddenError(
        `"${actionType}" is a governance-floor action type — it can only be set to "propose".`,
      );
    }

    const streamId = this.streamIdFor(workspaceId, actionType);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: TASK_AUTONOMY_SETTING_STREAM_TYPE,
      workspaceId,
      type: 'TaskAutonomyTierSet',
      payload: { actionType, tier },
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const current = await this.get(workspaceId, actionType);

    if (!current) {
      throw new UnexpectedQueryResultError(
        'Failed to read back task autonomy setting immediately after setting it.',
      );
    }

    return current;
  }

  /**
   * NO RBAC parameter at all (ADR-0039 Karar i) — an internal read-point,
   * mirrors `AgentPermissionManifestsService.checkPermission`'s convention.
   */
  async get(workspaceId: string, actionType: string): Promise<TaskAutonomySetting | null> {
    const [row] = await this.db
      .select()
      .from(taskAutonomySettings)
      .where(
        and(
          eq(taskAutonomySettings.workspaceId, workspaceId),
          eq(taskAutonomySettings.actionType, actionType),
        ),
      )
      .limit(1);

    return row ? toTaskAutonomySetting(row) : null;
  }

  async list(workspaceId: string, callerRole: MembershipRole): Promise<TaskAutonomySetting[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select()
      .from(taskAutonomySettings)
      .where(eq(taskAutonomySettings.workspaceId, workspaceId));

    return rows.map(toTaskAutonomySetting);
  }

  /**
   * NO RBAC parameter at all — an internal read-point for `CommandsService`
   * (F3-T5 PR2). Returns the fail-safe default `'propose'` when no row
   * exists for `(workspaceId, actionType)` (ADR-0039 Karar b).
   */
  async resolveTier(workspaceId: string, actionType: string): Promise<AutonomyTier> {
    const setting = await this.get(workspaceId, actionType);
    return setting?.tier ?? 'propose';
  }

  private streamIdFor(workspaceId: string, actionType: string): string {
    return deriveDeterministicUuid(
      TASK_AUTONOMY_SETTING_UUID_NAMESPACE,
      `${workspaceId}:${actionType}`,
    );
  }
}
