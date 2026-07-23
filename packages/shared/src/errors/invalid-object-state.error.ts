import { AppError } from './app-error.js';

/**
 * Thrown by `packages/core-objects`' command functions for illegal lifecycle
 * transitions and for any command (other than `restoreObject`) sent to a
 * `deleted` object. See ADR-0003 "Yaşam döngüsü durum makinesi".
 */
export class InvalidObjectStateError extends AppError {
  public readonly details?: unknown;

  constructor(message = 'Invalid object state', details?: unknown) {
    super(message, 'INVALID_OBJECT_STATE', 409);
    this.details = details;
  }
}
