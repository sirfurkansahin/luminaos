import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SkillManifest, SkillRegistry } from '@luminaos/skill-sdk';

import type { INestApplication } from '@nestjs/common';

/**
 * F3-T2 PR6 (spec Kabul Kriteri: "20 becerinin TAMAMI registry'de kayıtlıdır")
 * -- the end-to-end duman testi (smoke test) `.claude/skills/agent-skill-sdk/
 * SKILL.md` references. Boots the REAL, production `AppModule` graph (same
 * harness convention as `object-skills.integration.test.ts`) and asserts
 * `SkillsModule`'s factory has registered every one of the 20 first-party
 * skills from the spec's catalog table -- not a re-implementation of that
 * table, a literal transcription of it, so a future skill silently dropped
 * from `skills.module.ts`'s wiring (as PR3/PR4/PR5 each deliberately left the
 * OTHER files' skills unwired) fails this test immediately.
 *
 * Also asserts the catalog's own "kapsam dışı" boundary (spec's Kritik
 * Güvenlik-Sınırı Bulgusu): none of the excluded decide/governance-write
 * action ids are ever registered as skills.
 */

const EXPECTED_SKILL_IDS = [
  'create-object',
  'get-object',
  'query-objects',
  'set-field-values',
  'add-checklist-item',
  'toggle-checklist-item',
  'schedule-time-block',
  'refresh-ai-field',
  'set-recurrence-rule',
  'generate-next-recurrence',
  'invite-meeting-bot',
  'get-meeting-details',
  'get-object-context',
  'search-connected-sources',
  'list-cached-calendar-events',
  'answer-question',
  'parse-command',
  'propose-actions-from-meeting',
  'run-trigger-suggestion-analysis',
  'list-command-proposals',
] as const;

const EXCLUDED_ACTION_IDS = [
  'decide',
  'create-trigger',
  'update-trigger',
  'delete-trigger',
  'create-webhook-subscription',
  'update-webhook-subscription',
  'remove-webhook-subscription',
  'grant-mcp-client',
  'revoke-mcp-client',
];

describe('20-skill registry smoke test (real AppModule, Postgres + Redis via Testcontainers)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 120_000);

  it('registers all 20 first-party skills from the spec catalog, each with a valid manifest', async () => {
    const skillExecutionModule: unknown = await import('./skill-execution.service.js');
    const { SKILL_REGISTRY } = skillExecutionModule as { SKILL_REGISTRY: symbol };
    const registry = app.get<SkillRegistry>(SKILL_REGISTRY);

    const manifests: SkillManifest[] = registry.list();
    const ids = manifests
      .map((manifest) => manifest.id)
      .slice()
      .sort();

    expect(ids).toEqual([...EXPECTED_SKILL_IDS].slice().sort());

    for (const manifest of manifests) {
      expect(manifest.signature.length).toBeGreaterThan(0);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.capability.length).toBeGreaterThan(0);
    }
  });

  it('never registers any excluded decide/governance-write action as a skill', async () => {
    const skillExecutionModule: unknown = await import('./skill-execution.service.js');
    const { SKILL_REGISTRY } = skillExecutionModule as { SKILL_REGISTRY: symbol };
    const registry = app.get<SkillRegistry>(SKILL_REGISTRY);

    const ids = new Set(registry.list().map((manifest) => manifest.id));

    for (const excludedId of EXCLUDED_ACTION_IDS) {
      expect(ids.has(excludedId)).toBe(false);
    }
  });
});
