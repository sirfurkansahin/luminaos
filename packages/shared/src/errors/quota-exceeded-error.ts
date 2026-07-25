import { AppError } from './app-error.js';

/**
 * Thrown by `packages/ai-gateway` (and, at the domain layer, by anything
 * wrapping it) when a workspace/provider-level AI usage quota has been
 * exhausted.
 */
export class QuotaExceededError extends AppError {
  public readonly details?: unknown;

  constructor(message = 'Quota exceeded', details?: unknown) {
    super(message, 'QUOTA_EXCEEDED', 429);
    this.details = details;
  }
}
