import { Inject, Injectable } from '@nestjs/common';

import type { AIProvider } from '@luminaos/ai-gateway';
import type { ArtifactType, ThemePresetName } from '@luminaos/artifacts';
import type { Role } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { generateArtifact } from './generate-artifact.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIUsageService } from '../ai/ai-usage.service.js';
import { selectAIModel } from '../ai/select-ai-model.js';
import { ObjectsService } from '../objects/objects.service.js';

import type { ObjectWithFieldValues } from '../objects/objects.service.js';

export interface GenerateArtifactServiceInput {
  prompt: string;
  artifactType: ArtifactType;
  themePreset: ThemePresetName;
}

/**
 * `ArtifactsService` (F3-T7 PR2, ADR-0041 Karar a/b/g): orchestrates the
 * "prompt -> real `artifact` Lumina Object" flow -- the SAME
 * `AIUsageService.withWorkspaceAILock` -> quota/budget-assert -> provider
 * call -> `recordAIUsage` discipline `CommandsService.parse` already uses
 * (ADR-0041 §11).
 *
 * The provider call happens ENTIRELY inside the lock/quota-checked section;
 * the resulting `artifact` Lumina Object is only created AFTER that section
 * returns successfully, mirroring `CommandsService.parse`'s own
 * "AI call inside the lock, durable write after it" split.
 */
@Injectable()
export class ArtifactsService {
  constructor(
    private readonly aiUsageService: AIUsageService,
    private readonly objectsService: ObjectsService,
    @Inject(AI_PROVIDER) private readonly provider: AIProvider,
  ) {}

  async generate(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    input: GenerateArtifactServiceInput,
  ): Promise<ObjectWithFieldValues> {
    const { htmlContent, parseError, message } = await this.aiUsageService.withWorkspaceAILock(
      workspaceId,
      async () => {
        await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
        await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

        const model = selectAIModel({ outputType: 'artifact' });

        return generateArtifact({
          provider: this.provider,
          prompt: input.prompt,
          artifactType: input.artifactType,
          themePreset: input.themePreset,
          model,
          recordUsage: (usage) =>
            this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
        });
      },
    );

    if (parseError) {
      throw new ValidationError(message ?? 'Artifact generation failed.');
    }

    // Title is the RAW prompt (truncated), NOT the AI-generated content's own
    // title -- `generateArtifact` does not thread `content.title` back out
    // today (see `./generate-artifact.ts`'s `GenerateArtifactResult`).
    const created = await this.objectsService.create(
      workspaceId,
      actor,
      { objectType: 'artifact', title: input.prompt.slice(0, 200) },
      callerRole,
    );

    // Fixed 'owner' role here, NOT `callerRole`: these 4 fields are exclusively
    // system/AI-populated by this generation pipeline, never a direct manual
    // edit -- the same reasoning `create()` already applies to its own
    // default-value drafts (written outside the `setFieldValues` permission
    // gate entirely). Gating this internal write by the caller's own
    // `SEEDED_FIELD_PERMISSIONS` edit level would make a `guest` caller's
    // request 403 despite passing `WorkspaceMembershipGuard`, contradicting
    // ADR-0041 Karar (g) ("member+, no additional role gate beyond plain
    // membership"). The caller's `callerRole` still gates `create()` above and
    // every future DIRECT `PATCH .../objects/:id/fields` edit of these same
    // fields via the unchanged `SEEDED_FIELD_PERMISSIONS` (guest: 'view').
    return this.objectsService.setFieldValues(workspaceId, created.id, actor, 'owner', [
      { fieldKey: 'htmlContent', value: htmlContent },
      { fieldKey: 'themePreset', value: input.themePreset },
      { fieldKey: 'generationPrompt', value: input.prompt },
      { fieldKey: 'artifactType', value: input.artifactType },
    ]);
  }
}
