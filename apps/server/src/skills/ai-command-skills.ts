import { generateKeyPairSync } from 'node:crypto';

import { z } from 'zod';

import type { Actor } from '@luminaos/shared';
import { ValidationError } from '@luminaos/shared';
import { signSkillManifest } from '@luminaos/skill-sdk';
import type { Skill, SkillManifest } from '@luminaos/skill-sdk';

import type { CommandsService } from '../commands/commands.service.js';
import type { QAService } from '../qa/qa.service.js';
import type { TriggerSuggestionsService } from '../trigger-suggestions/trigger-suggestions.service.js';

/**
 * F3-T2 PR5, ADR-0036 — catalog #16-20 (spec table), the LAST 5 first-party
 * skills of the Skill SDK v1 feature: `answer-question` (`QAService.answer`),
 * `parse-command` (`CommandsService.parse`), `propose-actions-from-meeting`
 * (`CommandsService.proposeFromMeeting`), `run-trigger-suggestion-analysis`
 * (`TriggerSuggestionsService.runAnalysis`), `list-command-proposals`
 * (`CommandsService.listProposals`). Same conventions as PR3's
 * `object-skills.ts` / PR4's `meeting-recurrence-skills.ts` (fixed
 * `actor = {type:'agent', id: agentIdentifier}`, `parseSkillInput`+zod
 * validation, Ed25519-signed manifests via `signSkillManifest`).
 *
 * VALIDATION: every skill below uses a SINGLE, unified `.loose()` zod schema
 * validating `workspaceId`/`agentIdentifier` AND its own body fields together
 * in ONE `safeParse` call — never a split context+strict-body two-parse
 * pattern (that pattern always fails with `unrecognized_keys` once
 * `SkillExecutionService.executeSkill` injects `workspaceId`/`agentIdentifier`
 * into the SAME `input` object a `.strict()` body schema is parsed against —
 * the bug class `object-skills.ts` got wrong 8 times across 3 PRs before
 * being fixed).
 */

function actorFromAgentIdentifier(agentIdentifier: string): Actor {
  return { type: 'agent', id: agentIdentifier };
}

function parseSkillInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ValidationError('Invalid skill input', { issues: result.error.issues });
  }

  return result.data;
}

/**
 * A fresh Ed25519 keypair generated once, at this module's own load time --
 * same known, temporary gap as `object-skills.ts`/`meeting-recurrence-skills.
 * ts` (no private key matching the checked-in canonical
 * `SKILL_SDK_PUBLIC_KEY_PEM` exists anywhere in this repo).
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

/** The public half of this module's own signing keypair, exported so the skills module can register these 5 skills against the key they were ACTUALLY signed with. */
export const AI_COMMAND_SKILLS_SIGNING_PUBLIC_KEY_PEM = publicKey.export({
  type: 'spki',
  format: 'pem',
});

const AI_COMMAND_SKILLS_SIGNING_PRIVATE_KEY_PEM = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

function signManifest(id: string, capability: string): SkillManifest {
  const unsigned = { id, version: '1.0.0', capability };
  return {
    ...unsigned,
    signature: signSkillManifest(unsigned, AI_COMMAND_SKILLS_SIGNING_PRIVATE_KEY_PEM),
  };
}

const answerQuestionInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    agentIdentifier: z.string().min(1),
    question: z.string().min(1),
  })
  .loose();

export function buildAnswerQuestionSkill(qaService: QAService): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'answer-question',
      'Answers a natural-language question using retrieval-augmented generation over the workspace.',
    ),
    execute: async (input: unknown) => {
      const context = parseSkillInput(answerQuestionInputSchema, input);

      return qaService.answer(context.workspaceId, context.question);
    },
  };
}

const parseCommandInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    agentIdentifier: z.string().min(1),
    command: z.string().min(1),
    sourceObjectId: z.string().min(1).optional(),
  })
  .loose();

export function buildParseCommandSkill(commandsService: CommandsService): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'parse-command',
      'Parses a natural-language command into a proposed set of actions (never a direct mutation).',
    ),
    execute: async (input: unknown) => {
      const context = parseSkillInput(parseCommandInputSchema, input);

      return commandsService.parse(
        context.workspaceId,
        actorFromAgentIdentifier(context.agentIdentifier),
        context.command,
        context.sourceObjectId,
      );
    },
  };
}

const proposeActionsFromMeetingInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    agentIdentifier: z.string().min(1),
    meetingObjectId: z.string().min(1),
    transcriptText: z.string().min(1),
  })
  .loose();

export function buildProposeActionsFromMeetingSkill(
  commandsService: CommandsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'propose-actions-from-meeting',
      'Extracts a proposed set of actions from a meeting transcript.',
    ),
    execute: async (input: unknown) => {
      const context = parseSkillInput(proposeActionsFromMeetingInputSchema, input);

      return commandsService.proposeFromMeeting(
        context.workspaceId,
        context.meetingObjectId,
        context.transcriptText,
      );
    },
  };
}

const runTriggerSuggestionAnalysisInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    agentIdentifier: z.string().min(1),
  })
  .loose();

export function buildRunTriggerSuggestionAnalysisSkill(
  triggerSuggestionsService: TriggerSuggestionsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'run-trigger-suggestion-analysis',
      'Runs AI trigger-template suggestion analysis for the workspace.',
    ),
    execute: async (input: unknown) => {
      const context = parseSkillInput(runTriggerSuggestionAnalysisInputSchema, input);

      // SECURITY NOTE: unlike every other skill in this codebase (fixed
      // `CALLER_ROLE = 'member'`), this fixed `callerRole` is deliberately
      // `'admin'` -- `TriggerSuggestionsService.runAnalysis` itself hard-
      // rejects (`ForbiddenError`) anything below `admin`. Same reasoning as
      // `object-skills.ts`'s own fixed `CALLER_ROLE` doc comment: this only
      // satisfies the wrapped service's own technical RBAC parameter, real
      // authorization is the agent permission manifest, already checked by
      // `executeSkill` before `execute` ever runs.
      return triggerSuggestionsService.runAnalysis(
        context.workspaceId,
        actorFromAgentIdentifier(context.agentIdentifier),
        'admin',
      );
    },
  };
}

const listCommandProposalsInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    agentIdentifier: z.string().min(1),
    filter: z
      .object({
        pendingOnly: z.boolean().optional(),
        limit: z.number().optional(),
        cursor: z.string().min(1).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export function buildListCommandProposalsSkill(
  commandsService: CommandsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'list-command-proposals',
      'Lists command proposals for the workspace, optionally filtered/paginated.',
    ),
    execute: async (input: unknown) => {
      const context = parseSkillInput(listCommandProposalsInputSchema, input);
      // `exactOptionalPropertyTypes` -- built conditionally (mirroring
      // `object-skills.ts`'s `buildSetRecurrenceRuleSkill`), since zod's
      // `.optional()` types each field as `T | undefined`, not the plain
      // `T?` shape `CommandsService.listProposals`'s own `filter` parameter
      // declares.
      const filter = context.filter
        ? {
            ...(context.filter.pendingOnly !== undefined
              ? { pendingOnly: context.filter.pendingOnly }
              : {}),
            ...(context.filter.limit !== undefined ? { limit: context.filter.limit } : {}),
            ...(context.filter.cursor !== undefined ? { cursor: context.filter.cursor } : {}),
          }
        : undefined;

      return commandsService.listProposals(context.workspaceId, 'member', filter);
    },
  };
}
