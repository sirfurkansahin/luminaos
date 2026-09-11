import type { AIProvider } from '@luminaos/ai-gateway';
import {
  buildQueryResultTableSection,
  deriveWidgetColumns,
  renderArtifactHtml,
} from '@luminaos/artifacts';
import type { ArtifactContent } from '@luminaos/artifacts';
import type { ObjectType, Role } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { compileWidgetQuery } from './compile-widget-query.js';
import { selectAIModel } from '../ai/select-ai-model.js';

import type { CompileWidgetQueryResult } from './compile-widget-query.js';
import type { AIUsageService } from '../ai/ai-usage.service.js';
import type { FieldDefinitionsService } from '../fields/field-definitions.service.js';
import type { ObjectsService, ObjectWithFieldValues } from '../objects/objects.service.js';

export interface GenerateWidgetServiceInput {
  prompt: string;
  objectType: ObjectType;
  themePreset: 'kurumsal' | 'canli' | 'minimal';
}

/**
 * `WidgetsService`'s three collaborators are typed as narrow, structural
 * interfaces (imported `type`-only here, so loading this module never pulls
 * in `AIUsageService`/`ObjectsService`/`FieldDefinitionsService`'s own
 * runtime module graphs -- notably `../config/env.js`'s eager
 * `DATABASE_URL` validation, which `widgets.service.test.ts`'s plain-mock,
 * no-Nest-DI, no-Testcontainers harness deliberately never sets). Real
 * class instances still satisfy these narrower interfaces structurally;
 * `artifacts.module.ts` wires the REAL instances in via an explicit
 * `useFactory` provider (mirroring `ai-provider.module.ts`'s identical
 * "keep the token import side-effect-free" precedent), so this file itself
 * needs no Nest decorators/imports at all.
 *
 * `withWorkspaceAILock` is deliberately typed here as `Promise<unknown>`
 * (NOT `AIUsageService`'s own generic `<T>(...)`  signature) -- a generic
 * method type can only be satisfied by an equally-generic implementation,
 * which `widgets.service.test.ts`'s own harness mock (scripted with a
 * concrete `Promise<unknown>` callback signature) is not. The real
 * `AIUsageService.withWorkspaceAILock<T>` instance still satisfies this
 * narrower, `T`-erased-to-`unknown` shape (specializing its own `T` to
 * `unknown` is always a valid, unconditionally-safe instantiation).
 * `generate()` below immediately narrows the `unknown` result back to
 * `CompileWidgetQueryResult` via an explicit, documented cast -- the ONLY
 * callback ever passed to `withWorkspaceAILock` here is one that resolves
 * to exactly that shape.
 */
export type WidgetAIUsageService = Pick<
  AIUsageService,
  'assertAITokenQuotaNotExceeded' | 'assertAICostBudgetNotExceeded' | 'recordAIUsage'
> & {
  withWorkspaceAILock: (workspaceId: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

export type WidgetObjectsService = Pick<ObjectsService, 'query' | 'create' | 'setFieldValues'>;

export type WidgetFieldDefinitionsService = Pick<FieldDefinitionsService, 'list'>;

/**
 * `WidgetsService` (F3-T8 PR2, ADR-0042 Karar d): orchestrates the
 * "natural-language query request -> real `artifact` Lumina Object whose
 * content comes from ACTUAL query rows" flow. Deliberately does NOT call
 * `ArtifactsService.generate()` -- it follows its own PARALLEL flow: compile
 * (AI, inside the lock) -> query (outside the lock, cheap) ->
 * `buildQueryResultTableSection` (pure, code) -> `renderArtifactHtml`
 * (unchanged) -> persist (`ArtifactsService`'s SAME `'owner'`-bypass
 * pattern).
 */
export class WidgetsService {
  constructor(
    private readonly aiUsageService: WidgetAIUsageService,
    private readonly objectsService: WidgetObjectsService,
    private readonly fieldDefinitionsService: WidgetFieldDefinitionsService,
    private readonly provider: AIProvider,
  ) {}

  async generate(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    input: GenerateWidgetServiceInput,
  ): Promise<ObjectWithFieldValues> {
    const availableFields = await this.fieldDefinitionsService.list(
      workspaceId,
      input.objectType,
      callerRole,
    );

    const lockResult = await this.aiUsageService.withWorkspaceAILock(workspaceId, async () => {
      await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
      await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

      const model = selectAIModel({ outputType: 'widgetQuery' });

      return compileWidgetQuery({
        provider: this.provider,
        prompt: input.prompt,
        objectType: input.objectType,
        availableFields,
        model,
        recordUsage: (usage) =>
          this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
      });
    });

    // `withWorkspaceAILock` is typed generically-erased-to-`unknown` here
    // (see `WidgetAIUsageService`'s own doc comment for why) -- the callback
    // passed above always resolves to exactly `compileWidgetQuery`'s own
    // `CompileWidgetQueryResult`, so this cast is a safe, structural-only
    // narrowing back to that known shape.
    const { querySpec, parseError, message } = lockResult as CompileWidgetQueryResult;

    if (parseError || querySpec === undefined) {
      throw new ValidationError(message ?? 'Widget query compilation failed.');
    }

    const queryResult = await this.objectsService.query(workspaceId, callerRole, querySpec);

    // `compileWidgetQuery`'s allowlist already forbids a `group` key, so a
    // grouped `QueryResult` shape should never occur here in practice --
    // this is a defensive, fail-closed narrowing (never an unsafe cast) in
    // case that invariant is ever violated upstream.
    if (!('objects' in queryResult)) {
      throw new ValidationError('Unexpected grouped query result for a widget (unsupported).');
    }

    const rows = queryResult.objects;
    const columns = deriveWidgetColumns(querySpec);
    const content: ArtifactContent = {
      title: input.prompt.slice(0, 200),
      sections: [buildQueryResultTableSection(rows, columns)],
    };
    const htmlContent = renderArtifactHtml(content, input.themePreset, 'dashboard');

    const created = await this.objectsService.create(
      workspaceId,
      actor,
      { objectType: 'artifact', title: input.prompt.slice(0, 200) },
      callerRole,
    );

    // Fixed 'owner' role here, NOT `callerRole`: mirrors
    // `ArtifactsService.generate()`'s identical `'owner'`-bypass precedent
    // (`./artifacts.service.ts`) -- these 5 fields are exclusively
    // system/query-populated by this generation pipeline, never a direct
    // manual edit.
    return this.objectsService.setFieldValues(workspaceId, created.id, actor, 'owner', [
      { fieldKey: 'htmlContent', value: htmlContent },
      { fieldKey: 'themePreset', value: input.themePreset },
      { fieldKey: 'generationPrompt', value: input.prompt },
      // ALWAYS 'dashboard', regardless of input.objectType -- ADR-0042
      // Karar (b)/(d).
      { fieldKey: 'artifactType', value: 'dashboard' },
      { fieldKey: 'querySpec', value: JSON.stringify(querySpec) },
    ]);
  }
}
