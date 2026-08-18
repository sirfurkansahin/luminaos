import { z } from 'zod';

import { ValidationError } from '@luminaos/shared';

/**
 * F2-T10 PR1 (ADR-0026 §l): the shared, provider-agnostic OAuth2
 * authorization-code helper -- protocol-level RFC 6749 mechanics common to
 * all 5 connectors (Notion first, PR1; Drive/Gmail/Slack/GitHub, PR2+). Lives
 * under `apps/server/src/integrations/` (not `packages/integrations`)
 * because it depends on `fetch`/env, a server-layer concern, not the MCP
 * protocol itself.
 */
export interface OAuth2ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface ExchangeAuthorizationCodeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/** The provider's token-exchange JSON response shape -- "her dış girdi zod
 * ile doğrulanır" applied to OAuth2, same `ZodValidationPipe` discipline as
 * every other external-input boundary in this codebase. */
const TOKEN_RESPONSE_SCHEMA = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

/**
 * Builds the provider's authorization URL the browser is redirected to.
 * `state` is opaque (ADR-0026 §i's `OAuthStateService`) and never a fixed/
 * ignored parameter. `clientSecret` never appears here (that only ever
 * travels server-to-server, in `exchangeAuthorizationCode`).
 */
export function buildAuthorizationUrl(config: OAuth2ProviderConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

/**
 * POSTs the authorization code to the provider's token endpoint
 * (`application/x-www-form-urlencoded`, RFC 6749 §4.1.3) and validates the
 * JSON response against `TOKEN_RESPONSE_SCHEMA`. Throws `ValidationError`
 * (`ZodValidationPipe`'s exact "message + zod issues array" convention) for
 * a missing/wrong-shaped `access_token`.
 */
export async function exchangeAuthorizationCode(
  config: OAuth2ProviderConfig,
  code: string,
): Promise<ExchangeAuthorizationCodeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const rawBody: unknown = await response.json();
  const result = TOKEN_RESPONSE_SCHEMA.safeParse(rawBody);

  if (!result.success) {
    throw new ValidationError(
      `OAuth token exchange for "${config.tokenUrl}" returned an unexpected shape`,
      result.error.issues,
    );
  }

  const expiresAt =
    result.data.expires_in !== undefined
      ? new Date(Date.now() + result.data.expires_in * 1000).toISOString()
      : undefined;

  return {
    accessToken: result.data.access_token,
    ...(result.data.refresh_token !== undefined ? { refreshToken: result.data.refresh_token } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
