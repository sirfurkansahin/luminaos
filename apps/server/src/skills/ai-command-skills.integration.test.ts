import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import type { EmbeddingProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import { ForbiddenError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';
import type { SkillRegistry } from '@luminaos/skill-sdk';

import { EMBEDDING_PROVIDER } from '../ai/embedding-provider.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { commandProposals } from '../db/schema/command-proposals.js';
import { searchIndex } from '../db/schema/search-index.js';
import { triggerSuggestionAnalysisState } from '../db/schema/trigger-suggestion-analysis-state.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T2 PR5 (RED step), ADR-0036 — `apps/server/src/skills/
 * ai-command-skills.ts`: catalog #16-20 (spec table), the LAST 5 first-party
 * skills of the Skill SDK v1 feature -- `answer-question` (`QAService.answer`),
 * `parse-command` (`CommandsService.parse`), `propose-actions-from-meeting`
 * (`CommandsService.proposeFromMeeting`), `run-trigger-suggestion-analysis`
 * (`TriggerSuggestionsService.runAnalysis`), `list-command-proposals`
 * (`CommandsService.listProposals`). Each a thin wrapper, same conventions as
 * PR3's `object-skills.ts` / PR4's `meeting-recurrence-skills.ts` /
 * `context-search-calendar-skills.ts` (fixed `CALLER_ROLE` where a technical
 * role param is needed at all, `actor = {type:'agent', id: agentIdentifier}`,
 * a SINGLE unified `.loose()` zod schema per skill -- see this task's own
 * bug-class warning about the split context+strict-body two-parse pattern
 * `object-skills.ts` originally got wrong 8 times -- Ed25519-signed manifests
 * via `signSkillManifest`).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./ai-command-skills.ts` does not exist at all,
 * so the dynamic `import('./ai-command-skills.js')` call inside `beforeAll`
 * REJECTS ("Cannot find module"), failing every `it` in this file -- mirrors
 * `object-skills.integration.test.ts` / `meeting-recurrence-skills.
 * integration.test.ts` / `context-search-calendar-skills.integration.test.ts`'s
 * own documented "module doesn't exist yet" red state. `./skill-execution.
 * service.ts`, `../qa/qa.service.ts`, `../commands/commands.service.ts`,
 * `../trigger-suggestions/trigger-suggestions.service.ts`, `../objects/
 * objects.service.ts`, and `../agent-runtime/agent-permission-manifests.
 * service.ts` all already exist (merged) -- this file dynamically imports
 * them too, ONLY to control exactly when they (and their transitive
 * `../config/env.js` dependency) are evaluated relative to this file's own
 * `process.env.DATABASE_URL`/`REDIS_URL` assignment in `beforeAll` -- NOT
 * because they are themselves missing.
 *
 * HARNESS NOTE: identical full-`AppModule`-boot Testcontainers (Postgres 16 +
 * Redis 7) harness as the three already-merged sibling skills files (too many
 * collaborators -- AI provider, search retrieval, event store, projections --
 * to hand-construct `QAService`/`CommandsService`/`TriggerSuggestionsService`
 * directly). `ANTHROPIC_API_KEY` is deliberately left unset (`delete
 * process.env.ANTHROPIC_API_KEY`, mirroring `qa.integration.test.ts`'s own
 * convention) so `AIProviderModule`'s real DI wiring falls back to its
 * production `MockProvider` + `unconfiguredResponder` (`../ai/ai-provider.
 * module.ts`): if the rendered prompt contains the literal substring
 * `"RETURN:"`, the response is everything after it, verbatim, with a fixed
 * usage of `{inputTokens:100, outputTokens:20}` -- this file plants that
 * marker to get deterministic, scripted AI responses without mocking
 * anything itself.
 *
 * SIGNING: same re-signing-against-a-locally-owned-test-keypair convention as
 * every sibling skills test file in this feature -- `SkillsModule`'s own
 * factory does NOT wire this PR's 5 skills yet (matching PR4's own
 * precedent, per this task's explicit instruction), so this file's own
 * `beforeAll` builds + registers them into the SAME process-wide
 * `SKILL_REGISTRY` this file's `skillExecutionService` resolves against,
 * under a keypair this file owns.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `./ai-command-skills.ts` exports 5 build functions, each named after their
 * catalog id in `buildXSkill` form (this test file's own pinned choice, same
 * "picking concrete names removes ambiguity" reasoning as PR3's own doc
 * comment):
 *   `buildAnswerQuestionSkill(qaService: QAService)`
 *     -> id `'answer-question'`, input `{question: string}`, no objectType.
 *   `buildParseCommandSkill(commandsService: CommandsService)`
 *     -> id `'parse-command'`, input `{command: string, sourceObjectId?: string}`,
 *        no objectType (produces an `ActionsProposed` proposal via the fixed
 *        internal `COMMAND_PARSER_ACTOR` -- never a direct mutation).
 *   `buildProposeActionsFromMeetingSkill(commandsService: CommandsService)`
 *     -> id `'propose-actions-from-meeting'`, input `{meetingObjectId: string,
 *        transcriptText: string}` -- ALWAYS `'meeting'`-typed by construction
 *        (mirrors `invite-meeting-bot`/`get-meeting-details`'s own static
 *        `objectType` precedent, `meeting-recurrence-skills.ts`) -- callers
 *        pass the literal `'meeting'` as `executeSkill`'s 5th argument
 *        directly, no pre-fetch helper needed.
 *   `buildRunTriggerSuggestionAnalysisSkill(triggerSuggestionsService: TriggerSuggestionsService)`
 *     -> id `'run-trigger-suggestion-analysis'`, NO body fields at all (just
 *        context) -- passes a FIXED `callerRole` of `'admin'` (NOT the usual
 *        `'member'`), since `runAnalysis` itself hard-rejects anything below
 *        `admin`. Workspace-level (no objectType).
 *   `buildListCommandProposalsSkill(commandsService: CommandsService)`
 *     -> id `'list-command-proposals'`, input `{filter?: {pendingOnly?:
 *        boolean, limit?: number, cursor?: string}}`, fixed `callerRole =
 *        'member'`. Workspace-level (no objectType).
 *
 * VALIDATION: every skill uses a SINGLE, unified `.loose()` zod schema
 * validating `workspaceId`/`agentIdentifier`/`objectId`-if-any AND its own
 * body fields together in ONE `safeParse` call -- NEVER the split
 * context+strict-body two-parse pattern (that pattern always fails with
 * `unrecognized_keys` once `executeSkill` injects `workspaceId`/
 * `agentIdentifier` into the SAME `input` object a `.strict()` body schema is
 * parsed against -- the exact bug class `object-skills.ts` got wrong 8 times
 * across 3 PRs before being fixed; this test file's own assertions below
 * would silently degenerate into "always ValidationError, never truly
 * exercised" if implementer repeats it here).
 * ============================================================================
 */

const RETURN_MARKER = 'RETURN:';

interface ProposedActionLike {
  actionId: string;
  type: string;
  intent: string;
  rationale: string;
  resources: string[];
  rollbackNote: string;
  params: Record<string, unknown>;
}

interface CommandsServiceParseResultLike {
  proposalId: string;
  actions: ProposedActionLike[];
  parseError: boolean;
  message?: string;
}

interface CommandProposalSummaryLike {
  id: string;
  workspaceId: string;
  command: string;
  sourceObjectId: string | null;
  actions: unknown;
  decisions: unknown;
  createdAt: Date;
  decidedAt: Date | null;
}

interface ListCommandProposalsResultLike {
  proposals: CommandProposalSummaryLike[];
  nextCursor?: string;
}

interface CommandsServiceLike {
  parse(
    workspaceId: string,
    actor: Actor,
    command: string,
    sourceObjectId?: string,
  ): Promise<CommandsServiceParseResultLike>;
  proposeFromMeeting(
    workspaceId: string,
    meetingObjectId: string,
    transcriptText: string,
  ): Promise<CommandsServiceParseResultLike>;
  listProposals(
    workspaceId: string,
    callerRole: MembershipRole,
    filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
  ): Promise<ListCommandProposalsResultLike>;
}

interface QASourceLike {
  objectId: string;
  title: string;
  snippet: string;
}

interface QAServiceLike {
  answer(
    workspaceId: string,
    question: string,
  ): Promise<{ answer: string; sources: QASourceLike[] }>;
}

interface TriggerSuggestionsServiceLike {
  runAnalysis(workspaceId: string, actor: Actor, callerRole: MembershipRole): Promise<unknown[]>;
}

interface ObjectWithFieldValuesLike {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lifecycle: string;
  checklist: unknown[];
  fieldValues: Record<string, unknown>;
}

interface ObjectsServiceLike {
  create(
    workspaceId: string,
    actor: Actor,
    input: { objectType: string; title: string },
    callerRole: string,
  ): Promise<ObjectWithFieldValuesLike>;
}

interface AgentPermissionManifestsServiceLike {
  grant(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: {
      agentIdentifier: string;
      dataScope: { objectTypes: string[] | 'all' };
      actionTypes: string[];
      timeWindow: { startsAt: Date | null; expiresAt: Date | null };
    },
  ): Promise<{ id: string; agentIdentifier: string }>;
}

interface SkillExecutionServiceLike {
  executeSkill<TOutput>(
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: Record<string, unknown>,
    objectType?: string,
  ): Promise<AgentActionResult<TOutput>>;
}

/** The exact catalog ids this PR's 5 skills must be registered under (spec table #16-20). */
const EXPECTED_SKILL_IDS = [
  'answer-question',
  'parse-command',
  'propose-actions-from-meeting',
  'run-trigger-suggestion-analysis',
  'list-command-proposals',
] as const;

describe('F3-T2 PR5 (RED step): ai-command-skills.ts — answer-question, parse-command, propose-actions-from-meeting, run-trigger-suggestion-analysis, list-command-proposals (real Postgres + Redis via Testcontainers, full AppModule)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;
  let embeddingProvider: EmbeddingProvider;

  let objectsService: ObjectsServiceLike;
  let qaService: QAServiceLike;
  let commandsService: CommandsServiceLike;
  let triggerSuggestionsService: TriggerSuggestionsServiceLike;
  let permissionsService: AgentPermissionManifestsServiceLike;
  let skillExecutionService: SkillExecutionServiceLike;

  let workspaceCounter = 0;
  let agentCounter = 0;
  const nextProposalId = monotonicFactory();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // Deliberately NOT set -- forces the DI wiring to fall back to
    // MockProvider (`unconfiguredResponder`'s RETURN: marker convention),
    // mirroring `qa.integration.test.ts`'s own identical convention.
    delete process.env.ANTHROPIC_API_KEY;

    await runMigrations(container.getConnectionUri());
    db = createDatabaseClient(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const objectsServiceModule: unknown = await import('../objects/objects.service.js');
    const ObjectsServiceCtor = (
      objectsServiceModule as { ObjectsService: Type<ObjectsServiceLike> }
    ).ObjectsService;
    objectsService = app.get(ObjectsServiceCtor);

    const qaServiceModule: unknown = await import('../qa/qa.service.js');
    const QAServiceCtor = (qaServiceModule as { QAService: Type<QAServiceLike> }).QAService;
    qaService = app.get(QAServiceCtor);

    const commandsServiceModule: unknown = await import('../commands/commands.service.js');
    const CommandsServiceCtor = (
      commandsServiceModule as { CommandsService: Type<CommandsServiceLike> }
    ).CommandsService;
    commandsService = app.get(CommandsServiceCtor);

    const triggerSuggestionsServiceModule: unknown =
      await import('../trigger-suggestions/trigger-suggestions.service.js');
    const TriggerSuggestionsServiceCtor = (
      triggerSuggestionsServiceModule as {
        TriggerSuggestionsService: Type<TriggerSuggestionsServiceLike>;
      }
    ).TriggerSuggestionsService;
    triggerSuggestionsService = app.get(TriggerSuggestionsServiceCtor);

    const permissionsModule: unknown =
      await import('../agent-runtime/agent-permission-manifests.service.js');
    const AgentPermissionManifestsServiceCtor = (
      permissionsModule as {
        AgentPermissionManifestsService: Type<AgentPermissionManifestsServiceLike>;
      }
    ).AgentPermissionManifestsService;
    permissionsService = app.get(AgentPermissionManifestsServiceCtor);

    const skillExecutionModule: unknown = await import('./skill-execution.service.js');
    const SkillExecutionServiceCtor = (
      skillExecutionModule as { SkillExecutionService: Type<SkillExecutionServiceLike> }
    ).SkillExecutionService;
    skillExecutionService = app.get(SkillExecutionServiceCtor);

    embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);

    // `SkillsModule`'s own factory (part of `AppModule`, F3-T2 PR6) already
    // registers these 5 skills into the SAME process-wide `SKILL_REGISTRY`
    // this test's `skillExecutionService` resolves against, signed with
    // `ai-command-skills.ts`'s own real production keypair. Re-registering
    // them here under a second, test-owned keypair throws `ConflictError`
    // on the same already-populated registry instance.
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 120_000);

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `ai-command-skills-test-workspace-${String(workspaceCounter)}`,
        slug: `ai-command-skills-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  function fakeActor(): Actor {
    return { type: 'user', id: randomUUID() };
  }

  function freshAgentIdentifier(label: string): string {
    agentCounter += 1;
    return `ai-command-skills-test-${label}-agent-${String(agentCounter)}`;
  }

  /** Asserts `result.outcome === 'success'` and returns the narrowed `value`. */
  function unwrapSuccess<T>(result: AgentActionResult<T>): T {
    if (result.outcome !== 'success') {
      throw new Error(`Expected a successful AgentActionResult, got: ${JSON.stringify(result)}`);
    }
    return result.value;
  }

  /** Same convention as `qa.integration.test.ts`'s own `returnDirective` --
   * planted as the FINAL segment of the question/command/transcript text, so
   * "everything after RETURN: to the end of the prompt string" is exactly the
   * scripted payload, with nothing after it. */
  function returnDirective(value: string): string {
    return `${RETURN_MARKER}${value}`;
  }

  /** Same `RETURN:<json>` marker convention as `commands.service.
   * integration.test.ts`'s own `scriptedActionsCommand`. */
  function scriptedActionsCommand(actions: Record<string, unknown>[]): string {
    return `Please act on this. ${returnDirective(JSON.stringify(actions))}`;
  }

  /** Same `RETURN:<json>` marker convention as `commands.service.
   * propose-from-meeting.integration.test.ts`'s own `scriptedTranscript`. */
  function scriptedTranscript(actions: Record<string, unknown>[]): string {
    return `Meeting notes mentioning a follow-up. ${returnDirective(JSON.stringify(actions))}`;
  }

  /**
   * Resolves `text`'s own embedding via the app's REAL `EmbeddingProvider` DI
   * binding and overwrites `objectId`'s `search_index.embedding` row
   * directly, bypassing the projection/scheduler entirely -- mirrors
   * `qa.integration.test.ts`'s own `attachEmbeddingForText` helper exactly.
   */
  async function attachEmbeddingForText(objectId: string, text: string): Promise<void> {
    const { vector } = await embeddingProvider.embed({ text });
    await db
      .update(searchIndex)
      .set({ embedding: vector })
      .where(eq(searchIndex.objectId, objectId));
  }

  /** Raw-inserts a `command_proposals` row -- mirrors `commands.service.
   * list-proposals.integration.test.ts`'s own `seedProposal` helper, giving
   * precise control over `decidedAt` and strictly-increasing `id` ordering
   * without needing a scripted AI provider call for this file's dedicated
   * `list-command-proposals` pagination/filter test. */
  async function seedCommandProposal(
    workspaceId: string,
    overrides: {
      decisions?: unknown[] | null;
      decidedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const id = nextProposalId();
    await db.insert(commandProposals).values({
      id,
      streamId: randomUUID(),
      workspaceId,
      command: `seeded command ${id}`,
      sourceObjectId: null,
      actions: [],
      decisions: overrides.decisions ?? null,
      createdAt: new Date(),
      decidedAt: overrides.decidedAt ?? null,
    });
    return id;
  }

  const oneValidCreateTaskAction = {
    type: 'createTask',
    intent: 'Create a follow-up task',
    rationale: 'The command asked for one',
    resources: [] as string[],
    rollbackNote: 'Delete the created task',
    params: { title: 'Skill-parsed follow-up task' },
  };

  const oneValidMeetingAction = {
    type: 'createTaskFromMeeting',
    intent: 'Create a follow-up task from the meeting',
    rationale: 'The transcript named a concrete action item',
    resources: [] as string[],
    rollbackNote: 'Delete the created task',
    params: { title: 'Skill-proposed meeting follow-up' },
  };

  it('1. all 5 skills are registered under their exact catalog ids, retrievable via registry.get(id)', async () => {
    const skillExecutionModule: unknown = await import('./skill-execution.service.js');
    const SKILL_REGISTRY_TOKEN = (skillExecutionModule as { SKILL_REGISTRY: symbol })
      .SKILL_REGISTRY;
    const skillRegistry = app.get<SkillRegistry>(SKILL_REGISTRY_TOKEN);

    for (const id of EXPECTED_SKILL_IDS) {
      const registered = skillRegistry.get(id);
      expect(registered).toBeDefined();
      expect(registered?.manifest.id).toBe(id);
    }
  });

  it('2. answer-question: QAService.answer reached end-to-end -- returns the exact scripted answer and a real, independently-checkable source matching a genuinely seeded + embedded object', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('answer-question');
    const actor = fakeActor();

    const title = 'Skill QA Source Object';
    const created = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title },
      'member',
    );
    const docText = 'The skill-driven QA source object contains exactly this sentence.';
    await db.update(searchIndex).set({ docText }).where(eq(searchIndex.objectId, created.id));

    const plantedAnswer = 'Skill-driven QA answer, planted for this exact test.';
    const question = `What does the skill QA source object say? ${returnDirective(plantedAnswer)}`;
    await attachEmbeddingForText(created.id, question);

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const result = await skillExecutionService.executeSkill<{
      answer: string;
      sources: QASourceLike[];
    }>(workspaceId, agentIdentifier, 'answer-question', { question });
    const answered = unwrapSuccess(result);
    expect(answered.answer).toBe(plantedAnswer);

    const source = answered.sources.find((entry) => entry.objectId === created.id);
    expect(source).toBeDefined();
    expect(source?.title).toBe(title);
  });

  it('3. answer-question: a manifest lacking the "answer-question" actionType is denied with ForbiddenError; QAService.answer is never invoked', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('answer-question-denied');
    const answerSpy = vi.spyOn(qaService, 'answer');
    const callsBefore = answerSpy.mock.calls.length;

    await expect(
      skillExecutionService.executeSkill(workspaceId, agentIdentifier, 'answer-question', {
        question: 'This must never reach QAService.answer.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(answerSpy.mock.calls.length).toBe(callsBefore);
  });

  it('4. answer-question: cross-workspace isolation -- a manifest granted only in workspace A never authorizes the skill in workspace B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('answer-question-cross-workspace');

    await permissionsService.grant(workspaceIdA, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    await expect(
      skillExecutionService.executeSkill(workspaceIdB, agentIdentifier, 'answer-question', {
        question: 'Should be denied in workspace B.',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('5. parse-command: CommandsService.parse reached end-to-end -- a REAL ActionsProposed-shaped proposal is persisted, independently verified via a separate CommandsService.listProposals call; sourceObjectId is threaded through to the persisted row even when the AI response cannot be parsed', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('parse-command');
    const actor = fakeActor();

    const sourceObject = await objectsService.create(
      workspaceId,
      actor,
      { objectType: 'task', title: 'parse-command source object' },
      'member',
    );

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['parse-command'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    // BUG FIX (discovered via CI): `sourceObjectId` is deliberately OMITTED
    // from this call. `parse-command.ts`'s `renderCommandPrompt` appends a
    // trailing "Source object id: <id>" line AFTER the command text
    // whenever `sourceObjectId` is provided -- that breaks the scripted
    // `RETURN:<json>` marker's "everything after RETURN: to the end of the
    // prompt" convention (the JSON gains trailing garbage and fails to
    // parse, `parseError` comes back `true` instead of `false`).
    // sourceObjectId threading is proven separately below, in a call that
    // doesn't depend on successful JSON parsing.
    const command = scriptedActionsCommand([oneValidCreateTaskAction]);
    const result = await skillExecutionService.executeSkill<CommandsServiceParseResultLike>(
      workspaceId,
      agentIdentifier,
      'parse-command',
      { command },
    );
    const parsed = unwrapSuccess(result);
    expect(parsed.parseError).toBe(false);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]?.type).toBe('createTask');
    expect(typeof parsed.proposalId).toBe('string');

    const { proposals } = await commandsService.listProposals(workspaceId, 'member');
    const persisted = proposals.find((proposal) => proposal.id === parsed.proposalId);
    expect(persisted).toBeDefined();
    expect(persisted?.workspaceId).toBe(workspaceId);
    expect(Array.isArray(persisted?.actions)).toBe(true);
    expect((persisted?.actions as unknown[]).length).toBe(1);
    expect(persisted?.decidedAt).toBeNull();

    // sourceObjectId threading, proven independently of JSON parsing: a
    // plain command with no `RETURN:` marker deterministically produces
    // `unconfiguredResponder`'s fixed "not configured" text (not valid
    // JSON), so `parseError:true` is expected and irrelevant here --
    // `CommandsService.parse`'s own `recordProposal` call passes
    // `sourceObjectId` through UNCONDITIONALLY, regardless of `parseError`.
    const secondResult = await skillExecutionService.executeSkill<CommandsServiceParseResultLike>(
      workspaceId,
      agentIdentifier,
      'parse-command',
      {
        command: 'A plain command with no scripted response.',
        sourceObjectId: sourceObject.id,
      },
    );
    const secondParsed = unwrapSuccess(secondResult);
    expect(typeof secondParsed.proposalId).toBe('string');

    const { proposals: proposalsAfterSecond } = await commandsService.listProposals(
      workspaceId,
      'member',
    );
    const secondPersisted = proposalsAfterSecond.find(
      (proposal) => proposal.id === secondParsed.proposalId,
    );
    expect(secondPersisted).toBeDefined();
    expect(secondPersisted?.sourceObjectId).toBe(sourceObject.id);
  });

  it('6. parse-command: a manifest lacking the "parse-command" actionType is denied with ForbiddenError; CommandsService.parse is never invoked', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('parse-command-denied');
    const parseSpy = vi.spyOn(commandsService, 'parse');
    const callsBefore = parseSpy.mock.calls.length;

    await expect(
      skillExecutionService.executeSkill(workspaceId, agentIdentifier, 'parse-command', {
        command: scriptedActionsCommand([oneValidCreateTaskAction]),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(parseSpy.mock.calls.length).toBe(callsBefore);
  });

  it('7. parse-command: cross-workspace isolation -- a manifest granted only in workspace A never authorizes the skill in workspace B, and no proposal is persisted there', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('parse-command-cross-workspace');

    await permissionsService.grant(workspaceIdA, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['parse-command'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    await expect(
      skillExecutionService.executeSkill(workspaceIdB, agentIdentifier, 'parse-command', {
        command: scriptedActionsCommand([oneValidCreateTaskAction]),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const { proposals } = await commandsService.listProposals(workspaceIdB, 'member');
    expect(proposals).toEqual([]);
  });

  it('8. propose-actions-from-meeting: CommandsService.proposeFromMeeting reached end-to-end with a STATIC "meeting" objectType -- a REAL proposal (sourceObjectId=meetingObjectId) is persisted, independently verified via listProposals; re-narrowing the SAME manifest to "task" only then denies', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('propose-actions-from-meeting');
    const meetingObjectId = newObjectId();

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['meeting'] },
      actionTypes: ['propose-actions-from-meeting'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const transcriptText = scriptedTranscript([oneValidMeetingAction]);
    const result = await skillExecutionService.executeSkill<CommandsServiceParseResultLike>(
      workspaceId,
      agentIdentifier,
      'propose-actions-from-meeting',
      { meetingObjectId, transcriptText },
      'meeting',
    );
    const proposed = unwrapSuccess(result);
    expect(proposed.parseError).toBe(false);
    expect(proposed.actions).toHaveLength(1);
    expect(proposed.actions[0]?.type).toBe('createTaskFromMeeting');

    const { proposals } = await commandsService.listProposals(workspaceId, 'member');
    const persisted = proposals.find((proposal) => proposal.id === proposed.proposalId);
    expect(persisted).toBeDefined();
    expect(persisted?.sourceObjectId).toBe(meetingObjectId);
    expect(persisted?.decidedAt).toBeNull();

    // Re-grant (upsert) the SAME agent, now narrowed to `objectTypes: ['task']`
    // only -- proves the skill's STATIC `objectType: 'meeting'` argument is
    // genuinely checked by `executeSkill`'s dataScope narrowing, not silently
    // omitted (mirrors `invite-meeting-bot`'s identical proof, PR4).
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: ['task'] },
      actionTypes: ['propose-actions-from-meeting'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    await expect(
      skillExecutionService.executeSkill(
        workspaceId,
        agentIdentifier,
        'propose-actions-from-meeting',
        {
          meetingObjectId: newObjectId(),
          transcriptText: scriptedTranscript([oneValidMeetingAction]),
        },
        'meeting',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('9. run-trigger-suggestion-analysis: TriggerSuggestionsService.runAnalysis reached end-to-end with the FIXED "admin" callerRole (never "member") -- a real trigger_suggestion_analysis_state.lastRunAt row is upserted, independently verified via a direct DB read', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('run-trigger-suggestion-analysis');

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['run-trigger-suggestion-analysis'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const runAnalysisSpy = vi.spyOn(triggerSuggestionsService, 'runAnalysis');

    const result = await skillExecutionService.executeSkill<unknown[]>(
      workspaceId,
      agentIdentifier,
      'run-trigger-suggestion-analysis',
      {},
    );
    const suggestions = unwrapSuccess(result);
    expect(Array.isArray(suggestions)).toBe(true);

    expect(runAnalysisSpy).toHaveBeenCalledTimes(1);
    const call = runAnalysisSpy.mock.calls[0];
    expect(call?.[0]).toBe(workspaceId);
    expect(call?.[1]?.type).toBe('agent');
    expect(call?.[2]).toBe('admin');

    const [stateRow] = await db
      .select()
      .from(triggerSuggestionAnalysisState)
      .where(eq(triggerSuggestionAnalysisState.workspaceId, workspaceId));
    expect(stateRow).toBeDefined();
    expect(stateRow?.lastRunAt).toBeInstanceOf(Date);
  });

  it('10. run-trigger-suggestion-analysis: a manifest lacking the actionType is denied with ForbiddenError; TriggerSuggestionsService.runAnalysis is never invoked', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('run-trigger-suggestion-analysis-denied');
    const runAnalysisSpy = vi.spyOn(triggerSuggestionsService, 'runAnalysis');
    const callsBefore = runAnalysisSpy.mock.calls.length;

    await expect(
      skillExecutionService.executeSkill(
        workspaceId,
        agentIdentifier,
        'run-trigger-suggestion-analysis',
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(runAnalysisSpy.mock.calls.length).toBe(callsBefore);
  });

  it('11. list-command-proposals: CommandsService.listProposals reached end-to-end -- pendingOnly/limit filters are genuinely threaded through against REAL seeded rows with different decided states', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = freshAgentIdentifier('list-command-proposals');

    const pendingOldId = await seedCommandProposal(workspaceId, { decidedAt: null });
    const pendingNewId = await seedCommandProposal(workspaceId, { decidedAt: null });
    const decidedId = await seedCommandProposal(workspaceId, {
      decisions: [{ actionId: 'a1', decision: 'approved' }],
      decidedAt: new Date(),
    });

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['list-command-proposals'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const pendingResult = await skillExecutionService.executeSkill<ListCommandProposalsResultLike>(
      workspaceId,
      agentIdentifier,
      'list-command-proposals',
      { filter: { pendingOnly: true } },
    );
    const pendingIds = unwrapSuccess(pendingResult).proposals.map((proposal) => proposal.id);
    expect(pendingIds).toContain(pendingOldId);
    expect(pendingIds).toContain(pendingNewId);
    expect(pendingIds).not.toContain(decidedId);

    const limitedResult = await skillExecutionService.executeSkill<ListCommandProposalsResultLike>(
      workspaceId,
      agentIdentifier,
      'list-command-proposals',
      { filter: { pendingOnly: true, limit: 1 } },
    );
    const limitedProposals = unwrapSuccess(limitedResult).proposals;
    expect(limitedProposals).toHaveLength(1);
    // Newest-first ordering (ULID DESC) -- `pendingNewId` was minted after
    // `pendingOldId` by the SAME monotonic factory.
    expect(limitedProposals[0]?.id).toBe(pendingNewId);

    const noFilterResult = await skillExecutionService.executeSkill<ListCommandProposalsResultLike>(
      workspaceId,
      agentIdentifier,
      'list-command-proposals',
      {},
    );
    const allIds = unwrapSuccess(noFilterResult).proposals.map((proposal) => proposal.id);
    expect(allIds).toEqual(expect.arrayContaining([pendingOldId, pendingNewId, decidedId]));
  });
});
