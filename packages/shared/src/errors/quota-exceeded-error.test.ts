import { describe, expect, it } from 'vitest';

import { AppError } from './app-error.js';
import { QuotaExceededError } from './quota-exceeded-error.js';

/**
 * F1-T5 PR-B (RED step) — thrown by `packages/ai-gateway` (and, at the
 * domain layer, by anything wrapping it) when a workspace/provider-level AI
 * usage quota has been exhausted. Mirrors `InvalidObjectStateError`'s exact
 * structure/test convention: `code`, `statusCode`, default message, custom
 * message, `instanceof` checks, `details` exposed/undefined.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/shared/src/errors/quota-exceeded-error.ts` and re-exports it
 * from `packages/shared/src/errors/index.ts`.
 */
describe('QuotaExceededError', () => {
  it('has code QUOTA_EXCEEDED', () => {
    expect(new QuotaExceededError().code).toBe('QUOTA_EXCEEDED');
  });

  it('has statusCode 429', () => {
    expect(new QuotaExceededError().statusCode).toBe(429);
  });

  it('defaults to a reasonable message when none is provided', () => {
    const err = new QuotaExceededError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('propagates a custom message', () => {
    expect(new QuotaExceededError('monthly AI quota exceeded').message).toBe(
      'monthly AI quota exceeded',
    );
  });

  it('is an instanceof Error and AppError', () => {
    const err = new QuotaExceededError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof QuotaExceededError).toBe(true);
  });

  it('exposes details when provided', () => {
    const details = { workspaceId: '01HXYZ', provider: 'anthropic', limit: 1000 };
    const err = new QuotaExceededError('monthly AI quota exceeded', details);
    expect(err.details).toEqual(details);
  });

  it('leaves details undefined when omitted', () => {
    const err = new QuotaExceededError('monthly AI quota exceeded');
    expect(err.details).toBeUndefined();
  });
});
