// F2-T3 PR4 (ADR-0020) — thin HTTP client for `apps/desktop`'s Tauri
// webview, mirroring `apps/web/src/lib/apiClient.ts`'s `request<T>()` /
// `ApiError` / `isServerErrorBody` pattern exactly, except every URL is
// ABSOLUTE (`${SERVER_BASE_URL}${path}`) rather than relative — the desktop
// webview has no same-origin dev proxy to the server the way `apps/web`'s
// Vite config does.
//
// `apps/desktop` has no login/session UI yet (real login is deferred to
// F2-T3b) — every call below relies on an ALREADY-EXISTING session cookie
// in the webview's own cookie store (see `apps/desktop/README.md`'s manual
// smoke-test steps).

const SERVER_BASE_URL = import.meta.env['VITE_SERVER_URL'] ?? 'http://localhost:3000';

export class ApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;

    // Explicitly restore the prototype chain — same rationale as
    // `packages/shared/src/errors/app-error.ts`'s `AppError`: without this,
    // `instanceof ApiError` can break once compiled down to a target where
    // classes are transpiled to functions.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ServerErrorBody {
  error: { code: string; message: string };
}

function isServerErrorBody(value: unknown): value is ServerErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code: unknown }).code === 'string' &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${SERVER_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    if (isServerErrorBody(body)) {
      throw new ApiError(body.error.message, body.error.code, response.status);
    }
    throw new ApiError('Beklenmeyen bir sunucu hatası oluştu', 'UNKNOWN_ERROR', response.status);
  }

  return (await response.json()) as T;
}

export interface DesktopSignalConsent {
  signalType: string;
  grantedAt: string;
  revokedAt: string | null;
}

export function grantDesktopSignalConsent(
  workspaceId: string,
  signalType: string,
): Promise<DesktopSignalConsent> {
  return request<{ consent: DesktopSignalConsent }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/context/desktop-signal-consents`,
    {
      method: 'POST',
      body: JSON.stringify({ signalType }),
    },
  ).then(({ consent }) => consent);
}

export function revokeDesktopSignalConsent(
  workspaceId: string,
  signalType: string,
): Promise<DesktopSignalConsent> {
  return request<{ consent: DesktopSignalConsent }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/context/desktop-signal-consents/${encodeURIComponent(signalType)}`,
    { method: 'DELETE' },
  ).then(({ consent }) => consent);
}

export function getDesktopSignalConsent(
  workspaceId: string,
  signalType: string,
): Promise<DesktopSignalConsent | null> {
  return request<{ consent: DesktopSignalConsent | null }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/context/desktop-signal-consents/${encodeURIComponent(signalType)}`,
    { method: 'GET' },
  ).then(({ consent }) => consent);
}

export async function captureDesktopSignal(
  workspaceId: string,
  signalType: string,
  value: string,
): Promise<void> {
  await request<{ captured: boolean }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/context/desktop-signals`,
    {
      method: 'POST',
      body: JSON.stringify({ signalType, value }),
    },
  );
}

export interface CachedCalendarEvent {
  externalId: string;
  title: string;
  start: string;
  end: string;
}

export async function listCalendarEvents(
  workspaceId: string,
  range: { start: string; end: string },
): Promise<CachedCalendarEvent[]> {
  const params = new URLSearchParams(range);
  const { events } = await request<{ events: CachedCalendarEvent[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/calendar/events?${params.toString()}`,
    { method: 'GET' },
  );
  return events;
}
