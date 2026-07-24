/**
 * A workspace-scoped relation between two LuminaObjects. Per F1-T3 plan,
 * this is a separate event-sourced entity from `LuminaObject` (mirroring
 * F1-T2's `FieldDefinition`), with its own event stream
 * (`RelationCreated`/`RelationRemoved`).
 */
export type RelationKind = 'parentChild' | 'reference' | 'dependency';

export type RelationStatus = 'active' | 'removed';

export interface Relation {
  id: string;
  workspaceId: string;
  fromId: string;
  toId: string;
  kind: RelationKind;
  status: RelationStatus;
  createdAt: Date;
  updatedAt: Date;
}
