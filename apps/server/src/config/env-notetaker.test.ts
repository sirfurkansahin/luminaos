import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F2-T13 PR4 (RED step) — ONE new, OPTIONAL env field on `./env.ts`:
 * `notetakerWebhookSecret?: string`, sourced from `NOTETAKER_WEBHOOK_SECRET`.
 *
 * Follows `./env-ai.test.ts`'s (`ANTHROPIC_API_KEY` describe block) and
 * `./env-calendar.test.ts`'s EXACT precedent — `env.ts` has no dedicated test
 * file covering its ORIGINAL fields, only feature-scoped addenda files like
 * this one, each pinning ONE PR's new field(s) without touching `env.ts` or
 * weakening any existing test.
 *
 * Because `env.ts` exports an ALREADY-EVALUATED singleton
 * (`export const env: Env = readEnv();`), every test below:
 *   1. sets `process.env` values BEFORE importing,
 *   2. calls `vi.resetModules()` (in `beforeEach`) so the next
 *      `await import('./env.js')` re-evaluates the module fresh,
 *   3. restores `process.env` to its pre-suite snapshot afterward
 *      (`afterEach`) so mutated env vars never leak into another test file
 *      sharing this Vitest worker process.
 *
 * `DATABASE_URL`/`REDIS_URL` are set to harmless placeholders in every test
 * purely so `readEnv()`'s EXISTING fail-fast checks for those two don't trip
 * and mask the `NOTETAKER_WEBHOOK_SECRET`-specific behavior this file pins.
 *
 * ============================================================================
 * NEW CONTRACT PINNED HERE (implementer: extend `Env`/`readEnv()` in
 * `./env.ts` to match EXACTLY -- mirrors `readAnthropicApiKey` BIT FOR BIT,
 * ADR-0030 §f / Bağlam madde 5):
 *
 *   interface Env {
 *     ...                                 // unchanged existing fields
 *     notetakerWebhookSecret?: string;    // NEW, optional
 *   }
 *
 *   function readNotetakerWebhookSecret(): string | undefined { ... }
 *
 * `NOTETAKER_WEBHOOK_SECRET`:
 *   - absent, OR blank/whitespace-only (mirrors `readAnthropicApiKey`'s
 *     "blank == absent" convention) -> `env.notetakerWebhookSecret ===
 *     undefined`, and the process boots fine (NO `process.exit`). This is
 *     the signal `NotetakerWebhookAuthGuard` uses to fail-closed (401) every
 *     webhook request rather than crash boot (ADR-0030 §f).
 *   - set to any non-blank string -> `env.notetakerWebhookSecret` equals that
 *     exact string, verbatim (no trimming/transformation of a non-blank
 *     value, no shape validation -- a malformed secret is this feature's own
 *     concern at HMAC-verification time, not this boot-time reader's).
 *   - NEVER fatal: there is no "invalid" `NOTETAKER_WEBHOOK_SECRET` SHAPE
 *     from `env.ts`'s point of view, same as `ANTHROPIC_API_KEY`.
 * ============================================================================
 */

const ENV_SNAPSHOT = { ...process.env };

function restoreEnvToSnapshot(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_SNAPSHOT)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, ENV_SNAPSHOT);
}

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgres://unit-test-placeholder/db';
  process.env.REDIS_URL = 'redis://unit-test-placeholder:6379';
});

afterEach(() => {
  restoreEnvToSnapshot();
  vi.restoreAllMocks();
});

describe('env.ts — NOTETAKER_WEBHOOK_SECRET (F2-T13 PR4, ADR-0030 §f, new optional field)', () => {
  it('is undefined, and the module loads without exiting, when NOTETAKER_WEBHOOK_SECRET is not set at all', async () => {
    delete process.env.NOTETAKER_WEBHOOK_SECRET;

    const { env } = await import('./env.js');

    expect(env.notetakerWebhookSecret).toBeUndefined();
  });

  it('is undefined when NOTETAKER_WEBHOOK_SECRET is blank/whitespace-only (mirrors ANTHROPIC_API_KEY\'s "blank == absent" convention)', async () => {
    process.env.NOTETAKER_WEBHOOK_SECRET = '   ';

    const { env } = await import('./env.js');

    expect(env.notetakerWebhookSecret).toBeUndefined();
  });

  it('equals the exact configured string when NOTETAKER_WEBHOOK_SECRET is set to a non-blank value', async () => {
    process.env.NOTETAKER_WEBHOOK_SECRET = 'notetaker-webhook-secret-unit-test-placeholder';

    const { env } = await import('./env.js');

    expect(env.notetakerWebhookSecret).toBe('notetaker-webhook-secret-unit-test-placeholder');
  });
});
