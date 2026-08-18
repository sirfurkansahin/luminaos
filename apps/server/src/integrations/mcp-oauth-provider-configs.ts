import { env } from '../config/env.js';

import type { OAuth2ProviderConfig } from './oauth2-authorization-code-flow.js';
import type { Env } from '../config/env.js';

/**
 * F2-T10 PR1 (ADR-0026 §l/§n): maps each connectorType to a function that
 * builds its `OAuth2ProviderConfig` from `env` -- `authorizeUrl`/`tokenUrl`/
 * `scopes` are SERVER-SIDE, hardcoded constants (never derived from request
 * input, ADR-0026 §j's anti-open-redirect design); `clientId`/`clientSecret`
 * come from the matching `env.*OAuth` reader (ADR-0026 §k). Returns
 * `undefined` when the connectorType's OAuth app credentials are not
 * configured -- the DI/controller layer's signal to reject with 404 rather
 * than silently proceed with a broken authorize URL (ADR-0026 §n Kabul
 * Kriteri: "an unconfigured connectorType ... never silently succeeding").
 *
 * The callback `redirect_uri` is deliberately WORKSPACE-INDEPENDENT
 * (`${env.serverPublicUrl}/integrations/:connectorType/oauth/callback`,
 * ADR-0026 §j) -- providers require an exact, pre-registered `redirect_uri`,
 * incompatible with a dynamic `:workspaceId` segment; workspace/user
 * correlation happens entirely via the `state` row (ADR-0026 §i).
 */
export const MCP_OAUTH_PROVIDER_CONFIGS: Record<
  string,
  (currentEnv: Env) => OAuth2ProviderConfig | undefined
> = {
  notion: (currentEnv) => {
    if (!currentEnv.notionOAuth) {
      return undefined;
    }
    return {
      authorizeUrl: 'https://mcp.notion.com/oauth/authorize',
      tokenUrl: 'https://mcp.notion.com/oauth/token',
      scopes: [],
      clientId: currentEnv.notionOAuth.clientId,
      clientSecret: currentEnv.notionOAuth.clientSecret,
      redirectUri: `${currentEnv.serverPublicUrl}/integrations/notion/oauth/callback`,
    };
  },
  'google-drive': (currentEnv) => {
    if (!currentEnv.googleDriveOAuth) {
      return undefined;
    }
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      clientId: currentEnv.googleDriveOAuth.clientId,
      clientSecret: currentEnv.googleDriveOAuth.clientSecret,
      redirectUri: `${currentEnv.serverPublicUrl}/integrations/google-drive/oauth/callback`,
    };
  },
  gmail: (currentEnv) => {
    if (!currentEnv.gmailOAuth) {
      return undefined;
    }
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      clientId: currentEnv.gmailOAuth.clientId,
      clientSecret: currentEnv.gmailOAuth.clientSecret,
      redirectUri: `${currentEnv.serverPublicUrl}/integrations/gmail/oauth/callback`,
    };
  },
  slack: (currentEnv) => {
    if (!currentEnv.slackOAuth) {
      return undefined;
    }
    return {
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: ['mcp'],
      clientId: currentEnv.slackOAuth.clientId,
      clientSecret: currentEnv.slackOAuth.clientSecret,
      redirectUri: `${currentEnv.serverPublicUrl}/integrations/slack/oauth/callback`,
    };
  },
  github: (currentEnv) => {
    if (!currentEnv.githubOAuth) {
      return undefined;
    }
    return {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:org'],
      clientId: currentEnv.githubOAuth.clientId,
      clientSecret: currentEnv.githubOAuth.clientSecret,
      redirectUri: `${currentEnv.serverPublicUrl}/integrations/github/oauth/callback`,
    };
  },
};

/** Convenience wrapper bound to the process's real, singleton `env`. */
export function getMcpOAuthProviderConfig(connectorType: string): OAuth2ProviderConfig | undefined {
  const configFactory = MCP_OAUTH_PROVIDER_CONFIGS[connectorType];
  if (!configFactory) {
    return undefined;
  }
  return configFactory(env);
}
