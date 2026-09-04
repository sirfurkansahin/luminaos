import { Module } from '@nestjs/common';

import { SkillRegistry } from '@luminaos/skill-sdk';

import {
  buildAddChecklistItemSkill,
  buildCreateObjectSkill,
  buildGetObjectSkill,
  buildQueryObjectsSkill,
  buildRefreshAIFieldSkill,
  buildScheduleTimeBlockSkill,
  buildSetFieldValuesSkill,
  buildSetRecurrenceRuleSkill,
  buildToggleChecklistItemSkill,
  OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM,
} from './object-skills.js';
import { SKILL_REGISTRY, SkillExecutionService } from './skill-execution.service.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { ObjectsService } from '../objects/objects.service.js';

/**
 * F3-T2 PR2/PR3 (ADR-0036 Karar f): wires `SkillExecutionService` -- the ONE
 * integration point between `@luminaos/skill-sdk`'s `SkillRegistry` and
 * `AgentRuntimeModule`'s `AgentPermissionManifestsService`/
 * `AgentResourceLimitsService` -- into Nest DI. `SkillRegistry` is not a
 * zero-arg-constructible-by-Nest class in any special way, but it IS
 * process-wide singleton state (the in-memory skill catalog), so it is
 * provided via a factory provider under the `SKILL_REGISTRY` token, mirroring
 * `AgentRuntimeModule`'s own `AgentConcurrencyGuard` factory-provider
 * precedent.
 *
 * KNOWN, TEMPORARY GAP (PR3): the 9 skills registered below are signed with
 * `object-skills.ts`'s own process-lifetime-generated Ed25519 keypair
 * (`OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM`), NOT the canonical
 * `SKILL_SDK_PUBLIC_KEY_PEM` constant `registerSkill()` curries -- no private
 * key matching that canonical constant exists anywhere in this repo (see
 * `skill-sdk-public-key.ts`'s own doc comment), so signing genuinely against
 * it is not possible today. A real key-management workflow (the canonical
 * public key's matching private key held securely by a release/CI process)
 * is a follow-up concern, not fixed in this PR.
 */
@Module({
  imports: [AgentRuntimeModule, ObjectsModule],
  providers: [
    {
      provide: SKILL_REGISTRY,
      useFactory: (objectsService: ObjectsService) => {
        const registry = new SkillRegistry();
        const builders = [
          buildCreateObjectSkill,
          buildGetObjectSkill,
          buildQueryObjectsSkill,
          buildSetFieldValuesSkill,
          buildAddChecklistItemSkill,
          buildToggleChecklistItemSkill,
          buildScheduleTimeBlockSkill,
          buildRefreshAIFieldSkill,
          buildSetRecurrenceRuleSkill,
        ];

        for (const build of builders) {
          registry.register(build(objectsService), OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM);
        }

        return registry;
      },
      inject: [ObjectsService],
    },
    SkillExecutionService,
  ],
  exports: [SkillExecutionService],
})
export class SkillsModule {}
