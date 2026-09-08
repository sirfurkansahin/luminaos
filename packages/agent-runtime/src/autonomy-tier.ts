import type { Actor } from '@luminaos/shared';

/**
 * F3-T5 (ADR-0039 Karar b/c): per-`(workspaceId, actionType)` autonomy tier
 * — "propose" (a human must call `decide()`, today's only behavior),
 * "approve_and_act" (the system auto-invokes `decide()`, which itself is
 * unchanged), or "act_and_notify" (`decide()`/`command_proposals`/
 * `ActionsDecided` are bypassed entirely — the distinguishing feature versus
 * `approve_and_act`).
 */
export type AutonomyTier = 'propose' | 'approve_and_act' | 'act_and_notify';

/**
 * Only for "does this tier skip human approval" comparisons — not a business
 * hierarchy, just a way to express that `propose` is the single distinguished
 * "human still decides" tier.
 */
export const AUTONOMY_TIER_RANK: Record<AutonomyTier, number> = {
  propose: 0,
  approve_and_act: 1,
  act_and_notify: 2,
};

export function isAutoDecidable(tier: AutonomyTier): boolean {
  return tier !== 'propose';
}

/**
 * Action types in this list can NEVER be set to a tier other than
 * `'propose'` — a governance floor (ADR-0039 Karar c, the architecture's own
 * inference from ADR-0037 §f's "decide() tek boğaz noktası" decision, not
 * dictated by the human). Extensible: a future governance-sensitive action
 * type is added here, nowhere else needs to change.
 */
export const AUTONOMY_GOVERNANCE_FLOOR: readonly string[] = ['reconfigureAgentPermissions'];

export interface TaskAutonomySetting {
  id: string;
  workspaceId: string;
  actionType: string;
  tier: AutonomyTier;
  updatedBy: Actor;
  updatedAt: Date;
}
