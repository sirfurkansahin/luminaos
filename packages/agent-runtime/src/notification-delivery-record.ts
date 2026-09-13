/**
 * F3-T13 PR1 (ADR-0047 Karar d): the "context-switch counter" domain --
 * `NotificationDeliveryRecord` is a plain interface with zero runtime
 * behavior, mirrors `AgentActionRecord`'s style (no framework imports).
 */

/**
 * `'delivered'` — the notification was actually sent (counts toward the
 * context-switch counter). `'suppressed_quiet_hours'`/
 * `'suppressed_budget_exceeded'` — dropped entirely, never delivered later
 * (ADR-0047 Karar e), and NEVER counted toward the counter (ADR-0047 Karar
 * d).
 */
export type NotificationDeliveryOutcome =
  'delivered' | 'suppressed_quiet_hours' | 'suppressed_budget_exceeded';

export interface NotificationDeliveryRecord {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  actionType: string;
  sourceObjectId: string;
  outcome: NotificationDeliveryOutcome;
  /** Non-null only when `outcome === 'delivered'`. */
  commentId: string | null;
  occurredAt: Date;
}
