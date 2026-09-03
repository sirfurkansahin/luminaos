import { ValidationError } from '@luminaos/shared';

import type { AgentDataScope, AgentTimeWindow } from './agent-permission-manifest.js';

export interface ManifestGrantInput {
  actionTypes: string[];
  dataScope: AgentDataScope;
  timeWindow: AgentTimeWindow;
}

/**
 * Pure validator guarding `AgentPermissionGranted` writes, per ADR-0035
 * Karar (c) and the spec's Kabul Kriterleri ("boş `actionTypes`, boş
 * `objectTypes` dizisi, `startsAt >= expiresAt` gibi geçersiz girdileri
 * reddeder"). Mirrors `packages/automation`'s `trigger-commands.ts`
 * assertion pattern — throws `ValidationError` directly, never a bare
 * `Error`.
 */
export function assertValidManifestGrant(input: ManifestGrantInput): void {
  if (input.actionTypes.length === 0) {
    throw new ValidationError('agent permission manifest actionTypes must not be empty', {
      actionTypes: input.actionTypes,
    });
  }

  if (input.dataScope.objectTypes !== 'all' && input.dataScope.objectTypes.length === 0) {
    throw new ValidationError('agent permission manifest dataScope.objectTypes must not be empty', {
      objectTypes: input.dataScope.objectTypes,
    });
  }

  const { startsAt, expiresAt } = input.timeWindow;

  if (startsAt !== null && expiresAt !== null && startsAt >= expiresAt) {
    throw new ValidationError(
      'agent permission manifest timeWindow.startsAt must be before expiresAt',
      {
        startsAt,
        expiresAt,
      },
    );
  }
}
