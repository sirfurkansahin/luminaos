import crypto from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CLAUDE_SONNET_5 } from '@luminaos/ai-gateway';
import type { AIProvider } from '@luminaos/ai-gateway';
import { renderArtifactHtml } from '@luminaos/artifacts';
import type { ArtifactContent, ArtifactType, ThemePresetName } from '@luminaos/artifacts';
import type { Role } from '@luminaos/core-objects';
import { QuotaExceededError, ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { runMigrations } from '../db/migrate.js';

import type { AIUsageService } from '../ai/ai-usage.service.js';
import type { Database } from '../db/client.js';
import type { ObjectsService, ObjectWithFieldValues } from '../objects/objects.service.js';
import type { INestApplication, Type } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F3-T7 PR2 (RED step, ADR-0041 Karar a/b/g) — real, end-to-end integration
 * coverage for the NEW `ArtifactsService` (`./artifacts.service.ts`, does NOT
 * exist yet on this branch): the service that turns a free-form prompt into
 * a REAL `artifact` Lumina Object, wired through the EXACT SAME
 * `AIUsageService.withWorkspaceAILock` -> quota/budget-assert -> provider
 * call -> `recordAIUsage` discipline every other AI-completion call site in
 * this codebase already uses (`ObjectsService.performAIFieldRefresh`,
 * `CommandsService.parse`).
 *
 * ============================================================================
 * CORRECTED CONTRACT (verified directly against the REAL, current code --
 * NOT the ADR's own illustrative sketch, which calls a single-shot
 * `objectsService.create(workspaceId, { type, title, fieldValues }, actor,
 * callerRole)` that does not match `ObjectsService`'s real API):
 *
 *   `ObjectsService.create(workspaceId, actor, { objectType, title,
 *   causationEventId? }, callerRole): Promise<ObjectWithFieldValues>` --
 *   creates ONLY the object shell (type + title), accepts NO field values.
 *
 *   `ObjectsService.setFieldValues(workspaceId, objectId, actor, callerRole,
 *   entries: { fieldKey, value }[]): Promise<ObjectWithFieldValues>` --
 *   the SEPARATE call that actually writes custom field values.
 *
 * So the REAL `ArtifactsService.generate` flow this file pins is: (1)
 * `objectsService.create(workspaceId, actor, { objectType: 'artifact', title:
 * input.prompt.slice(0, 200) }, callerRole)`, THEN (2)
 * `objectsService.setFieldValues(workspaceId, created.id, actor, callerRole,
 * [{ fieldKey: 'htmlContent', value: result.htmlContent }, { fieldKey:
 * 'themePreset', value: input.themePreset }, { fieldKey: 'generationPrompt',
 * value: input.prompt }, { fieldKey: 'artifactType', value:
 * input.artifactType }])`, returning the FINAL `ObjectWithFieldValues` from
 * step 2 (which carries all 4 field values). `title` is deliberately the RAW
 * PROMPT (truncated to 200 chars), NOT the AI-generated `content.title` --
 * `generateArtifact` does not thread `content.title` back out today (see
 * this PR's other RED file, `./generate-artifact.test.ts`), so
 * `ArtifactsService` cannot use it either; this is a real, pinned behavior,
 * not an oversight.
 * ============================================================================
 *
 * RED STATE (expected, today): `./artifacts.service.ts` does not exist,
 * `'artifact'` is not yet a registered `ObjectType`
 * (`packages/core-objects/src/object-type-registry.ts`), and
 * `ArtifactsService`'s own dependency (`@luminaos/artifacts`) is not yet a
 * declared dependency of `apps/server/package.json` -- every test below is
 * expected to fail at construction/import time until `implementer` lands
 * ALL of ADR-0041 Karar a/b/g's PR2 scope.
 *
 * Mirrors `../commands/commands.service.decide.integration.test.ts`'s exact
 * harness convention: boots the REAL `AppModule` once (Testcontainers
 * Postgres 16 + Redis 7), pulls the REAL `ObjectsService`/`AIUsageService`/
 * `AI_PROVIDER` out of that real DI container via `app.get(...)`, then
 * dynamically imports and manually `new`s the NOT-YET-EXISTENT
 * `ArtifactsService` with those real instances (never a mock) -- `implementer`
 * does not even need `ArtifactsModule` wired into `AppModule` for THIS file's
 * tests to eventually pass (only `../artifacts/artifacts.controller
 * .integration.test.ts`, the HTTP-level sibling, needs that).
 */

const RETURN_MARKER = 'RETURN:';
const PASSWORD = 'correct-horse-battery-staple';

/** Generous enough that the happy-path test's single generation never trips
 * it, but small enough that a single seeded raw-SQL row can push a FRESH
 * workspace's cumulative usage to/above it for the quota-rejection test. */
const TOKEN_QUOTA_PER_WORKSPACE = 1000;
const COST_BUDGET_USD_PER_WORKSPACE = 5;

interface ArtifactsServiceContract {
  generate(
    workspaceId: string,
    actor: Actor,
    callerRole: Role,
    input: { prompt: string; artifactType: ArtifactType; themePreset: ThemePresetName },
  ): Promise<ObjectWithFieldValues>;
}

/** Pinned constructor order, per this PR's corrected sketch:
 * `(aiUsageService, objectsService, provider)`. */
type ArtifactsServiceConstructor = new (
  aiUsageService: AIUsageService,
  objectsService: ObjectsService,
  provider: AIProvider,
) => ArtifactsServiceContract;

interface RawAIUsageRow {
  field_definition_id: string | null;
  object_id: string | null;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_usd: string | null;
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `artifacts-service-test-user-${String(emailCounter)}@example.com`;
}

function buildArtifactContent(): ArtifactContent {
  return {
    title: 'Support Ticket Summary',
    sections: [
      { kind: 'heading', text: 'Overview', level: 1 },
      { kind: 'paragraph', text: 'This report summarizes open support tickets for Q3.' },
    ],
  };
}

describe('ArtifactsService.generate (F3-T7 PR2, real Postgres + real Redis via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let db: Database;
  let objectsService: ObjectsService;
  let aiUsageService: AIUsageService;
  let aiProvider: AIProvider;
  let service: ArtifactsServiceContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    // Deliberately NOT set -- forces AI_PROVIDER's DI wiring to fall back to
    // MockProvider (`unconfiguredResponder`'s `RETURN:` marker convention),
    // same as every other integration test file in this codebase.
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_TOKEN_QUOTA_PER_WORKSPACE = String(TOKEN_QUOTA_PER_WORKSPACE);
    process.env.AI_COST_BUDGET_USD_PER_WORKSPACE = String(COST_BUDGET_USD_PER_WORKSPACE);

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;

    const { DATABASE_CONNECTION } = await import('../db/database-connection.token.js');
    db = app.get<Database>(DATABASE_CONNECTION);
    aiProvider = app.get<AIProvider>(AI_PROVIDER);

    const objectsServiceModule: unknown = await import('../objects/objects.service.js');
    const ObjectsServiceCtor = (objectsServiceModule as { ObjectsService: Type<ObjectsService> })
      .ObjectsService;
    objectsService = app.get<ObjectsService>(ObjectsServiceCtor);

    const aiUsageServiceModule: unknown = await import('../ai/ai-usage.service.js');
    const AIUsageServiceCtor = (aiUsageServiceModule as { AIUsageService: Type<AIUsageService> })
      .AIUsageService;
    aiUsageService = app.get<AIUsageService>(AIUsageServiceCtor);

    // Deliberately unresolvable until `implementer` creates
    // `./artifacts.service.ts` -- the whole point of this RED commit.
    const artifactsServiceModule: unknown = await import('./artifacts.service.js');
    const ArtifactsServiceCtor = (
      artifactsServiceModule as { ArtifactsService: ArtifactsServiceConstructor }
    ).ArtifactsService;
    service = new ArtifactsServiceCtor(aiUsageService, objectsService, aiProvider);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId };
  }

  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  /** Registers a fresh owner + a fresh workspace they own, in one call --
   * returns the real `Actor`/`workspaceId` this file's `service.generate`
   * calls need. */
  async function registerOwnerWithWorkspace(): Promise<{
    actor: Actor;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Artifacts Workspace ${String(emailCounter)}`,
    );
    return { actor: { type: 'user', id: userId }, workspaceId };
  }

  /** Mirrors `../ai/ai-usage.service.integration.test.ts`'s `seedUsageRow`
   * convention: inserts an `ai_usage_records` row DIRECTLY via raw SQL,
   * bypassing `recordAIUsage`, so a quota/budget threshold test can control
   * the exact cumulative SUM `assertAITokenQuotaNotExceeded`/
   * `assertAICostBudgetNotExceeded` reads without a real prior provider call. */
  async function seedUsageRow(
    workspaceId: string,
    overrides: { inputTokens?: number; outputTokens?: number; costUsd?: string | null },
  ): Promise<void> {
    await db.$client.query(
      `insert into ai_usage_records
         (id, workspace_id, field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        crypto.randomUUID(),
        workspaceId,
        null,
        null,
        overrides.inputTokens ?? 0,
        overrides.outputTokens ?? 0,
        null,
        overrides.costUsd ?? null,
      ],
    );
  }

  async function getUsageRowsForWorkspace(workspaceId: string): Promise<RawAIUsageRow[]> {
    const result = await db.$client.query<RawAIUsageRow>(
      `select field_definition_id, object_id, input_tokens, output_tokens, model, cost_usd
         from ai_usage_records where workspace_id = $1 order by created_at asc`,
      [workspaceId],
    );
    return result.rows;
  }

  async function countArtifactObjects(workspaceId: string): Promise<number> {
    const { objects } = await objectsService.list(workspaceId, 'owner');
    return objects.filter((object) => object.type === 'artifact').length;
  }

  describe('happy path', () => {
    it('creates a REAL artifact Lumina Object with all 4 field values correctly set, and records a matching ai_usage_records row', async () => {
      const { actor, workspaceId } = await registerOwnerWithWorkspace();
      const content = buildArtifactContent();
      const prompt = `${RETURN_MARKER}${JSON.stringify(content)}`;

      const object = await service.generate(workspaceId, actor, 'owner', {
        prompt,
        artifactType: 'report',
        themePreset: 'kurumsal',
      });

      expect(object.type).toBe('artifact');
      expect(object.workspaceId).toBe(workspaceId);
      expect(object.lifecycle).toBe('active');
      // Title is the RAW prompt, truncated to 200 chars -- NOT
      // content.title (see this file's header "CORRECTED CONTRACT" note).
      expect(object.title).toBe(prompt.slice(0, 200));

      const expectedHtml = renderArtifactHtml(content, 'kurumsal', 'report');
      expect(object.fieldValues.htmlContent).toBe(expectedHtml);
      expect(object.fieldValues.themePreset).toBe('kurumsal');
      expect(object.fieldValues.generationPrompt).toBe(prompt);
      expect(object.fieldValues.artifactType).toBe('report');

      const rows = await getUsageRowsForWorkspace(workspaceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.model).toBe(CLAUDE_SONNET_5);
      expect(rows[0]?.input_tokens).toBe(100);
      expect(rows[0]?.output_tokens).toBe(20);
      // Context-free usage record, per ADR-0014 §a/§b -- artifact generation
      // has no `fieldDefinitionId`/`objectId` to attribute usage to (the
      // object doesn't exist yet at the time the provider call happens).
      expect(rows[0]?.field_definition_id).toBeNull();
      expect(rows[0]?.object_id).toBeNull();
    });
  });

  describe('AI usage quota/budget discipline is genuinely exercised', () => {
    it('rejects with QuotaExceededError, calls the provider ZERO times, and creates NO object when the workspace TOKEN quota is already met', async () => {
      const { actor, workspaceId } = await registerOwnerWithWorkspace();
      await seedUsageRow(workspaceId, { inputTokens: TOKEN_QUOTA_PER_WORKSPACE, outputTokens: 0 });

      const completeSpy = vi.spyOn(aiProvider, 'complete');

      await expect(
        service.generate(workspaceId, actor, 'owner', {
          prompt: 'Summarize our open support tickets',
          artifactType: 'report',
          themePreset: 'kurumsal',
        }),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      expect(completeSpy).not.toHaveBeenCalled();
      expect(await countArtifactObjects(workspaceId)).toBe(0);

      completeSpy.mockRestore();
    });

    it('rejects with QuotaExceededError, calls the provider ZERO times, and creates NO object when the workspace COST budget is already met', async () => {
      const { actor, workspaceId } = await registerOwnerWithWorkspace();
      await seedUsageRow(workspaceId, {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: String(COST_BUDGET_USD_PER_WORKSPACE),
      });

      const completeSpy = vi.spyOn(aiProvider, 'complete');

      await expect(
        service.generate(workspaceId, actor, 'owner', {
          prompt: 'Summarize our open support tickets',
          artifactType: 'report',
          themePreset: 'kurumsal',
        }),
      ).rejects.toBeInstanceOf(QuotaExceededError);

      expect(completeSpy).not.toHaveBeenCalled();
      expect(await countArtifactObjects(workspaceId)).toBe(0);

      completeSpy.mockRestore();
    });
  });

  describe('a generation parse-failure surfaces as ValidationError and creates NO object', () => {
    it('throws ValidationError (never a raw/unhandled error) and creates NO artifact object when the model never returns parseable content', async () => {
      const { actor, workspaceId } = await registerOwnerWithWorkspace();

      // No `RETURN:` marker present -- `unconfiguredResponder` falls back to
      // its clearly-synthetic "not configured" message on BOTH attempts,
      // which is not valid JSON, so `generateArtifact` exhausts its
      // retry-once budget and returns `{ parseError: true }`.
      await expect(
        service.generate(workspaceId, actor, 'owner', {
          prompt: 'Build something the mock provider cannot answer meaningfully',
          artifactType: 'page',
          themePreset: 'minimal',
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countArtifactObjects(workspaceId)).toBe(0);

      // Both failed provider attempts still recorded their own usage row
      // each (per `generateArtifact`'s unconditional per-attempt
      // `recordUsage` convention) -- the eventual ValidationError does not
      // retroactively un-record already-spent usage.
      const rows = await getUsageRowsForWorkspace(workspaceId);
      expect(rows).toHaveLength(2);
    });
  });
});
