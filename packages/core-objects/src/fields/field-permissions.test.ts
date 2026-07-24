import { describe, expect, it } from 'vitest';

import { canEditField, canViewField } from './field-permissions.js';

import type { FieldPermissionLevel, FieldPermissions, Role } from './field-permissions.js';

/**
 * Designed API (per F1-T2 plan, PR-A):
 *
 *   type Role = 'owner' | 'admin' | 'member' | 'guest'
 *   type FieldPermissionLevel = 'view' | 'edit' | 'hidden'
 *   type FieldPermissions = Record<Role, FieldPermissionLevel>
 *
 *   canViewField(permissions: FieldPermissions, role: Role): boolean
 *     -> true unless permissions[role] === 'hidden'
 *
 *   canEditField(permissions: FieldPermissions, role: Role): boolean
 *     -> true only if permissions[role] === 'edit'
 */

const ROLES: Role[] = ['owner', 'admin', 'member', 'guest'];
const LEVELS: FieldPermissionLevel[] = ['view', 'edit', 'hidden'];

function uniformPermissions(level: FieldPermissionLevel): FieldPermissions {
  return { owner: level, admin: level, member: level, guest: level };
}

describe('canViewField (all role x level combinations)', () => {
  it.each(
    ROLES.flatMap((role) => LEVELS.map((level) => ({ role, level, expected: level !== 'hidden' }))),
  )('role=$role level=$level -> $expected', ({ role, level, expected }) => {
    expect(canViewField(uniformPermissions(level), role)).toBe(expected);
  });
});

describe('canEditField (all role x level combinations)', () => {
  it.each(
    ROLES.flatMap((role) => LEVELS.map((level) => ({ role, level, expected: level === 'edit' }))),
  )('role=$role level=$level -> $expected', ({ role, level, expected }) => {
    expect(canEditField(uniformPermissions(level), role)).toBe(expected);
  });
});

describe('a realistic mixed permissions map (per-role levels differ)', () => {
  const permissions: FieldPermissions = {
    owner: 'edit',
    admin: 'edit',
    member: 'view',
    guest: 'hidden',
  };

  it('owner can view and edit', () => {
    expect(canViewField(permissions, 'owner')).toBe(true);
    expect(canEditField(permissions, 'owner')).toBe(true);
  });

  it('admin can view and edit', () => {
    expect(canViewField(permissions, 'admin')).toBe(true);
    expect(canEditField(permissions, 'admin')).toBe(true);
  });

  it('member can view but not edit', () => {
    expect(canViewField(permissions, 'member')).toBe(true);
    expect(canEditField(permissions, 'member')).toBe(false);
  });

  it('guest can neither view nor edit (hidden)', () => {
    expect(canViewField(permissions, 'guest')).toBe(false);
    expect(canEditField(permissions, 'guest')).toBe(false);
  });
});
