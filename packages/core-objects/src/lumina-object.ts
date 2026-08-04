/**
 * Per ADR-0003 "Varlık modeli". `id` is a ULID (business identity, seen in
 * API/URL/projections); the event-stream identity (`streamId`, a UUID) lives
 * in the `objects_view` projection mapping, not on this type.
 */
export type ObjectType = 'task' | 'doc' | 'note';

export type Lifecycle = 'active' | 'archived' | 'deleted';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  order: number;
}

/**
 * Per F1-T10 PR4: embedded, OPTIONAL `LuminaObject` field (mirrors
 * `checklist`'s embedded-value-type precedent — see
 * `./recurrence-rule-commands.test.ts`'s header comment for the full design
 * rationale). Only ever meaningfully populated on `task` objects, but
 * present on the type structurally like `checklist` is.
 */
export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byWeekday?: number[];
  endDate?: string;
}

export interface LuminaObject {
  id: string;
  type: ObjectType;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lifecycle: Lifecycle;
  checklist: ChecklistItem[];
  recurrenceRule?: RecurrenceRule;
}
