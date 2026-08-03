import type { QuerySpec } from '@luminaos/shared';

/**
 * F1-T9 plan: a saved (query + view-type) combination a user can revisit or
 * share with the workspace. `ownerId: null` means a shared (workspace-wide)
 * view; a non-null `ownerId` means a personal view visible only to that
 * user — permission enforcement itself lives in the server layer, not here.
 */
export type ViewType = 'list' | 'board' | 'table' | 'calendar' | 'timeline';

export type SavedViewLifecycle = 'active' | 'deleted';

export interface SavedView {
  id: string;
  workspaceId: string;
  objectType: string;
  name: string;
  icon: string;
  viewType: ViewType;
  querySpec: Omit<QuerySpec, 'cursor' | 'limit'>;
  dateField?: string | undefined;
  startField?: string | undefined;
  endField?: string | undefined;
  ownerId: string | null;
  lifecycle: SavedViewLifecycle;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A draft of a saved-view domain event, not yet wrapped into the F0-T6
 * `NewDomainEvent` envelope — same shape as F1-T1's `ObjectEventDraft` /
 * F1-T2's `FieldEventDraft` / F1-T3's `RelationEventDraft` (that wrapping is
 * the server layer's job).
 */
export interface SavedViewEventDraft {
  type: string;
  payload: Record<string, unknown>;
}
