import { Module } from '@nestjs/common';

import { SkillRegistry } from '@luminaos/skill-sdk';

import { SKILL_REGISTRY, SkillExecutionService } from './skill-execution.service.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';

/**
 * F3-T2 PR2 (ADR-0036 Karar f): wires `SkillExecutionService` -- the ONE
 * integration point between `@luminaos/skill-sdk`'s `SkillRegistry` and
 * `AgentRuntimeModule`'s `AgentPermissionManifestsService`/
 * `AgentResourceLimitsService` -- into Nest DI. `SkillRegistry` is not a
 * zero-arg-constructible-by-Nest class in any special way, but it IS
 * process-wide singleton state (the in-memory skill catalog), so it is
 * provided via a factory provider under the `SKILL_REGISTRY` token, mirroring
 * `AgentRuntimeModule`'s own `AgentConcurrencyGuard` factory-provider
 * precedent. No real skills are registered here yet -- an empty registry,
 * starting in PR3+.
 */
@Module({
  imports: [AgentRuntimeModule],
  providers: [
    {
      provide: SKILL_REGISTRY,
      useFactory: () => new SkillRegistry(),
    },
    SkillExecutionService,
  ],
  exports: [SkillExecutionService],
})
export class SkillsModule {}
