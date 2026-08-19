import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpConnector, McpConnectorRegistry } from '@luminaos/integrations';

/**
 * F2-T10 PR1 (RED step), ADR-0026 §m — the env-gated DI-factory pattern for
 * `NOTION_MCP_CONNECTOR` (`./mcp-connectors.module.ts`, does NOT exist yet),
 * mirroring `../calendar/calendar-connector.module.ts`'s `useFactory`
 * pattern with a per-connector-type DI token.
 *
 * Because `../config/env.ts` exports an ALREADY-EVALUATED singleton
 * (`export const env: Env = readEnv();`) that `./mcp-connectors.module.ts`
 * reads at DI-factory-construction time, this file follows
 * `../config/env-calendar.test.ts`'s EXACT established precedent for testing
 * env-var-gated behavior in isolation: `vi.resetModules()` in `beforeEach`,
 * `process.env` set BEFORE each dynamic `import('./mcp-connectors.module.js')`
 * (which transitively re-imports `../config/env.js` fresh), and a full
 * `process.env` snapshot restore in `afterEach` so mutated env vars never
 * leak into another test file sharing this Vitest worker process.
 *
 * `McpConnectorRegistry` (`@luminaos/integrations`) already exists (F2-T9)
 * and has no import-time side effects, so it is imported statically as a
 * TYPE only; `McpConnectorsModule`/`NOTION_MCP_CONNECTOR`/
 * `MCP_CONNECTOR_REGISTRY` do not exist yet and are loaded via the dynamic
 * import above, per this file's own header note.
 *
 * ============================================================================
 * INTERPRETING "invoking .getAccessToken() throws" (task brief's wording):
 * `getAccessToken` is a PRIVATE constructor callback inside
 * `StreamableHttpMcpConnector` (ADR-0026 §g) -- there is no public
 * `.getAccessToken()` method on a connector instance to call directly. The
 * only PUBLIC, observable manifestation of ADR-0026 §m's "registry
 * membership ≠ live session" landmine is `connect()` (the one public method
 * that invokes `getAccessToken` internally, per §g's pinned body) rejecting
 * with `InvalidObjectStateError` when called on the registry-resolved
 * instance -- this file tests THAT, as the closest faithful, actually-
 * possible proof of the same guarantee.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./mcp-connectors.module.ts` does not exist.
 * Every dynamic `import('./mcp-connectors.module.js')` below rejects with a
 * "Cannot find module" resolution error, failing every test in this file at
 * runtime -- this is the correct red, not a test-logic bug.
 * ============================================================================
 */

interface McpConnectorsModuleExports {
  McpConnectorsModule: new () => object;
  NOTION_MCP_CONNECTOR: string;
  GOOGLE_DRIVE_MCP_CONNECTOR: string;
  GMAIL_MCP_CONNECTOR: string;
  SLACK_MCP_CONNECTOR: string;
  GITHUB_MCP_CONNECTOR: string;
  MCP_CONNECTOR_REGISTRY: string;
}

const ENV_SNAPSHOT = { ...process.env };

function restoreEnvToSnapshot(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_SNAPSHOT)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, ENV_SNAPSHOT);
}

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgres://unit-test-placeholder/db';
  process.env.REDIS_URL = 'redis://unit-test-placeholder:6379';
});

afterEach(() => {
  restoreEnvToSnapshot();
  vi.restoreAllMocks();
});

async function importMcpConnectorsModule(): Promise<McpConnectorsModuleExports> {
  // Deliberately unresolvable until `implementer` creates
  // `./mcp-connectors.module.ts` -- see this file's header for why the
  // resulting "Cannot find module" runtime error is expected.
  const importedModule: unknown = await import('./mcp-connectors.module.js');
  return importedModule as McpConnectorsModuleExports;
}

// `vi.resetModules()` (beforeEach) means every dynamic
// `import('./mcp-connectors.module.js')` re-evaluates its ENTIRE transitive
// module graph fresh, including `@luminaos/shared` -- so the
// `InvalidObjectStateError` class the module-under-test throws is a
// DIFFERENT class reference than one imported statically at this file's top
// level (evaluated once, before any reset). `instanceof` across those two
// module instances always fails even though the thrown error's shape is
// identical. Re-importing `@luminaos/shared` fresh, in the same reset
// "generation" as the module under test, keeps both sides pointing at the
// same class.
async function importInvalidObjectStateError(): Promise<new (message: string) => Error> {
  const sharedModule: unknown = await import('@luminaos/shared');
  return (sharedModule as { InvalidObjectStateError: new (message: string) => Error })
    .InvalidObjectStateError;
}

describe('McpConnectorsModule — NOTION_MCP_CONNECTOR DI factory (ADR-0026 §m)', () => {
  it('1. when NOTION_CLIENT_ID/NOTION_CLIENT_SECRET are BOTH unset, NOTION_MCP_CONNECTOR resolves to undefined, and nothing is registered in McpConnectorRegistry under "notion"', async () => {
    delete process.env.NOTION_CLIENT_ID;
    delete process.env.NOTION_CLIENT_SECRET;

    const { McpConnectorsModule, NOTION_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const notionConnector = moduleRef.get<McpConnector | undefined>(NOTION_MCP_CONNECTOR);
    expect(notionConnector).toBeUndefined();

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    // `McpConnectorRegistry.get` returns `undefined` (never throws) for an
    // unregistered connectorType -- ADR-0025 §g's own established contract.
    expect(registry.get('notion')).toBeUndefined();
  });

  it('2. when NOTION_CLIENT_ID/NOTION_CLIENT_SECRET are BOTH set, NOTION_MCP_CONNECTOR resolves to a real connector registered under "notion" in McpConnectorRegistry', async () => {
    process.env.NOTION_CLIENT_ID = 'fixture-notion-client-id';
    process.env.NOTION_CLIENT_SECRET = 'fixture-notion-client-secret';

    const { McpConnectorsModule, NOTION_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const notionConnector = moduleRef.get<McpConnector | undefined>(NOTION_MCP_CONNECTOR);
    expect(notionConnector).toBeDefined();
    expect(notionConnector?.connectorType).toBe('notion');

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('notion')).toBe(notionConnector);
  });

  it("3. the registered instance's connect() throws InvalidObjectStateError -- registry membership is NOT a live, per-user session (ADR-0026 §m's defensive landmine is actually enforced, not just described in a comment)", async () => {
    process.env.NOTION_CLIENT_ID = 'fixture-notion-client-id';
    process.env.NOTION_CLIENT_SECRET = 'fixture-notion-client-secret';

    const { McpConnectorsModule, NOTION_MCP_CONNECTOR } = await importMcpConnectorsModule();
    const InvalidObjectStateError = await importInvalidObjectStateError();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const notionConnector = moduleRef.get<McpConnector>(NOTION_MCP_CONNECTOR);

    await expect(notionConnector.connect()).rejects.toBeInstanceOf(InvalidObjectStateError);
  });
});

/**
 * F2-T10 PR2 (RED step), ADR-0026 §d/§m — mechanical repeat of the
 * `NOTION_MCP_CONNECTOR` DI-factory pattern above for the 4 remaining
 * connector types (`GOOGLE_DRIVE_MCP_CONNECTOR`/`GMAIL_MCP_CONNECTOR`/
 * `SLACK_MCP_CONNECTOR`/`GITHUB_MCP_CONNECTOR`), none of which
 * `./mcp-connectors.module.ts` exports yet — same "Cannot find module"-style
 * RED (the dynamic `import('./mcp-connectors.module.js')` itself still
 * resolves once `implementer` adds Notion's PR1 factory, but destructuring a
 * token this file references that the module doesn't export yields
 * `undefined`, so `Test.createTestingModule` fails to resolve/inject it --
 * an equally legitimate "implementation incomplete" red as PR1's literal
 * module-not-found error, not a test-logic bug).
 */
describe('McpConnectorsModule — GOOGLE_DRIVE_MCP_CONNECTOR DI factory (ADR-0026 §d/§m)', () => {
  it('1. when GOOGLE_DRIVE_CLIENT_ID/GOOGLE_DRIVE_CLIENT_SECRET are BOTH unset, GOOGLE_DRIVE_MCP_CONNECTOR resolves to undefined, and nothing is registered in McpConnectorRegistry under "google-drive"', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;

    const { McpConnectorsModule, GOOGLE_DRIVE_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const googleDriveConnector = moduleRef.get<McpConnector | undefined>(
      GOOGLE_DRIVE_MCP_CONNECTOR,
    );
    expect(googleDriveConnector).toBeUndefined();

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('google-drive')).toBeUndefined();
  });

  it('2. when GOOGLE_DRIVE_CLIENT_ID/GOOGLE_DRIVE_CLIENT_SECRET are BOTH set, GOOGLE_DRIVE_MCP_CONNECTOR resolves to a real connector registered under "google-drive" in McpConnectorRegistry', async () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'fixture-google-drive-client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'fixture-google-drive-client-secret';

    const { McpConnectorsModule, GOOGLE_DRIVE_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const googleDriveConnector = moduleRef.get<McpConnector | undefined>(
      GOOGLE_DRIVE_MCP_CONNECTOR,
    );
    expect(googleDriveConnector).toBeDefined();
    expect(googleDriveConnector?.connectorType).toBe('google-drive');

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('google-drive')).toBe(googleDriveConnector);
  });

  it("3. the registered instance's connect() throws InvalidObjectStateError -- registry membership is NOT a live, per-user session (ADR-0026 §m's defensive landmine is actually enforced, not just described in a comment)", async () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = 'fixture-google-drive-client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'fixture-google-drive-client-secret';

    const { McpConnectorsModule, GOOGLE_DRIVE_MCP_CONNECTOR } = await importMcpConnectorsModule();
    const InvalidObjectStateError = await importInvalidObjectStateError();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const googleDriveConnector = moduleRef.get<McpConnector>(GOOGLE_DRIVE_MCP_CONNECTOR);

    await expect(googleDriveConnector.connect()).rejects.toBeInstanceOf(InvalidObjectStateError);
  });
});

describe('McpConnectorsModule — GMAIL_MCP_CONNECTOR DI factory (ADR-0026 §d/§m)', () => {
  it('1. when GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET are BOTH unset, GMAIL_MCP_CONNECTOR resolves to undefined, and nothing is registered in McpConnectorRegistry under "gmail"', async () => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;

    const { McpConnectorsModule, GMAIL_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const gmailConnector = moduleRef.get<McpConnector | undefined>(GMAIL_MCP_CONNECTOR);
    expect(gmailConnector).toBeUndefined();

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('gmail')).toBeUndefined();
  });

  it('2. when GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET are BOTH set, GMAIL_MCP_CONNECTOR resolves to a real connector registered under "gmail" in McpConnectorRegistry', async () => {
    process.env.GMAIL_CLIENT_ID = 'fixture-gmail-client-id';
    process.env.GMAIL_CLIENT_SECRET = 'fixture-gmail-client-secret';

    const { McpConnectorsModule, GMAIL_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const gmailConnector = moduleRef.get<McpConnector | undefined>(GMAIL_MCP_CONNECTOR);
    expect(gmailConnector).toBeDefined();
    expect(gmailConnector?.connectorType).toBe('gmail');

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('gmail')).toBe(gmailConnector);
  });

  it("3. the registered instance's connect() throws InvalidObjectStateError -- registry membership is NOT a live, per-user session (ADR-0026 §m's defensive landmine is actually enforced, not just described in a comment)", async () => {
    process.env.GMAIL_CLIENT_ID = 'fixture-gmail-client-id';
    process.env.GMAIL_CLIENT_SECRET = 'fixture-gmail-client-secret';

    const { McpConnectorsModule, GMAIL_MCP_CONNECTOR } = await importMcpConnectorsModule();
    const InvalidObjectStateError = await importInvalidObjectStateError();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const gmailConnector = moduleRef.get<McpConnector>(GMAIL_MCP_CONNECTOR);

    await expect(gmailConnector.connect()).rejects.toBeInstanceOf(InvalidObjectStateError);
  });
});

describe('McpConnectorsModule — SLACK_MCP_CONNECTOR DI factory (ADR-0026 §d/§m)', () => {
  it('1. when SLACK_CLIENT_ID/SLACK_CLIENT_SECRET are BOTH unset, SLACK_MCP_CONNECTOR resolves to undefined, and nothing is registered in McpConnectorRegistry under "slack"', async () => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;

    const { McpConnectorsModule, SLACK_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const slackConnector = moduleRef.get<McpConnector | undefined>(SLACK_MCP_CONNECTOR);
    expect(slackConnector).toBeUndefined();

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('slack')).toBeUndefined();
  });

  it('2. when SLACK_CLIENT_ID/SLACK_CLIENT_SECRET are BOTH set, SLACK_MCP_CONNECTOR resolves to a real connector registered under "slack" in McpConnectorRegistry', async () => {
    process.env.SLACK_CLIENT_ID = 'fixture-slack-client-id';
    process.env.SLACK_CLIENT_SECRET = 'fixture-slack-client-secret';

    const { McpConnectorsModule, SLACK_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const slackConnector = moduleRef.get<McpConnector | undefined>(SLACK_MCP_CONNECTOR);
    expect(slackConnector).toBeDefined();
    expect(slackConnector?.connectorType).toBe('slack');

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('slack')).toBe(slackConnector);
  });

  it("3. the registered instance's connect() throws InvalidObjectStateError -- registry membership is NOT a live, per-user session (ADR-0026 §m's defensive landmine is actually enforced, not just described in a comment)", async () => {
    process.env.SLACK_CLIENT_ID = 'fixture-slack-client-id';
    process.env.SLACK_CLIENT_SECRET = 'fixture-slack-client-secret';

    const { McpConnectorsModule, SLACK_MCP_CONNECTOR } = await importMcpConnectorsModule();
    const InvalidObjectStateError = await importInvalidObjectStateError();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const slackConnector = moduleRef.get<McpConnector>(SLACK_MCP_CONNECTOR);

    await expect(slackConnector.connect()).rejects.toBeInstanceOf(InvalidObjectStateError);
  });
});

describe('McpConnectorsModule — GITHUB_MCP_CONNECTOR DI factory (ADR-0026 §d/§m)', () => {
  it('1. when GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are BOTH unset, GITHUB_MCP_CONNECTOR resolves to undefined, and nothing is registered in McpConnectorRegistry under "github"', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    const { McpConnectorsModule, GITHUB_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const githubConnector = moduleRef.get<McpConnector | undefined>(GITHUB_MCP_CONNECTOR);
    expect(githubConnector).toBeUndefined();

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('github')).toBeUndefined();
  });

  it('2. when GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are BOTH set, GITHUB_MCP_CONNECTOR resolves to a real connector registered under "github" in McpConnectorRegistry', async () => {
    process.env.GITHUB_CLIENT_ID = 'fixture-github-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'fixture-github-client-secret';

    const { McpConnectorsModule, GITHUB_MCP_CONNECTOR, MCP_CONNECTOR_REGISTRY } =
      await importMcpConnectorsModule();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const githubConnector = moduleRef.get<McpConnector | undefined>(GITHUB_MCP_CONNECTOR);
    expect(githubConnector).toBeDefined();
    expect(githubConnector?.connectorType).toBe('github');

    const registry = moduleRef.get<McpConnectorRegistry>(MCP_CONNECTOR_REGISTRY);
    expect(registry.get('github')).toBe(githubConnector);
  });

  it("3. the registered instance's connect() throws InvalidObjectStateError -- registry membership is NOT a live, per-user session (ADR-0026 §m's defensive landmine is actually enforced, not just described in a comment)", async () => {
    process.env.GITHUB_CLIENT_ID = 'fixture-github-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'fixture-github-client-secret';

    const { McpConnectorsModule, GITHUB_MCP_CONNECTOR } = await importMcpConnectorsModule();
    const InvalidObjectStateError = await importInvalidObjectStateError();

    const moduleRef = await Test.createTestingModule({
      imports: [McpConnectorsModule],
    }).compile();

    const githubConnector = moduleRef.get<McpConnector>(GITHUB_MCP_CONNECTOR);

    await expect(githubConnector.connect()).rejects.toBeInstanceOf(InvalidObjectStateError);
  });
});
