import { forwardRef, Module } from '@nestjs/common';

import { MentionActionWorker } from './mention-action-worker.service.js';
import { ObjectCommentsController } from './object-comments.controller.js';
import { CommentsService } from './object-comments.service.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { SkillsModule } from '../skills/skills.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F3-T3 (ADR-0037 Karar c/(3)): wires the `object_comments` @mention
 * surface's server bindings (`CommentsService`/`Controller`/
 * `MentionActionWorker`) into Nest DI, mirroring `AgentRuntimeModule`'s
 * exact import/provider shape. Imports `AgentRuntimeModule` for its
 * already-exported `AgentDirectoryService` (mention resolution) rather than
 * re-registering it as a second provider, and `SkillsModule` for its
 * already-exported `SkillExecutionService` -- `MentionActionWorker`'s FIRST
 * real caller (`SkillsModule` does not import `CommentsModule`, so no
 * circular dependency here).
 *
 * `AgentRuntimeModule` is wrapped in `forwardRef()` (F3-T6 PR2, ADR-0040
 * Karar g): `AgentRuntimeModule` now imports `CommandsModule` (for
 * `AgentActionRecordsController.undo`), and `CommandsModule` imports
 * `CommentsModule` back — since `AgentRuntimeModule` is app.module.ts's very
 * FIRST static import, its own module body starts loading `CommandsModule`
 * (and transitively THIS file) before `AgentRuntimeModule`'s own class
 * binding is assigned; without `forwardRef()` here, this file's `@Module`
 * decorator would see `AgentRuntimeModule` as `undefined` at that point
 * (real, reproduced failure: "Nest cannot create the CommentsModule
 * instance ... module at index [3] ... is undefined").
 */
@Module({
  imports: [
    EventStoreModule,
    DbModule,
    AuthModule,
    forwardRef(() => AgentRuntimeModule),
    SkillsModule,
  ],
  controllers: [ObjectCommentsController],
  providers: [
    CommentsService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
    MentionActionWorker,
  ],
  exports: [CommentsService, MentionActionWorker],
})
export class CommentsModule {}
