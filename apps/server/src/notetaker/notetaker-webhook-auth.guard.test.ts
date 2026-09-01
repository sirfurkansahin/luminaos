import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * F2-T13 PR4 (RED step) — `NotetakerWebhookAuthGuard`
 * (`./notetaker-webhook-auth.guard.ts`, does NOT exist yet), ADR-0030 §f,
 * verbatim reference implementation:
 *
 *   const rawBody: Buffer = request.rawBody;
 *   const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
 *   const providedHex = request.headers['x-notetaker-signature'];
 *   if (
 *     typeof providedHex !== 'string' ||
 *     providedHex.length !== expectedHex.length ||
 *     !timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'))
 *   ) {
 *     throw new UnauthorizedError();
 *   }
 *
 * `secret` is `env.notetakerWebhookSecret` -- and per ADR-0030 §f, the guard
 * must FAIL-CLOSED (throw `UnauthorizedError` unconditionally) when that is
 * `undefined`, never silently pass a request through because "no secret
 * configured".
 *
 * ============================================================================
 * HARNESS CHOICE: this guard has no DB/session/membership dependency (unlike
 * `../mcp-server/mcp-token-auth.guard.ts`), so no Testcontainers is needed --
 * mirrors that file's `fakeExecutionContext`/`fakeRequest` hand-built-fake
 * pattern for `ExecutionContext`, the minimum surface `canActivate` touches
 * (`context.switchToHttp().getRequest()`).
 *
 * Because the guard module presumably imports `env` from
 * `../config/env.ts`'s ALREADY-EVALUATED singleton
 * (`export const env: Env = readEnv();`), and this codebase's ESTABLISHED
 * convention for a unit test that needs a SPECIFIC `env` field value per
 * test is `../common/cors.middleware.test.ts`'s / `../config/env-search.test.ts`'s
 * exact pattern (grep-confirmed, NOT a novel choice here): set `process.env`
 * BEFORE a dynamic `import('./notetaker-webhook-auth.guard.js')`, with
 * `vi.resetModules()` in `beforeEach` so each test's import re-evaluates
 * both `env.ts` and the guard module fresh against that test's own
 * `process.env.NOTETAKER_WEBHOOK_SECRET` value -- rather than mutating the
 * singleton `env` object directly (which would also work, but diverges from
 * this repo's established per-test env convention for zero benefit).
 *
 * The dynamic import is cast through an explicit constructor-shape interface
 * (mirrors `../mcp-server/mcp-token-auth.guard.test.ts`'s
 * `McpTokenAuthGuardConstructor` pattern) rather than left as an implicit
 * `any`, so this file stays clean of `@typescript-eslint/no-unsafe-*`
 * findings despite the guard module not existing yet.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./notetaker-webhook-auth.guard.ts` does not
 * exist -- every test's `await import('./notetaker-webhook-auth.guard.js')`
 * rejects with a "Cannot find module" resolution error. This is the correct
 * red, not a test-logic bug.
 * ============================================================================
 */

interface NotetakerWebhookAuthGuardConstructor {
  new (): CanActivate;
}

interface NotetakerWebhookAuthGuardModule {
  NotetakerWebhookAuthGuard: NotetakerWebhookAuthGuardConstructor;
}

async function importGuardCtor(): Promise<NotetakerWebhookAuthGuardConstructor> {
  const importedModule: unknown = await import('./notetaker-webhook-auth.guard.js');
  return (importedModule as NotetakerWebhookAuthGuardModule).NotetakerWebhookAuthGuard;
}

/**
 * `vi.resetModules()` in `beforeEach` means the guard's own dynamic import
 * re-evaluates `@luminaos/shared` fresh each test. A statically-imported
 * `UnauthorizedError` at this file's top level would be a DIFFERENT class
 * instance than the one the freshly-imported guard actually throws, so
 * `rejects.toBeInstanceOf(UnauthorizedError)` would fail despite the guard
 * behaving correctly -- dynamically importing it here, in the same
 * reset epoch as the guard, keeps both references pointing at the same
 * module instance.
 */
async function importUnauthorizedErrorCtor(): Promise<new () => Error> {
  const importedModule: unknown = await import('@luminaos/shared');
  return (importedModule as { UnauthorizedError: new () => Error }).UnauthorizedError;
}

interface NotetakerWebhookRequestShape {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

type FakeRequest = Partial<Request> & NotetakerWebhookRequestShape;

function fakeExecutionContext(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function fakeRequest(rawBody: Buffer, signatureHeader?: string): FakeRequest {
  return {
    rawBody,
    headers: signatureHeader === undefined ? {} : { 'x-notetaker-signature': signatureHeader },
  };
}

function computeSignature(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

const TEST_SECRET = 'notetaker-webhook-guard-test-secret-value';
const SAMPLE_RAW_BODY = Buffer.from(
  JSON.stringify({ providerMeetingRef: 'ref-guard-test-1', status: 'kaydedildi' }),
);

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
  delete process.env.NOTETAKER_WEBHOOK_SECRET;
});

afterEach(() => {
  restoreEnvToSnapshot();
  vi.restoreAllMocks();
});

describe('NotetakerWebhookAuthGuard (ADR-0030 §f — HMAC-SHA256 over the raw request body, timingSafeEqual comparison)', () => {
  it('1. a correctly-computed signature over the exact rawBody, with the configured secret -> canActivate resolves true', async () => {
    process.env.NOTETAKER_WEBHOOK_SECRET = TEST_SECRET;
    const GuardCtor = await importGuardCtor();
    const guard = new GuardCtor();
    const signature = computeSignature(TEST_SECRET, SAMPLE_RAW_BODY);
    const context = fakeExecutionContext(fakeRequest(SAMPLE_RAW_BODY, signature));

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('2. missing X-Notetaker-Signature header entirely -> throws UnauthorizedError', async () => {
    process.env.NOTETAKER_WEBHOOK_SECRET = TEST_SECRET;
    const GuardCtor = await importGuardCtor();
    const UnauthorizedErrorCtor = await importUnauthorizedErrorCtor();
    const guard = new GuardCtor();
    const context = fakeExecutionContext(fakeRequest(SAMPLE_RAW_BODY, undefined));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedErrorCtor);
  });

  it('3. signature header present but computed with a DIFFERENT secret than the configured one -> throws UnauthorizedError', async () => {
    process.env.NOTETAKER_WEBHOOK_SECRET = TEST_SECRET;
    const GuardCtor = await importGuardCtor();
    const UnauthorizedErrorCtor = await importUnauthorizedErrorCtor();
    const guard = new GuardCtor();
    const wrongSignature = computeSignature('a-completely-different-secret', SAMPLE_RAW_BODY);
    const context = fakeExecutionContext(fakeRequest(SAMPLE_RAW_BODY, wrongSignature));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedErrorCtor);
  });

  it('4. signature header is not valid hex / has the wrong length -> throws UnauthorizedError, WITHOUT an uncaught error escaping from Buffer.from/timingSafeEqual (the length check must short-circuit first)', async () => {
    process.env.NOTETAKER_WEBHOOK_SECRET = TEST_SECRET;
    const GuardCtor = await importGuardCtor();
    const UnauthorizedErrorCtor = await importUnauthorizedErrorCtor();
    const guard = new GuardCtor();
    const context = fakeExecutionContext(
      fakeRequest(SAMPLE_RAW_BODY, 'not-a-valid-signature-at-all'),
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedErrorCtor);
  });

  it('5. signature header has the CORRECT length but contains non-hex characters -> throws UnauthorizedError, WITHOUT an uncaught TypeError from Buffer.from silently short-decoding (security-reviewer finding, PR4)', async () => {
    process.env.NOTETAKER_WEBHOOK_SECRET = TEST_SECRET;
    const GuardCtor = await importGuardCtor();
    const UnauthorizedErrorCtor = await importUnauthorizedErrorCtor();
    const guard = new GuardCtor();
    const expectedHex = computeSignature(TEST_SECRET, SAMPLE_RAW_BODY);
    // Same length as a real hex digest, but every character is 'g' -- not a
    // valid hex character, so `Buffer.from(..., 'hex')` would silently stop
    // decoding early and hand `timingSafeEqual` a SHORTER buffer than
    // expected, throwing a TypeError instead of failing closed with 401,
    // if the guard didn't validate hex-format before comparing.
    const sameLengthNonHexSignature = 'g'.repeat(expectedHex.length);
    const context = fakeExecutionContext(fakeRequest(SAMPLE_RAW_BODY, sameLengthNonHexSignature));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedErrorCtor);
  });

  it('6. NOTETAKER_WEBHOOK_SECRET is not configured (env.notetakerWebhookSecret undefined), even with an otherwise well-formed signature header -> throws UnauthorizedError (fail-closed, ADR-0030 §f)', async () => {
    // NOTETAKER_WEBHOOK_SECRET deliberately left unset (beforeEach already
    // deletes it) -- a signature that WOULD be valid if some secret happened
    // to be configured and match proves the guard rejects on the "no secret
    // configured" branch itself, not merely because this particular
    // signature happens to mismatch some computed value.
    const wouldBeValidSignature = computeSignature(TEST_SECRET, SAMPLE_RAW_BODY);
    const GuardCtor = await importGuardCtor();
    const UnauthorizedErrorCtor = await importUnauthorizedErrorCtor();
    const guard = new GuardCtor();
    const context = fakeExecutionContext(fakeRequest(SAMPLE_RAW_BODY, wouldBeValidSignature));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedErrorCtor);
  });
});
