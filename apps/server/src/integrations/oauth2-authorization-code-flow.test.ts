import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ValidationError } from '@luminaos/shared';

/**
 * F2-T10 PR1 (RED step), ADR-0026 §l — the shared, provider-agnostic OAuth2
 * authorization-code helper (`./oauth2-authorization-code-flow.ts`, does NOT
 * exist yet): `buildAuthorizationUrl`/`exchangeAuthorizationCode`, the exact
 * function signatures pinned by ADR-0026 §l's code block.
 *
 * The contract below is declared LOCALLY (rather than a top-level `import`/
 * `import type` from the not-yet-existing module) and loaded via a single
 * dynamic `import()` in `beforeAll` -- this contains the resulting
 * `import-x/no-unresolved` finding to that one line, instead of cascading
 * `@typescript-eslint/no-unsafe-*` errors through every call site below,
 * mirroring `../commands/commands.service.integration.test.ts`'s identical
 * technique for the exact same "own module doesn't exist yet" reason.
 *
 * ============================================================================
 * FETCH-MOCKING CONVENTION: this codebase's own established pattern for
 * mocking outbound `fetch` calls is `vi.stubGlobal('fetch', vi.fn()...)`,
 * confirmed against `apps/web/src/lib/apiClient.test.ts`'s
 * `mockFetchOnce`/`getFetchMock` helpers (there is no `nock`/`msw` dependency
 * anywhere in this repo, confirmed by search) -- this file follows the SAME
 * convention on the server side (Node's native `fetch` is stubbable the
 * identical way; there is nothing web-specific about the technique).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./oauth2-authorization-code-flow.ts` does not
 * exist. `beforeAll`'s dynamic `import()` rejects with a "Cannot find
 * module" resolution error, failing every test in this file at setup --
 * this is the correct red, not a test-logic bug.
 * ============================================================================
 */

export interface OAuth2ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface ExchangeAuthorizationCodeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

type BuildAuthorizationUrlFn = (config: OAuth2ProviderConfig, state: string) => string;
type ExchangeAuthorizationCodeFn = (
  config: OAuth2ProviderConfig,
  code: string,
) => Promise<ExchangeAuthorizationCodeResult>;

let buildAuthorizationUrl: BuildAuthorizationUrlFn;
let exchangeAuthorizationCode: ExchangeAuthorizationCodeFn;

beforeAll(async () => {
  // Deliberately unresolvable until `implementer` creates
  // `./oauth2-authorization-code-flow.ts` -- see this file's header for why
  // the resulting `import-x/no-unresolved` finding is expected and
  // contained to this one line.
  const importedModule: unknown = await import('./oauth2-authorization-code-flow.js');
  const typedModule = importedModule as {
    buildAuthorizationUrl: BuildAuthorizationUrlFn;
    exchangeAuthorizationCode: ExchangeAuthorizationCodeFn;
  };
  buildAuthorizationUrl = typedModule.buildAuthorizationUrl;
  exchangeAuthorizationCode = typedModule.exchangeAuthorizationCode;
});

function fixtureConfig(overrides: Partial<OAuth2ProviderConfig> = {}): OAuth2ProviderConfig {
  return {
    authorizeUrl: 'https://mcp.notion.com/oauth/authorize',
    tokenUrl: 'https://mcp.notion.com/oauth/token',
    scopes: ['read', 'write'],
    clientId: 'fixture-client-id',
    clientSecret: 'fixture-client-secret',
    redirectUri: 'https://lumina.example.com/integrations/notion/oauth/callback',
    ...overrides,
  };
}

function mockFetchOnceJson(
  status: number,
  body: unknown,
  ok = status >= 200 && status < 300,
): void {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
}

function getFetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildAuthorizationUrl (ADR-0026 §l)', () => {
  it('1. uses config.authorizeUrl as the base, with client_id/redirect_uri/scope/state/response_type=code as query params', () => {
    const config = fixtureConfig();

    const url = new URL(buildAuthorizationUrl(config, 'fixture-state-token'));

    expect(`${url.origin}${url.pathname}`).toBe(config.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('state')).toBe('fixture-state-token');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('2. joins multiple scopes into a single space-delimited "scope" query param', () => {
    const config = fixtureConfig({ scopes: ['read', 'write', 'search'] });

    const url = new URL(buildAuthorizationUrl(config, 'fixture-state-token'));

    expect(url.searchParams.get('scope')).toBe('read write search');
  });

  it('3. never leaks clientSecret into the authorization URL', () => {
    const config = fixtureConfig();

    const url = buildAuthorizationUrl(config, 'fixture-state-token');

    expect(url).not.toContain(config.clientSecret);
  });

  it('4. different state values produce different URLs (state is not a fixed/ignored param)', () => {
    const config = fixtureConfig();

    const first = buildAuthorizationUrl(config, 'state-one');
    const second = buildAuthorizationUrl(config, 'state-two');

    expect(first).not.toBe(second);
  });
});

describe('exchangeAuthorizationCode (ADR-0026 §l)', () => {
  it('5. POSTs to config.tokenUrl as application/x-www-form-urlencoded, with grant_type=authorization_code + code + client_id + client_secret + redirect_uri in the body', async () => {
    mockFetchOnceJson(200, { access_token: 'fixture-access-token' });
    const config = fixtureConfig();

    await exchangeAuthorizationCode(config, 'fixture-auth-code');

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config.tokenUrl);
    expect(init.method).toBe('POST');

    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded');

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('fixture-auth-code');
    expect(body.get('client_id')).toBe(config.clientId);
    expect(body.get('client_secret')).toBe(config.clientSecret);
    expect(body.get('redirect_uri')).toBe(config.redirectUri);
  });

  it('6. maps a valid {access_token} response to {accessToken}, with refreshToken/expiresAt undefined when absent from the response', async () => {
    mockFetchOnceJson(200, { access_token: 'fixture-access-token' });
    const config = fixtureConfig();

    const result = await exchangeAuthorizationCode(config, 'fixture-auth-code');

    expect(result.accessToken).toBe('fixture-access-token');
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
  });

  it('7. maps {access_token, refresh_token} to {accessToken, refreshToken}', async () => {
    mockFetchOnceJson(200, {
      access_token: 'fixture-access-token',
      refresh_token: 'fixture-refresh-token',
    });
    const config = fixtureConfig();

    const result = await exchangeAuthorizationCode(config, 'fixture-auth-code');

    expect(result.accessToken).toBe('fixture-access-token');
    expect(result.refreshToken).toBe('fixture-refresh-token');
  });

  it('8. maps {expires_in} (seconds from now) to an absolute expiresAt ISO timestamp string', async () => {
    const beforeCallMs = Date.now();
    mockFetchOnceJson(200, {
      access_token: 'fixture-access-token',
      expires_in: 3600,
    });
    const config = fixtureConfig();

    const result = await exchangeAuthorizationCode(config, 'fixture-auth-code');
    const afterCallMs = Date.now();

    expect(result.expiresAt).toBeDefined();
    const expiresAtMs = new Date(result.expiresAt as string).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(beforeCallMs + 3600 * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(afterCallMs + 3600 * 1000 + 1000);
  });

  it('9. throws ValidationError (ZodValidationPipe\'s exact "message + zod issues array" convention) when the token response is missing access_token', async () => {
    mockFetchOnceJson(200, { token_type: 'bearer' });
    const config = fixtureConfig();

    let caught: unknown;
    try {
      await exchangeAuthorizationCode(config, 'fixture-auth-code');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const validationError = caught as ValidationError;
    expect(Array.isArray(validationError.details)).toBe(true);
    expect((validationError.details as unknown[]).length).toBeGreaterThan(0);
  });

  it('10. throws ValidationError when access_token is present but not a string (wrong-shaped field, not just missing)', async () => {
    mockFetchOnceJson(200, { access_token: 12345 });
    const config = fixtureConfig();

    await expect(exchangeAuthorizationCode(config, 'fixture-auth-code')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
