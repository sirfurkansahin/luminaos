import { computeQueryAggregate } from '@luminaos/artifacts';
import type { AggregateFn, Role } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';
import type { Actor, QuerySpec } from '@luminaos/shared';

import type { ObjectsService, ObjectWithFieldValues } from '../objects/objects.service.js';

export interface CaptureBaselineServiceInput {
  title: string;
  querySpec: QuerySpec;
  aggregateFn: AggregateFn;
  targetFieldKey?: string;
}

/**
 * `BaselinesService`'s only collaborator is typed as a narrow, structural
 * `Pick` (imported `type`-only here, so loading this module never pulls in
 * `ObjectsService`'s own runtime module graph -- notably `../config/env.js`'s
 * eager `DATABASE_URL` validation, which `baselines.service.test.ts`'s
 * plain-mock, no-Nest-DI, no-Testcontainers harness deliberately never
 * sets). A real `ObjectsService` instance still satisfies this narrower
 * interface structurally; `artifacts.module.ts` wires the REAL instance in
 * via an explicit `useFactory` provider, mirroring `WidgetsService`'s
 * identical precedent (`./widgets.service.ts`), so this file itself needs no
 * Nest decorators/imports at all.
 */
export type BaselineObjectsService = Pick<ObjectsService, 'query' | 'create' | 'setFieldValues'>;

/**
 * `BaselinesService` (F3-T10 PR2, ADR-0044 Karar b/c/d): orchestrates the
 * "already-known `QuerySpec` (sourced from a `SavedView` on the frontend,
 * Karar d -- this service itself is unaware of that origin) -> real
 * `artifact` Lumina Object whose `capturedValue` is a single frozen numeric
 * snapshot" flow. Unlike `WidgetsService`, has ZERO AI-gateway dependency
 * (Karar c) -- no AI compilation step at all, the `QuerySpec` arrives
 * pre-formed.
 */
export class BaselinesService {
  constructor(private readonly objectsService: BaselineObjectsService) {}

  async capture(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    input: CaptureBaselineServiceInput,
  ): Promise<ObjectWithFieldValues> {
    if (input.querySpec.group !== undefined) {
      throw new ValidationError(
        'Baseline queries do not support grouped querySpec (v0 flat-only).',
        {
          group: input.querySpec.group,
        },
      );
    }

    const queryResult = await this.objectsService.query(workspaceId, callerRole, input.querySpec);

    // Defensive, fail-closed narrowing: the `group` guard above already
    // forbids a grouped `QueryResult` shape, this should never occur in
    // practice -- mirrors `WidgetsService.generate`'s identical guard.
    if (!('objects' in queryResult)) {
      throw new ValidationError('Unexpected grouped query result for a baseline (unsupported).');
    }

    const capturedValue = computeQueryAggregate(
      queryResult.objects,
      input.aggregateFn,
      input.targetFieldKey,
    );

    const created = await this.objectsService.create(
      workspaceId,
      actor,
      { objectType: 'artifact', title: input.title },
      callerRole,
    );

    // Fixed 'owner' role here, NOT `callerRole`: mirrors
    // `WidgetsService.generate`'s/`ArtifactsService.generate`'s identical
    // `'owner'`-bypass precedent -- these fields are exclusively
    // system/query-populated by this capture pipeline, never a direct
    // manual edit.
    const entries = [
      { fieldKey: 'artifactType', value: 'baseline' },
      { fieldKey: 'querySpec', value: JSON.stringify(input.querySpec) },
      { fieldKey: 'aggregateFn', value: input.aggregateFn },
      { fieldKey: 'capturedValue', value: capturedValue },
    ];

    if (input.targetFieldKey !== undefined) {
      entries.push({ fieldKey: 'targetFieldKey', value: input.targetFieldKey });
    }

    return this.objectsService.setFieldValues(workspaceId, created.id, actor, 'owner', entries);
  }
}
