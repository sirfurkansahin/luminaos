import { describe, expect, it } from 'vitest';

import { AppError } from './app-error.js';
import { VersionConflictError } from './version-conflict-error.js';

describe('VersionConflictError', () => {
  it('has code VERSION_CONFLICT', () => {
    const err = new VersionConflictError('11111111-1111-4111-8111-111111111111', 3);
    expect(err.code).toBe('VERSION_CONFLICT');
  });

  it('has statusCode 409', () => {
    const err = new VersionConflictError('11111111-1111-4111-8111-111111111111', 3);
    expect(err.statusCode).toBe(409);
  });

  it('is an instanceof Error and AppError', () => {
    const err = new VersionConflictError('11111111-1111-4111-8111-111111111111', 3);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof VersionConflictError).toBe(true);
  });

  it('exposes the streamId and expectedVersion it was constructed with', () => {
    const streamId = '11111111-1111-4111-8111-111111111111';
    const err = new VersionConflictError(streamId, 3);

    expect(err.streamId).toBe(streamId);
    expect(err.expectedVersion).toBe(3);
  });

  it('exposes an optional actualVersion for diagnostics when provided', () => {
    const streamId = '11111111-1111-4111-8111-111111111111';
    const err = new VersionConflictError(streamId, 3, 5);

    expect(err.actualVersion).toBe(5);
  });

  it('leaves actualVersion undefined when not provided', () => {
    const streamId = '11111111-1111-4111-8111-111111111111';
    const err = new VersionConflictError(streamId, 3);

    expect(err.actualVersion).toBeUndefined();
  });

  it('produces an informative message mentioning the stream and the expected version', () => {
    const streamId = '11111111-1111-4111-8111-111111111111';
    const err = new VersionConflictError(streamId, 3);

    expect(err.message).toContain(streamId);
    expect(err.message).toContain('3');
  });

  it('mentions the actual version in the message when provided (diagnostics)', () => {
    const streamId = '11111111-1111-4111-8111-111111111111';
    const err = new VersionConflictError(streamId, 3, 5);

    expect(err.message).toContain('5');
  });

  it('does not throw when actualVersion is omitted', () => {
    expect(() => new VersionConflictError('11111111-1111-4111-8111-111111111111', 1)).not.toThrow();
  });
});
