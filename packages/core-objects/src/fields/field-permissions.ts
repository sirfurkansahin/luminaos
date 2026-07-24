/**
 * Per F1-T2 plan (PR-A): `packages/core-objects` cannot depend on
 * `apps/server`'s `membershipRoleEnum`, so it defines its own small,
 * controlled repeat of the 4 workspace roles. Unlike
 * `hasAtLeastRole`'s ordered membership hierarchy, a field-level
 * permission matrix is an explicit per-role map (a role can be `view`-only
 * on one field and `edit` on another — it is not a single ordered scalar).
 */
export type Role = 'owner' | 'admin' | 'member' | 'guest';

export type FieldPermissionLevel = 'view' | 'edit' | 'hidden';

export type FieldPermissions = Record<Role, FieldPermissionLevel>;

const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'guest'];

const LEVELS: ReadonlySet<string> = new Set<FieldPermissionLevel>(['view', 'edit', 'hidden']);

export function canViewField(permissions: FieldPermissions, role: Role): boolean {
  return permissions[role] !== 'hidden';
}

export function canEditField(permissions: FieldPermissions, role: Role): boolean {
  return permissions[role] === 'edit';
}

/**
 * Structural guard for untrusted input (event payloads, API bodies): true
 * only if `value` is a plain object carrying EXACTLY the 4 `Role` keys,
 * each mapped to a valid `FieldPermissionLevel` — no missing role, no extra
 * key, no invalid level string.
 */
export function isValidFieldPermissions(value: unknown): value is FieldPermissions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (Object.keys(record).length !== ROLES.length) {
    return false;
  }

  return ROLES.every((role) => {
    const level = record[role];
    return typeof level === 'string' && LEVELS.has(level);
  });
}
