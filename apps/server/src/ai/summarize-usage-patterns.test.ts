import { describe, expect, it } from 'vitest';

import type { ScheduleSpec, Trigger } from '@luminaos/automation';

import { summarizeUsagePatterns } from './summarize-usage-patterns.js';

import type { UsagePatternSummary } from './summarize-usage-patterns.js';
import type { CommandProposalSummary } from '../commands/commands.service.js';

/**
 * F2-T17 PR1 (RED step) — `summarizeUsagePatterns`, a NEW, pure, DB-free
 * function per ADR-0034 Karar (e): turns `AutomationTriggersService.list()`'s
 * `Trigger[]` + `CommandsService.listProposals()`'s `CommandProposalSummary[]`
 * into a BOUNDED-size summary safe to embed in an LLM prompt — NEVER a raw
 * history dump (ADR-0034's "Mimari Değişmezlerle İlişki" section, hassas veri
 * sınıflarının buluta ham gönderilmemesi).
 *
 * Designed contract (must be matched exactly by `implementer` --
 * `./summarize-usage-patterns.ts` does not exist yet on this branch):
 *
 *   export interface UsagePatternSummaryInput {
 *     activeTriggers: Trigger[];
 *     decidedProposals: CommandProposalSummary[];
 *   }
 *
 *   export interface UsagePatternGroup {
 *     actionType: string;
 *     outcome: 'approved' | 'rejected' | 'mixed';
 *     count: number;
 *     exampleCommands: string[]; // at most 3, each truncated
 *   }
 *
 *   export interface UsagePatternSummary {
 *     activeTriggerSummaries: string[];
 *     groups: UsagePatternGroup[];
 *   }
 *
 *   export function summarizeUsagePatterns(
 *     input: UsagePatternSummaryInput,
 *   ): UsagePatternSummary;
 *
 * Grouping contract pinned by the tests below:
 *  - Each proposal's `actions` (an array, possibly containing MULTIPLE
 *    action objects of DIFFERENT `type`s) contributes ONE tally increment
 *    PER ACTION to the `(actionType, outcome)` group that action's own type
 *    + derived outcome identifies — a single proposal with 2 different
 *    action types contributes independently to 2 different groups.
 *  - `outcome` is derived by matching the action's `actionId` against the
 *    proposal's `decisions` array. This test file pins a REASONABLE,
 *    documented status→outcome mapping (not otherwise specified down to the
 *    exact literal by the ADR): `'executed'` → `'approved'`, `'rejected'` →
 *    `'rejected'`, `'failed'` / `'partially_executed'` → `'mixed'`.
 *  - Counts tally correctly across MULTIPLE proposals landing in the same
 *    group.
 *  - `exampleCommands` never exceeds 3 entries per group, and each entry is
 *    truncated to a bounded length (this file assumes ~200 chars, per the
 *    task brief); a short command must pass through completely unmodified.
 *  - `activeTriggerSummaries` has exactly one string per input trigger, and
 *    that string must NEVER be (or contain) `JSON.stringify` of the
 *    trigger's raw `spec` — it must be a human-readable one-liner.
 *  - Empty input (`[]`/`[]`) produces `{ activeTriggerSummaries: [], groups:
 *    [] }` without crashing.
 *
 * Nothing under test here exists yet: `./summarize-usage-patterns.ts` has not
 * been written -- every assertion below is expected to fail with a
 * module-not-found error until `implementer` adds it.
 */

function makeScheduledTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trig-scheduled-1',
    workspaceId: 'ws-1',
    name: 'Daily digest',
    kind: 'scheduled',
    spec: {
      kind: 'scheduled',
      intervalMinutes: 90,
      actionTemplate: { title: 'Send daily digest' },
    },
    lastFiredAt: null,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeConditionTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trig-condition-1',
    workspaceId: 'ws-1',
    name: 'Flag urgent tasks',
    kind: 'condition',
    spec: {
      kind: 'condition',
      objectType: 'task',
      fieldKey: 'title',
      pattern: 'urgent',
      flags: 'i',
      actionTemplate: { title: 'Flag as urgent' },
    },
    lastFiredAt: null,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * A single decided `command_proposals` row, with `actions`/`decisions` set
 * to the shapes those `unknown`-typed columns ACTUALLY carry at runtime
 * (`ProposedAction[]` / `DecideActionResult[]`, per `parse-command.ts` /
 * `commands.service.ts`) — `CommandProposalSummary` itself types them as
 * `unknown` (a direct copy of the jsonb columns), so this helper is the
 * closest thing to a real production row this pure-unit test can construct.
 */
function makeProposal(overrides: Partial<CommandProposalSummary> = {}): CommandProposalSummary {
  return {
    id: 'proposal-1',
    workspaceId: 'ws-1',
    command: 'Create a follow-up task for the onboarding checklist',
    sourceObjectId: null,
    actions: [
      {
        actionId: 'action-1',
        type: 'createTask',
        intent: 'Create a follow-up task',
        rationale: 'The command asked for it',
        resources: [],
        rollbackNote: 'Delete the task',
        params: {},
      },
    ],
    decisions: [{ actionId: 'action-1', status: 'executed' }],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    decidedAt: new Date('2026-01-01T01:00:00Z'),
    ...overrides,
  };
}

describe('summarizeUsagePatterns — empty input', () => {
  it('returns { activeTriggerSummaries: [], groups: [] } without crashing when both arrays are empty', () => {
    const result: UsagePatternSummary = summarizeUsagePatterns({
      activeTriggers: [],
      decidedProposals: [],
    });

    expect(result).toEqual({ activeTriggerSummaries: [], groups: [] });
  });
});

describe('summarizeUsagePatterns — (actionType, outcome) grouping and outcome derivation', () => {
  it("a single proposal's single 'executed' action produces one group with outcome 'approved', count 1, and the proposal's command as the sole example", () => {
    const result = summarizeUsagePatterns({
      activeTriggers: [],
      decidedProposals: [makeProposal()],
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toEqual({
      actionType: 'createTask',
      outcome: 'approved',
      count: 1,
      exampleCommands: ['Create a follow-up task for the onboarding checklist'],
    });
  });

  it("an action whose matched decision status is 'rejected' produces outcome 'rejected'", () => {
    const result = summarizeUsagePatterns({
      activeTriggers: [],
      decidedProposals: [
        makeProposal({
          command: 'Assign this to Jane',
          actions: [
            {
              actionId: 'action-1',
              type: 'assignPeople',
              intent: 'Assign to Jane',
              rationale: 'Explicitly requested',
              resources: [],
              rollbackNote: 'Unassign',
              params: {},
            },
          ],
          decisions: [{ actionId: 'action-1', status: 'rejected' }],
        }),
      ],
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.actionType).toBe('assignPeople');
    expect(result.groups[0]?.outcome).toBe('rejected');
    expect(result.groups[0]?.count).toBe(1);
  });

  it("'failed' and 'partially_executed' decision statuses BOTH map to outcome 'mixed' and TALLY INTO THE SAME group (actionType, 'mixed') across two separate proposals", () => {
    const failedProposal = makeProposal({
      id: 'proposal-failed',
      command: 'Generate subtasks for the roadmap epic',
      actions: [
        {
          actionId: 'action-1',
          type: 'generateSubtasks',
          intent: 'Generate subtasks',
          rationale: 'Requested',
          resources: [],
          rollbackNote: 'Delete subtasks',
          params: {},
        },
      ],
      decisions: [{ actionId: 'action-1', status: 'failed', error: 'boom' }],
    });
    const partiallyExecutedProposal = makeProposal({
      id: 'proposal-partial',
      command: 'Generate subtasks for the launch epic',
      actions: [
        {
          actionId: 'action-1',
          type: 'generateSubtasks',
          intent: 'Generate subtasks',
          rationale: 'Requested',
          resources: [],
          rollbackNote: 'Delete subtasks',
          params: {},
        },
      ],
      decisions: [
        { actionId: 'action-1', status: 'partially_executed', createdCount: 1, totalCount: 3 },
      ],
    });

    const result = summarizeUsagePatterns({
      activeTriggers: [],
      decidedProposals: [failedProposal, partiallyExecutedProposal],
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.actionType).toBe('generateSubtasks');
    expect(result.groups[0]?.outcome).toBe('mixed');
    expect(result.groups[0]?.count).toBe(2);
  });

  it('a single proposal whose actions array contains TWO DIFFERENT action types contributes INDEPENDENTLY to TWO different groups, each carrying the SAME proposal command as an example', () => {
    const proposal = makeProposal({
      command: 'Create a task and assign it to Jane',
      actions: [
        {
          actionId: 'action-1',
          type: 'createTask',
          intent: 'Create a task',
          rationale: 'Requested',
          resources: [],
          rollbackNote: 'Delete task',
          params: {},
        },
        {
          actionId: 'action-2',
          type: 'assignPeople',
          intent: 'Assign to Jane',
          rationale: 'Requested',
          resources: [],
          rollbackNote: 'Unassign',
          params: {},
        },
      ],
      decisions: [
        { actionId: 'action-1', status: 'executed' },
        { actionId: 'action-2', status: 'executed' },
      ],
    });

    const result = summarizeUsagePatterns({ activeTriggers: [], decidedProposals: [proposal] });

    expect(result.groups).toHaveLength(2);
    const actionTypes = result.groups.map((group) => group.actionType).sort();
    expect(actionTypes).toEqual(['assignPeople', 'createTask']);

    for (const group of result.groups) {
      expect(group.outcome).toBe('approved');
      expect(group.count).toBe(1);
      expect(group.exampleCommands).toEqual(['Create a task and assign it to Jane']);
    }
  });

  it('counts tally correctly across MULTIPLE proposals contributing to the SAME (actionType, outcome) group', () => {
    const proposals = [
      makeProposal({ id: 'p1', command: 'Create task A' }),
      makeProposal({ id: 'p2', command: 'Create task B' }),
      makeProposal({ id: 'p3', command: 'Create task C' }),
    ];

    const result = summarizeUsagePatterns({ activeTriggers: [], decidedProposals: proposals });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.count).toBe(3);
  });
});

describe('summarizeUsagePatterns — exampleCommands: capped at 3, truncated to a bounded length', () => {
  it('never includes more than 3 exampleCommands per group even when 5 proposals land in the same group', () => {
    const proposals = Array.from({ length: 5 }, (_, index) =>
      makeProposal({ id: `p${String(index)}`, command: `Create task number ${String(index)}` }),
    );

    const result = summarizeUsagePatterns({ activeTriggers: [], decidedProposals: proposals });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.exampleCommands.length).toBeLessThanOrEqual(3);
    expect(result.groups[0]?.exampleCommands.length).toBe(3);
  });

  it('truncates a long command to a bounded length (~200 chars) in exampleCommands', () => {
    const longCommand = 'Create a task '.repeat(50); // far longer than 200 chars
    expect(longCommand.length).toBeGreaterThan(200);

    const result = summarizeUsagePatterns({
      activeTriggers: [],
      decidedProposals: [makeProposal({ command: longCommand })],
    });

    const [example] = result.groups[0]?.exampleCommands ?? [];
    expect(example).toBeDefined();
    expect(example?.length).toBeLessThanOrEqual(200);
    expect(longCommand.startsWith(example ?? '')).toBe(true);
    expect(example).not.toBe(longCommand);
  });

  it('passes a short command through completely unmodified in exampleCommands', () => {
    const shortCommand = 'Create a task';

    const result = summarizeUsagePatterns({
      activeTriggers: [],
      decidedProposals: [makeProposal({ command: shortCommand })],
    });

    expect(result.groups[0]?.exampleCommands).toEqual([shortCommand]);
  });
});

describe('summarizeUsagePatterns — activeTriggerSummaries: one human-readable line per trigger, NEVER a raw spec dump', () => {
  it('produces exactly one summary string per input trigger', () => {
    const result = summarizeUsagePatterns({
      activeTriggers: [makeScheduledTrigger(), makeConditionTrigger()],
      decidedProposals: [],
    });

    expect(result.activeTriggerSummaries).toHaveLength(2);
  });

  it('a scheduled trigger summary line mentions intervalMinutes but is never a JSON.stringify round-trip of the raw spec', () => {
    const trigger = makeScheduledTrigger();

    const result = summarizeUsagePatterns({
      activeTriggers: [trigger],
      decidedProposals: [],
    });

    const [line] = result.activeTriggerSummaries;
    expect(line).toBeDefined();
    if (trigger.spec.kind === 'scheduled') {
      expect(line).toContain(String((trigger.spec satisfies ScheduleSpec).intervalMinutes));
    }
    expect(line).not.toContain(JSON.stringify(trigger.spec));
    expect(line).not.toBe(JSON.stringify(trigger));
  });

  it('a condition trigger summary line mentions objectType/fieldKey but is never a JSON.stringify round-trip of the raw spec', () => {
    const trigger = makeConditionTrigger();

    const result = summarizeUsagePatterns({
      activeTriggers: [trigger],
      decidedProposals: [],
    });

    const [line] = result.activeTriggerSummaries;
    expect(line).toBeDefined();
    if (trigger.spec.kind === 'condition') {
      expect(line).toContain(trigger.spec.objectType);
      expect(line).toContain(trigger.spec.fieldKey);
    }
    expect(line).not.toContain(JSON.stringify(trigger.spec));
    expect(line).not.toBe(JSON.stringify(trigger));
  });
});
