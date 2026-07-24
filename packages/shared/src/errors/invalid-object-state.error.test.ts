import { describe, expect, it } from 'vitest';

import { AppError } from './app-error.js';
import { InvalidObjectStateError } from './invalid-object-state.error.js';

/**
 * Designed per ADR-0003 (F1-T1, PR-A): thrown by `packages/core-objects`'
 * command functions for illegal lifecycle transitions and for any command
 * (other than `restoreObject`) sent to a `deleted` object. Mirrors the
 * `ValidationError` shape (`message`, optional `details`) rather than
 * `VersionConflictError`'s bespoke required-fields shape, since there is no
 * mandatory structured context here — just a human-readable reason plus an
 * optional diagnostics bag.
 */
describe('InvalidObjectStateError', () => {
  it('has code INVALID_OBJECT_STATE', () => {
    expect(new InvalidObjectStateError().code).toBe('INVALID_OBJECT_STATE');
  });

  it('has statusCode 409', () => {
    expect(new InvalidObjectStateError().statusCode).toBe(409);
  });

  it('defaults to a reasonable message when none is provided', () => {
    const err = new InvalidObjectStateError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('propagates a custom message', () => {
    expect(new InvalidObjectStateError('cannot rename a deleted object').message).toBe(
      'cannot rename a deleted object',
    );
  });

  it('is an instanceof Error and AppError', () => {
    const err = new InvalidObjectStateError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof InvalidObjectStateError).toBe(true);
  });

  it('exposes details when provided', () => {
    const details = { objectId: '01HXYZ', lifecycle: 'deleted', attemptedAction: 'rename' };
    const err = new InvalidObjectStateError('cannot rename a deleted object', details);
    expect(err.details).toEqual(details);
  });

  it('leaves details undefined when omitted', () => {
    const err = new InvalidObjectStateError('cannot rename a deleted object');
    expect(err.details).toBeUndefined();
  });
});
