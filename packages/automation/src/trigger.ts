/**
 * F2-T15 PR1 — a workspace-wide automation trigger (ADR-0032 Karar i/l): a
 * discriminated `ScheduleSpec | ConditionSpec` union stored in the `spec`
 * jsonb column of `automation_triggers` (ADR-0032 Şema Taslağı). Mirrors
 * `saved-view.ts`'s structural discipline (plain data shapes, an
 * `*EventDraft` shape for not-yet-wrapped domain events).
 */
export type TriggerLifecycle = 'active' | 'deleted';

export interface ActionTemplate {
  title: string;
}

export interface ScheduleSpec {
  kind: 'scheduled';
  intervalMinutes: number;
  actionTemplate: ActionTemplate;
}

/**
 * SECURITY INVARIANT (security-review finding, F2-T15 PR1): `pattern`/`flags`
 * are validated by `assertSafeRegexPattern` (`regex-safety.ts`) ONLY at
 * write-time (`trigger-commands.ts`'s `createTrigger`/`updateTrigger`) --
 * `trigger-replay.ts` folds a `TriggerCreated`/`TriggerUpdated` event's
 * `spec` by SHAPE only (`typeof`/known-`kind` checks), never re-running the
 * regex-safety check, mirroring `saved-view-replay.ts`'s own discipline of
 * validating shape but not business invariants during replay. A corrupted
 * event (raw DB edit, future producer bug) could therefore reconstitute a
 * `ConditionSpec` whose `pattern`/`flags` were never safety-checked.
 *
 * `evaluateCondition` (`condition-evaluator.ts`) is the ONLY sanctioned
 * consumer of `ConditionSpec.pattern`/`flags` for this reason -- it
 * defensively re-validates and fails closed (`false`, never throws) rather
 * than trusting a `Trigger`'s stored spec. Any FUTURE code that constructs a
 * `RegExp` directly from `Trigger.spec.pattern`/`flags` (an admin "test this
 * trigger" feature, a debug endpoint, etc.) MUST go through
 * `assertSafeRegexPattern`/`evaluateCondition` first, never `new RegExp(...)`
 * on the raw stored value.
 */
export interface ConditionSpec {
  kind: 'condition';
  objectType: string;
  fieldKey: string;
  pattern: string;
  flags: string;
  actionTemplate: ActionTemplate;
}

export type TriggerSpec = ScheduleSpec | ConditionSpec;

export interface Trigger {
  id: string;
  workspaceId: string;
  name: string;
  kind: TriggerSpec['kind'];
  spec: TriggerSpec;
  lastFiredAt: Date | null;
  lifecycle: TriggerLifecycle;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A draft of a trigger domain event, not yet wrapped into the F0-T6
 * `NewDomainEvent` envelope — same shape as `SavedViewEventDraft`.
 */
export interface TriggerEventDraft {
  type: string;
  payload: Record<string, unknown>;
}
