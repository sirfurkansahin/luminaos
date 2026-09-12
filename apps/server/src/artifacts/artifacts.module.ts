import { Module } from '@nestjs/common';

import type { AIProvider } from '@luminaos/ai-gateway';

import { ArtifactsController } from './artifacts.controller.js';
import { ArtifactsService } from './artifacts.service.js';
import { BaselineExplanationService } from './baseline-explanation.service.js';
import { BaselinesController } from './baselines.controller.js';
import { BaselinesService } from './baselines.service.js';
import { WidgetsController } from './widgets.controller.js';
import { WidgetsService } from './widgets.service.js';
import { AIProviderModule } from '../ai/ai-provider.module.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIUsageModule } from '../ai/ai-usage.module.js';
import { AIUsageService } from '../ai/ai-usage.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { FieldDefinitionsService } from '../fields/field-definitions.service.js';
import { FieldsModule } from '../fields/fields.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { ObjectsService } from '../objects/objects.service.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F3-T7 PR2 (ADR-0041 Karar a/g/h) + F3-T8 PR2 (ADR-0042 Karar a/i): wires
 * `POST /workspaces/:workspaceId/artifacts` AND its sibling
 * `POST /workspaces/:workspaceId/artifacts/widgets` route (`WidgetsController`,
 * a separate class, same module). `WorkspaceMembershipGuard`/
 * `WorkspaceMembershipService` are provided directly here rather than by
 * importing a shared workspaces module, mirroring `CommandsModule`'s
 * identical pattern. `ObjectsModule`/`FieldsModule` are imported (not just
 * their services provided directly) so `ObjectsService`/
 * `FieldDefinitionsService` are constructed with their own full dependency
 * graphs. `AIProviderModule`/`AIUsageModule` provide `AI_PROVIDER`/
 * `AIUsageService` for both `ArtifactsService` and `WidgetsService`.
 *
 * `WidgetsService` is registered via an explicit `useFactory` (not plain
 * constructor-based DI): its own constructor parameters are typed as narrow
 * `Pick`s of `AIUsageService`/`ObjectsService`/`FieldDefinitionsService`
 * (`./widgets.service.ts`'s own doc comment explains why -- keeping that
 * file import-side-effect-free for its unit test), which Nest's reflected
 * constructor-parameter DI can't resolve to a concrete provider on its own;
 * the factory below supplies the REAL service instances explicitly instead.
 */
@Module({
  imports: [
    DbModule,
    AuthModule,
    EventStoreModule,
    AIProviderModule,
    AIUsageModule,
    ObjectsModule,
    FieldsModule,
  ],
  controllers: [ArtifactsController, WidgetsController, BaselinesController],
  providers: [
    ArtifactsService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
    {
      provide: WidgetsService,
      useFactory: (
        aiUsageService: AIUsageService,
        objectsService: ObjectsService,
        fieldDefinitionsService: FieldDefinitionsService,
        provider: AIProvider,
      ): WidgetsService =>
        new WidgetsService(aiUsageService, objectsService, fieldDefinitionsService, provider),
      inject: [AIUsageService, ObjectsService, FieldDefinitionsService, AI_PROVIDER],
    },
    {
      provide: BaselinesService,
      useFactory: (objectsService: ObjectsService): BaselinesService =>
        new BaselinesService(objectsService),
      inject: [ObjectsService],
    },
    {
      provide: BaselineExplanationService,
      useFactory: (
        aiUsageService: AIUsageService,
        objectsService: ObjectsService,
        provider: AIProvider,
      ): BaselineExplanationService =>
        new BaselineExplanationService(aiUsageService, objectsService, provider),
      inject: [AIUsageService, ObjectsService, AI_PROVIDER],
    },
  ],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
