import type { ObjectType } from './lumina-object.js';

/**
 * Per ADR-0003 "Tip genişletme": a `Record<ObjectType, { titleRequired:
 * boolean }>` registry. `task` requires a non-empty title; `doc`/`note` do
 * not. Adding a new object type = adding an entry here (+ its own
 * schema/migration later).
 */
const objectTypeRegistry: Record<ObjectType, { titleRequired: boolean }> = {
  task: { titleRequired: true },
  doc: { titleRequired: false },
  note: { titleRequired: false },
};

/**
 * Type guard usable on untrusted/external strings (e.g. from an API body).
 */
export function isKnownObjectType(type: string): type is ObjectType {
  return Object.prototype.hasOwnProperty.call(objectTypeRegistry, type);
}

/**
 * Only meaningful for already-known types; callers must narrow with
 * `isKnownObjectType` first.
 */
export function requiresTitle(type: ObjectType): boolean {
  return objectTypeRegistry[type].titleRequired;
}
