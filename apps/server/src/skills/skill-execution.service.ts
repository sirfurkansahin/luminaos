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

  async executeSkill<TOutput>(
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: unknown,
  ): Promise<AgentActionResult<TOutput>> {
    const skill = this.skillRegistry.get(skillId);
    if (!skill) {
      throw new NotFoundError(`No skill registered for id "${skillId}"`);
    }

    // SECURITY NOTE (security-review finding, F3-T2 PR2): `objectType` is
    // deliberately omitted here. `evaluateManifestGrant` (@luminaos/agent-runtime)
    // only enforces a manifest's `dataScope.objectTypes` restriction when
    // `request.objectType !== undefined` -- omitting it SKIPS that check
    // entirely rather than denying, so today a manifest scoped to specific
    // `objectTypes` (not `'all'`) grants any matching-actionType skill
    // unconditionally, with NO dataScope narrowing enforced. This is a real
    // gap, not a false-negative in this PR only because the registry is
    // still empty (no real skills exist to exploit it yet). PR3+ MUST either
    // (a) have each real skill determine and pass its own relevant
    // `objectType` here (derived from its `input`, shape varies per skill),
    // or (b) explicitly and deliberately document that skill-level actions
    // bypass object-level scoping by design -- this must not ship silently.
    const allowed = await this.agentPermissionManifestsService.checkPermission(
      workspaceId,
      agentIdentifier,
      { actionType: skillId, now: new Date() },
    );
    if (!allowed) {
      throw new ForbiddenError();
    }

    return this.agentResourceLimitsService.executeAgentAction<TOutput>(
      workspaceId,
      agentIdentifier,
      skillId,
      () => skill.execute(input) as Promise<TOutput>,
    );
  }
}
