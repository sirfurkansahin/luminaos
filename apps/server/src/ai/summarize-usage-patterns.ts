import { z } from 'zod';

import type { Trigger } from '@luminaos/automation';

import { proposedActionSchema } from './parse-command.js';

import type { CommandProposalSummary } from '../commands/commands.service.js';

/**
 * Security-review finding (F2-T17 PR1): `CommandProposalSummary.actions`/
 * `.decisions` are typed `unknown` precisely because they are raw jsonb
 * columns with no runtime shape guarantee (`commands.service.ts`'s own doc
 * comment). A blind `as ProposedAction[]`/`as DecideActionResult[]` cast
 * would crash this ENTIRE function on one malformed/legacy row. Mirrors
 * `commands.service.ts:543`'s own established discipline
 * (`decidableActionSchema.safeParse(rawAction)` before trusting a jsonb
 * action) -- reuses the exported `proposedActionSchema.element` (extended
 * with `actionId`, which `parseCommand` mints onto every action after ITS
 * own validation) rather than inventing a second, driftable action schema.
 * A row that fails validation is defensively skipped (never thrown), same
 * fail-soft posture as `decide()`'s own re-validation.
 */
const decidableActionShapeSchema = proposedActionSchema.element.extend({
  actionId: z.string(),
});

const decisionShapeSchema = z.object({
  actionId: z.string(),
  status: z.enum(['executed', 'rejected', 'failed', 'partially_executed']),
});

type DecisionShape = z.infer<typeof decisionShapeSchema>;

/**
 * `summarizeUsagePatterns` (ADR-0034 Karar (e)): a PURE, DB-free function
 * that turns `AutomationTriggersService.list()`'s `Trigger[]` +
 * `CommandsService.listProposals()`'s `CommandProposalSummary[]` into a
 * BOUNDED-size summary safe to embed in an LLM prompt -- NEVER a raw history
 * dump (ADR-0034's "Mimari Değişmezlerle İlişki" section: hassas veri
 * sınıflarının buluta ham gönderilmemesi). The output must never contain a
 * `JSON.stringify` of a trigger's raw `spec`, or a proposal's full,
 * untruncated `command`/`params`.
 */
export interface UsagePatternSummaryInput {
  activeTriggers: Trigger[];
  decidedProposals: CommandProposalSummary[];
}

export interface UsagePatternGroup {
  actionType: string;
  outcome: 'approved' | 'rejected' | 'mixed';
  count: number;
  exampleCommands: string[];
}

export interface UsagePatternSummary {
  activeTriggerSummaries: string[];
  groups: UsagePatternGroup[];
}

/** Bounds each `exampleCommands` entry so the prompt built from this summary never carries an unbounded string. */
const EXAMPLE_COMMAND_MAX_LENGTH = 200;
/** Bounds the number of representative example commands kept per `(actionType, outcome)` group. */
const MAX_EXAMPLE_COMMANDS_PER_GROUP = 3;

/**
 * `'executed'` → `'approved'`, `'rejected'` → `'rejected'`, `'failed'` /
 * `'partially_executed'` → `'mixed'` -- a reasonable, documented mapping not
 * otherwise pinned down to the exact literal by the ADR itself.
 */
function toOutcome(status: DecisionShape['status']): UsagePatternGroup['outcome'] {
  switch (status) {
    case 'executed':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'failed':
    case 'partially_executed':
      return 'mixed';
  }
}

function truncateCommand(command: string): string {
  return command.length > EXAMPLE_COMMAND_MAX_LENGTH
    ? command.slice(0, EXAMPLE_COMMAND_MAX_LENGTH)
    : command;
}

function summarizeTrigger(trigger: Trigger): string {
  if (trigger.spec.kind === 'scheduled') {
    return `Scheduled trigger "${trigger.name}" fires every ${String(trigger.spec.intervalMinutes)} minutes`;
  }

  return `Condition trigger "${trigger.name}": ${trigger.spec.objectType}.${trigger.spec.fieldKey} matches /${trigger.spec.pattern}/${trigger.spec.flags}`;
}

export function summarizeUsagePatterns(input: UsagePatternSummaryInput): UsagePatternSummary {
  const groupsByKey = new Map<
    string,
    {
      actionType: string;
      outcome: UsagePatternGroup['outcome'];
      count: number;
      exampleCommands: string[];
    }
  >();

  for (const proposal of input.decidedProposals) {
    const rawActions = Array.isArray(proposal.actions) ? proposal.actions : [];
    const rawDecisions = Array.isArray(proposal.decisions) ? proposal.decisions : [];

    const decisions: DecisionShape[] = [];
    for (const rawDecision of rawDecisions) {
      const parsedDecision = decisionShapeSchema.safeParse(rawDecision);
      if (parsedDecision.success) {
        decisions.push(parsedDecision.data);
      }
    }

    for (const rawAction of rawActions) {
      const parsedAction = decidableActionShapeSchema.safeParse(rawAction);
      if (!parsedAction.success) {
        continue;
      }
      const action = parsedAction.data;

      const decision = decisions.find((candidate) => candidate.actionId === action.actionId);

      if (decision === undefined) {
        continue;
      }

      const outcome = toOutcome(decision.status);
      const key = `${action.type}:${outcome}`;
      const existing = groupsByKey.get(key);

      if (existing === undefined) {
        groupsByKey.set(key, {
          actionType: action.type,
          outcome,
          count: 1,
          exampleCommands: [truncateCommand(proposal.command)],
        });
      } else {
        existing.count += 1;
        if (existing.exampleCommands.length < MAX_EXAMPLE_COMMANDS_PER_GROUP) {
          existing.exampleCommands.push(truncateCommand(proposal.command));
        }
      }
    }
  }

  return {
    activeTriggerSummaries: input.activeTriggers.map(summarizeTrigger),
    groups: [...groupsByKey.values()],
  };
}
