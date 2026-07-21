export type MembershipRole = 'owner' | 'admin' | 'member' | 'guest';

const ROLE_RANK: Record<MembershipRole, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function hasAtLeastRole(role: MembershipRole, minimum: MembershipRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
