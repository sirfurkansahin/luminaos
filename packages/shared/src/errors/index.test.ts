import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from './index.js';

describe('UnauthorizedError', () => {
  it('has code UNAUTHORIZED', () => {
    expect(new UnauthorizedError().code).toBe('UNAUTHORIZED');
  });

  it('has statusCode 401', () => {
    expect(new UnauthorizedError().statusCode).toBe(401);
  });

  it('defaults to a reasonable message when none is provided', () => {
    const err = new UnauthorizedError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('propagates a custom message', () => {
    expect(new UnauthorizedError('token expired').message).toBe('token expired');
  });

  it('is an instanceof Error and AppError', () => {
    const err = new UnauthorizedError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
  });
});

describe('ForbiddenError', () => {
  it('has code FORBIDDEN', () => {
    expect(new ForbiddenError().code).toBe('FORBIDDEN');
  });

  it('has statusCode 403', () => {
    expect(new ForbiddenError().statusCode).toBe(403);
  });

  it('defaults to a reasonable message when none is provided', () => {
    const err = new ForbiddenError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('propagates a custom message', () => {
    expect(new ForbiddenError('not your resource').message).toBe('not your resource');
  });

  it('is an instanceof Error and AppError', () => {
    const err = new ForbiddenError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
  });
});

describe('ConflictError', () => {
  it('has code CONFLICT', () => {
    expect(new ConflictError().code).toBe('CONFLICT');
  });

  it('has statusCode 409', () => {
    expect(new ConflictError().statusCode).toBe(409);
  });

  it('defaults to a reasonable message when none is provided', () => {
    const err = new ConflictError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('propagates a custom message', () => {
    expect(new ConflictError('email already in use').message).toBe('email already in use');
  });

  it('is an instanceof Error and AppError', () => {
    const err = new ConflictError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
  });
});

describe('NotFoundError', () => {
  it('has code NOT_FOUND', () => {
    expect(new NotFoundError().code).toBe('NOT_FOUND');
  });

  it('has statusCode 404', () => {
    expect(new NotFoundError().statusCode).toBe(404);
  });

  it('defaults to a reasonable message when none is provided', () => {
    const err = new NotFoundError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('propagates a custom message', () => {
    expect(new NotFoundError('user not found').message).toBe('user not found');
  });

  it('is an instanceof Error and AppError', () => {
    const err = new NotFoundError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
  });
});

describe('ValidationError', () => {
  it('has code VALIDATION_ERROR', () => {
    expect(new ValidationError().code).toBe('VALIDATION_ERROR');
  });

  it('has statusCode 400', () => {
    expect(new ValidationError().statusCode).toBe(400);
  });

  it('defaults to a reasonable message when none is provided', () => {
    const err = new ValidationError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('propagates a custom message', () => {
    expect(new ValidationError('invalid input').message).toBe('invalid input');
  });

  it('is an instanceof Error and AppError', () => {
    const err = new ValidationError();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
  });

  it('exposes details when provided', () => {
    const details = [{ path: ['email'], message: 'Invalid email' }];
    const err = new ValidationError('invalid input', details);
    expect(err.details).toEqual(details);
  });

  it('leaves details undefined when omitted', () => {
    const err = new ValidationError('invalid input');
    expect(err.details).toBeUndefined();
  });
});
