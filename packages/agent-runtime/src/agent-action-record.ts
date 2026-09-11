import type { Actor } from '@luminaos/shared';

/**
 * v0 concrete types for the unified agent action ledger ("Flight Recorder"),
 * per ADR-0038 Karar (a)/(b). This module is deliberately plain
 * types/interfaces plus a handful of pure factory helpers — no framework
 * imports, mirrors `agent-permission-manifest.ts`'s style.
 */

/**
 * `'decided'` — a human approved the action via `decide()`
 * (`executeDecidedAction`); `'autonomous'` — the agent acted on its own under
 * its own permission manifest (mention → skill execution, ADR-0037 Karar d).
 */
export type ActionProvenance = 'decided' | 'autonomous';

/**
 * Maps the two source outcome vocabularies (`DecideActionResult.status` and
 * `AgentActionResult.outcome`) onto one shared vocabulary — see ADR-0038
 * Karar (b) for the exact mapping table.
 */
export type AgentActionOutcome = 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';

/**
 * A resource's TYPE plus its concrete identity — never a bare string.
 * `'external'` exists to explicitly label a structurally-unresolvable
 * resource (e.g. a Slack channel name mentioned by the AI) instead of
 * silently dropping it.
 */
export type ActionResourceReference =
  | { kind: 'object'; objectId: string }
  | { kind: 'comment'; commentId: string }
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'agent'; agentIdentifier: string }
  | { kind: 'external'; label: string };

/**
 * A structural, machine-readable DESCRIPTION of how to reverse an action —
 * per ADR-0038 Karar (g), this record does not itself execute any reversal;
 * that is F3-T6's scope.
 */
export interface RollbackPlan {
  kind: 'delete' | 'revertFieldValue' | 'revokePermission' | 'manual' | 'none';
  targetResource?: ActionResourceReference;
  description: string;
}

/**
 * The unified ledger entry, per ADR-0038 Karar (b). This is the first ADR to
 * actually ENFORCE CLAUDE.md's `{niyet, gerekçe, kaynaklar[], geri_alma_planı}`
 * agent-action contract, rather than merely not violating it.
 */
export interface AgentActionRecord {
  id: string;
  workspaceId: string;
  provenance: ActionProvenance;
  actor: Actor;
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: AgentActionOutcome;
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
  occurredAt: Date;
  /** F3-T6 (ADR-0040 Karar c): null on every normal record; on an
   * undo-shaped record (`actionType === 'undoAction'`, PR2's scope), the
   * ORIGINAL record's own `id` — never the reverse, the original row is
   * never mutated. */
  undoesRecordId: string | null;
}

export function objectResource(objectId: string): ActionResourceReference {
  return { kind: 'object', objectId };
}

export function commentResource(commentId: string): ActionResourceReference {
  return { kind: 'comment', commentId };
}

export function meetingResource(meetingId: string): ActionResourceReference {
  return { kind: 'meeting', meetingId };
}

export function agentResource(agentIdentifier: string): ActionResourceReference {
  return { kind: 'agent', agentIdentifier };
}

export function externalResource(label: string): ActionResourceReference {
  return { kind: 'external', label };
}
