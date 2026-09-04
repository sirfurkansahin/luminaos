import { Inject, Injectable } from '@nestjs/common';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import { ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { SkillRegistry } from '@luminaos/skill-sdk';

import { AgentPermissionManifestsService } from '../agent-runtime/agent-permission-manifests.service.js';
import { AgentResourceLimitsService } from '../agent-runtime/agent-resource-limits.service.js';

/** DI token for the process-wide `SkillRegistry` instance (see `SkillsModule`). */
export const SKILL_REGISTRY = Symbol('SKILL_REGISTRY');

/**
 * F3-T2 PR2 (ADR-0036 Karar f): the ONE integration point between
 * `@luminaos/skill-sdk`'s `SkillRegistry` and F3-T1's already-merged
 * `AgentPermissionManifestsService`/`AgentResourceLimitsService`. Every
 * skill invocation MUST go through `executeSkill`, in this exact,
 * non-optional order:
 *
 *   1. Look the skill up in the registry -- `NotFoundError` if absent,
 *      BEFORE any permission/resource-limit check.
 *   2. Check the agent's permission manifest for this exact `skillId` --
 *      `ForbiddenError` if not allowed; the skill's `execute` is NEVER
 *      called in this case.
 *   3. Route the actual execution through
 *      `AgentResourceLimitsService.executeAgentAction` (rate limiting,
 *      concurrency guard, sandboxing) -- its `AgentActionResult` is
 *      returned UNCHANGED.
 */
@Injectable()
export class SkillExecutionService {
  constructor(
    @Inject(SKILL_REGISTRY) private readonly skillRegistry: SkillRegistry,
    private readonly agentPermissionManifestsService: AgentPermissionManifestsService,
    private readonly agentResourceLimitsService: AgentResourceLimitsService,
  ) {}

  /**
   * `objectType` (F3-T2 PR3 fix of a PR2 security-review finding):
   * `evaluateManifestGrant` (@luminaos/agent-runtime) only enforces a
   * manifest's `dataScope.objectTypes` restriction when
   * `request.objectType !== undefined` -- callers that know the target
   * object's type (or a query's single target type) MUST pass it here, or
   * that manifest dimension goes unenforced for this call.
   *
   * `input` is always spread with `workspaceId`/`agentIdentifier` injected
   * LAST, right before `skill.execute` is ever called (security fix,
   * F3-T2 PR3): a skill's own `execute` needs these values to know which
   * workspace/agent it is acting for, but they must come from THIS
   * method's own already-checked-permission parameters, never from
   * caller-supplied `input` -- otherwise a caller could pass
   * `executeSkill(workspaceIdA, ..., {workspaceId: workspaceIdB, ...})`,
   * pass the permission check against workspace A, then have the skill
   * silently act against workspace B. Overwriting `input.workspaceId`/
   * `.agentIdentifier` with the authoritative values closes that gap
   * regardless of what a caller puts in `input`.
   */
  async executeSkill<TOutput>(
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: Record<string, unknown>,
    objectType?: string,
  ): Promise<AgentActionResult<TOutput>> {
    const skill = this.skillRegistry.get(skillId);
    if (!skill) {
      throw new NotFoundError(`No skill registered for id "${skillId}"`);
    }

    const allowed = await this.agentPermissionManifestsService.checkPermission(
      workspaceId,
      agentIdentifier,
      {
        actionType: skillId,
        now: new Date(),
        ...(objectType === undefined ? {} : { objectType }),
      },
    );
    if (!allowed) {
      throw new ForbiddenError();
    }

    const authoritativeInput = { ...input, workspaceId, agentIdentifier };

    return this.agentResourceLimitsService.executeAgentAction<TOutput>(
      workspaceId,
      agentIdentifier,
      skillId,
      () => skill.execute(authoritativeInput) as Promise<TOutput>,
    );
  }
}
