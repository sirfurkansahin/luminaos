import { describe, expect, it } from 'vitest';

import { hasAtLeastRole, type MembershipRole } from './membership.util.js';

describe('hasAtLeastRole', () => {
  it('returns true when the role outranks the minimum (owner satisfies admin minimum)', () => {
    expect(hasAtLeastRole('owner', 'admin')).toBe(true);
  });

  it('returns false when the role is outranked by the minimum (admin does not satisfy owner minimum)', () => {
    expect(hasAtLeastRole('admin', 'owner')).toBe(false);
  });

  it('returns true when the role exactly equals the minimum (inclusive comparison)', () => {
    expect(hasAtLeastRole('member', 'member')).toBe(true);
  });

  it('returns false when the role ranks below the minimum (guest does not satisfy member minimum)', () => {
    expect(hasAtLeastRole('guest', 'member')).toBe(false);
  });

  it('returns true when the role is the top rank and the minimum is the lowest rank (owner satisfies guest minimum)', () => {
    expect(hasAtLeastRole('owner', 'guest')).toBe(true);
  });

  it('accepts all four MembershipRole values as valid arguments', () => {
    const roles: MembershipRole[] = ['owner', 'admin', 'member', 'guest'];

    for (const role of roles) {
      expect(typeof hasAtLeastRole(role, 'guest')).toBe('boolean');
    }
  });
});
