import type { ObjectType } from '../lumina-object.js';
import type { FieldPermissions } from './field-permissions.js';
import type { FieldType } from './field-type-registry.js';

/**
 * A workspace + object-type scoped custom field definition. Per F1-T2 plan
 * (PR-A), this is a separate event-sourced entity from `LuminaObject`, with
 * its own event stream (`FieldDefined`/`FieldUpdated`/`FieldArchived`).
 */
export interface FieldDefinition {
  id: string;
  workspaceId: string;
  objectType: ObjectType;
  key: string;
  label: string;
  fieldType: FieldType;
  config: unknown;
  defaultValue?: unknown;
  permissions: FieldPermissions;
  lifecycle: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}
