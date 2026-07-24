/**
 * Per ADR-0003 "Varlık modeli". `id` is a ULID (business identity, seen in
 * API/URL/projections); the event-stream identity (`streamId`, a UUID) lives
 * in the `objects_view` projection mapping, not on this type.
 */
export type ObjectType = 'task' | 'doc' | 'note';

export type Lifecycle = 'active' | 'archived' | 'deleted';

export interface LuminaObject {
  id: string;
  type: ObjectType;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lifecycle: Lifecycle;
}
