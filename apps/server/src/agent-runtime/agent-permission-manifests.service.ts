import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import {
  assertValidManifestGrant,
  evaluateManifestGrant,
  type AgentPermissionManifest,
} from '@luminaos/agent-runtime';
import { AppError, deriveDeterministicUuid, ForbiddenError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { AgentPermissionManifestProjection } from './agent-permission-manifests.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { agentPermissionManifests } from '../db/schema/agent-permission-manifests.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const AGENT_PERMISSION_MANIFEST_STREAM_TYPE = 'agent-permission-manifest';

/**
 * Fixed, arbitrary namespace UUID for deriving per-(workspace,
 * agentIdentifier) agent-permission-manifest streamIds. MUST NEVER CHANGE
 * once real data exists -- changing it silently opens a new stream per pair,
 * losing continuity with any prior grant/revoke history (F3-T1, ADR-0035
 * Karar b/c). MUST match the literal pinned in
 * `agent-permission-manifests.service.integration.test.ts`.
 */
export const AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE = 'f4a1c8d2-9e3b-4a77-8c1d-2b6e9a0f5c31';

export interface GrantManifestInput {
  agentIdentifier: string;
  dataScope: AgentPermissionManifest['dataScope'];
  actionTypes: string[];
  timeWindow: { startsAt: Date | null; expiresAt: Date | null };
}

type AgentPermissionManifestRow = typeof agentPermissionManifests.$inferSelect;

/**
 * Signals a database invariant violation (an insert/upsert that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors `MemoryAccessPolicyService`'s
 * `UnexpectedQueryResultError` pattern for "should never happen" cases.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

function toAgentPermissionManifest(row: AgentPermissionManifestRow): AgentPermissionManifest {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentIdentifier: row.agentIdentifier,
    dataScope: row.dataScope as AgentPermissionManifest['dataScope'],
    actionTypes: row.actionTypes as string[],
    timeWindow: {
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
    },
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * F3-T1 (ADR-0035 Karar b/c/d/i): `AgentPermissionManifestsService`, an
 * event-sourced, workspace-scoped `(workspaceId, agentIdentifier)` grant/
 * revoke aggregate -- structurally close to `MemoryAccessPolicyService`
 * (ADR-0024), but flat/workspace-wide `admin`+/`member`+ RBAC (mirrors
 * `AutomationTriggersService`'s exact pattern, ADR-0032 §h), NOT
 * `MemoryAccessPolicyService`'s self-service-by-`userId` shape. `streamId`
 * is a DETERMINISTIC function of `(workspaceId, agentIdentifier)` (RFC 4122
 * UUIDv5, via `deriveDeterministicUuid`) -- there is no stored `streamId`
 * column on `agent_permission_manifests` (unlike `automation_triggers`), so
 * every write/read re-derives it.
 */
@Injectable()
export class AgentPermissionManifestsService {
  private readonly projection = new AgentPermissionManifestProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async grant(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: GrantManifestInput,
  ): Promise<AgentPermissionManifest> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    assertValidManifestGrant({
      actionTypes: input.actionTypes,
      dataScope: input.dataScope,
      timeWindow: input.timeWindow,
    });

    const streamId = this.streamIdFor(workspaceId, input.agentIdentifier);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: AGENT_PERMISSION_MANIFEST_STREAM_TYPE,
      workspaceId,
      type: 'AgentPermissionGranted',
      payload: {
        agentIdentifier: input.agentIdentifier,
        dataScope: input.dataScope,
        actionTypes: input.actionTypes,
        timeWindow: {
          startsAt:
            input.timeWindow.startsAt === null ? null : input.timeWindow.startsAt.toISOString(),
          expiresAt:
            input.timeWindow.expiresAt === null ? null : input.timeWindow.expiresAt.toISOString(),
        },
      },
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const current = await this.get(workspaceId, input.agentIdentifier);

    if (!current) {
      throw new UnexpectedQueryResultError(
        'Failed to read back agent permission manifest immediately after granting it.',
      );
    }

    return current;
  }

  async revoke(
    workspaceId: string,
    agentIdentifier: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<AgentPermissionManifest> {
    if (!hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const streamId = this.streamIdFor(workspaceId, agentIdentifier);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: AGENT_PERMISSION_MANIFEST_STREAM_TYPE,
      workspaceId,
      type: 'AgentPermissionRevoked',
      payload: { agentIdentifier },
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const current = await this.get(workspaceId, agentIdentifier);

    if (!current) {
      throw new UnexpectedQueryResultError(
        'Failed to read back agent permission manifest immediately after revoking it.',
      );
    }

    return current;
  }

  /**
   * ALL rows for `workspaceId`, UNFILTERED by `revokedAt` (ADR-0035's
   * `MemoryAccessPolicy`-derived audit-value convention, mirroring
   * `MemoryAccessPolicyService.list`/`AutomationTriggersService.list`'s own
   * reasoning): a workspace's own grant/revoke history is audit-valuable
   * information, not something to hide.
   */
  async list(workspaceId: string, callerRole: MembershipRole): Promise<AgentPermissionManifest[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    const rows = await this.db
      .select()
      .from(agentPermissionManifests)
      .where(eq(agentPermissionManifests.workspaceId, workspaceId));

    return rows.map(toAgentPermissionManifest);
  }

  /**
   * NO RBAC parameter at all (ADR-0035 Karar e) -- an internal read-point
   * for future callers (F3-T2/F3-T3), delegating to the pure, fail-closed
   * `evaluateManifestGrant` (`@luminaos/agent-runtime`).
   */
  async checkPermission(
    workspaceId: string,
    agentIdentifier: string,
    request: { actionType: string; objectType?: string; now: Date },
  ): Promise<boolean> {
    const manifest = await this.get(workspaceId, agentIdentifier);

    return evaluateManifestGrant(manifest ?? undefined, request);
  }

  private async get(
    workspaceId: string,
    agentIdentifier: string,
  ): Promise<AgentPermissionManifest | null> {
    const [row] = await this.db
      .select()
      .from(agentPermissionManifests)
      .where(
        and(
          eq(agentPermissionManifests.workspaceId, workspaceId),
          eq(agentPermissionManifests.agentIdentifier, agentIdentifier),
        ),
      )
      .limit(1);

    return row ? toAgentPermissionManifest(row) : null;
  }

  private streamIdFor(workspaceId: string, agentIdentifier: string): string {
    return deriveDeterministicUuid(
      AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE,
      `${workspaceId}:${agentIdentifier}`,
    );
  }
}
