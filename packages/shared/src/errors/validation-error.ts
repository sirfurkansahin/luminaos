import { AppError } from './app-error.js';

export class ValidationError extends AppError {
  public readonly details?: unknown;

  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400);
    this.details = details;
  }
}
