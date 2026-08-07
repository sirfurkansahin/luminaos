import { AppError } from '@luminaos/shared';

/**
 * Thrown by `CalendarTokenRefreshService` when the underlying
 * `CalendarConnector`'s `refreshToken` call itself fails (expired/revoked
 * refresh token, provider outage, etc.) — surfaced as a distinct 409 so
 * callers can prompt the user to re-run the OAuth connect flow rather than
 * treating it as a generic failure. Per `CLAUDE.md`, every thrown error in
 * this codebase must be an `AppError` subclass, never a bare
 * `throw new Error(...)`.
 */
export class CalendarReconnectRequiredError extends AppError {
  public readonly accountId: string;
  public readonly provider: string;

  constructor(accountId: string, provider: string) {
    super('Calendar account requires reconnection.', 'CALENDAR_RECONNECT_REQUIRED', 409);
    this.accountId = accountId;
    this.provider = provider;
  }
}
