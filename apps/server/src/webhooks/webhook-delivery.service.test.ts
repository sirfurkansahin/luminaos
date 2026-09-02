import { createHmac } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { encryptSecret } from '@luminaos/shared';

/**
 * F2-T16 PR2 (RED step), ADR-0033 Karar (e)/(f) — `WebhookDeliveryService`,
 * the pure signing+HTTP delivery mechanism (no DB, no persistence -- that is
 * `WebhookDeliveryWorker`'s job in a separate integration test).
 *
 * FETCH-MOCKING CONVENTION: `vi.stubGlobal('fetch', vi.fn()...)`, this
 * codebase's own established pattern (confirmed against
 * `../integrations/oauth2-authorization-code-flow.test.ts`'s identical
 * technique -- there is no `nock`/`msw` dependency anywhere in this repo).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./webhook-delivery.service.ts` does not exist
 * yet -- the dynamic `import()` inside `beforeAll` rejects with a "Cannot
 * find module" error, failing every `it` below at setup. This is the correct
 * RED failure reason, not a test-logic bug.
 *
 * ============================================================================
 * DESIGNED CONTRACT `implementer` must match (per the PR2 task brief,
 * ADR-0033 §e/§f) -- pinned here as the exact shape this file's local
 * `WebhookDeliveryServiceContract`/`WebhookDeliveryServiceConstructor` types
 * declare:
 *
 *   export class WebhookDeliveryService {
 *     constructor(config: { encryptionKey: Buffer }) { ... }
 *     async deliver(input: {
 *       targetUrl: string;
 *       encryptedSigningSecret: string;
 *       payload: unknown;
 *     }): Promise<{ outcome: 'delivered' } | { outcome: 'failed'; sanitizedError: string }> { ... }
 *   }
 *
 *   `deliver()`:
 *     - Re-validates `targetUrl` via the SAME SSRF guard PR1 introduced
 *       (`assertSafeWebhookUrl` from `./ssrf-guard.ts`) IMMEDIATELY before any
 *       network call (ADR-0033 Karar a/f) -- a rejected URL means `fetch` is
 *       NEVER called, and the outcome is `{ outcome: 'failed', sanitizedError }`
 *       with a SHORT, sanitized error (never a stack trace).
 *     - Decrypts `encryptedSigningSecret` via `decryptSecret` (from
 *       `@luminaos/shared`) using the injected `encryptionKey`.
 *     - Computes `timestamp` = current unix SECONDS, `body` =
 *       `JSON.stringify(input.payload)` -- exactly ONE call. Signs
 *       `${timestamp}.${body}` via HMAC-SHA256 with the decrypted secret.
 *     - Sends `body` as the LITERAL request payload, with headers
 *       `X-LuminaOS-Timestamp: <timestamp>` and
 *       `X-LuminaOS-Signature: sha256=<hex-hmac>`.
 *     - Calls `fetch(targetUrl, { redirect: 'manual', signal: <AbortSignal>, ... })`
 *       -- never follows a redirect, always attaches a timeout signal.
 *     - A 2xx response -> `{ outcome: 'delivered' }`.
 *     - A non-2xx response -> `{ outcome: 'failed', sanitizedError: 'HTTP <status>' }`
 *       (or similar) -- NEVER includes the response BODY content (ADR-0033
 *       Karar f, "yanıt gövdesi ASLA loglanmaz").
 *     - A rejected/thrown `fetch` (network error, timeout) -> `{ outcome:
 *       'failed', sanitizedError }`, NEVER an uncaught throw out of `deliver()`.
 * ============================================================================
 */

interface DeliverInput {
  targetUrl: string;
  encryptedSigningSecret: string;
  payload: unknown;
}

type DeliverResult = { outcome: 'delivered' } | { outcome: 'failed'; sanitizedError: string };

interface WebhookDeliveryServiceContract {
  deliver(input: DeliverInput): Promise<DeliverResult>;
}

interface WebhookDeliveryServiceConfig {
  encryptionKey: Buffer;
}

type WebhookDeliveryServiceConstructor = new (
  config: WebhookDeliveryServiceConfig,
) => WebhookDeliveryServiceContract;

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 5);
const KNOWN_PLAINTEXT_SECRET = 'fixture-signing-secret-0123456789abcdef';
const KNOWN_ENCRYPTED_SECRET = encryptSecret(KNOWN_PLAINTEXT_SECRET, TEST_ENCRYPTION_KEY);
const LEAKED_BODY_MARKER = '__leaked-response-body-marker__';

let WebhookDeliveryServiceCtor: WebhookDeliveryServiceConstructor;

beforeAll(async () => {
  // Deliberately unresolvable until `implementer` creates
  // `./webhook-delivery.service.ts` -- see this file's header for why the
  // resulting `import-x/no-unresolved` finding is expected and contained to
  // this one line.

  const importedModule: unknown = await import('./webhook-delivery.service.js');
  WebhookDeliveryServiceCtor = (
    importedModule as { WebhookDeliveryService: WebhookDeliveryServiceConstructor }
  ).WebhookDeliveryService;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createService(): WebhookDeliveryServiceContract {
  return new WebhookDeliveryServiceCtor({ encryptionKey: TEST_ENCRYPTION_KEY });
}

function stubFetch(
  implementation: (url: unknown, init: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubFetchResolved(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('WebhookDeliveryService.deliver (ADR-0033 Karar e/f)', () => {
  // ---------------------------------------------------------------------
  // Signature/body canonicalization
  // ---------------------------------------------------------------------

  it('signs and sends the SAME single JSON.stringify(payload) call as both the HMAC input and the literal request body, with the correct headers', async () => {
    let capturedUrl: unknown;
    let capturedInit: RequestInit | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const payload = {
      eventType: 'ActionsProposed',
      occurredAt: '2026-09-02T00:00:00.000Z',
      data: { a: 1 },
    };
    const service = createService();
    const beforeCall = Math.floor(Date.now() / 1000);

    const result = await service.deliver({
      // NOTE (implementer, PR2 RED->GREEN): `assertSafeWebhookUrl` (reused
      // unmodified from PR1) performs a REAL `dns.lookup` for any non-literal-
      // IP hostname immediately before `fetch` -- this file only stubs
      // `fetch`, not DNS -- so this fixture host must actually resolve on the
      // real internet. `example.com` (bare, no subdomain) is IANA's
      // documentation domain and does resolve; an arbitrary subdomain like
      // the previous `receiver.example.com` does NOT (verified against two
      // independent public resolvers) and would make every test below fail
      // with `sanitizedError: 'ssrf-rejected'` regardless of implementation
      // correctness, in any network-connected environment.
      targetUrl: 'https://example.com/hook',
      encryptedSigningSecret: KNOWN_ENCRYPTED_SECRET,
      payload,
    });

    expect(result).toEqual({ outcome: 'delivered' });
    expect(capturedUrl).toBe('https://example.com/hook');
    expect(capturedInit).toBeDefined();

    const headers = new Headers(capturedInit?.headers);
    const timestampHeader = headers.get('X-LuminaOS-Timestamp');
    const signatureHeader = headers.get('X-LuminaOS-Signature');
    expect(timestampHeader).toMatch(/^\d+$/);
    const timestamp = Number(timestampHeader);
    expect(timestamp).toBeGreaterThanOrEqual(beforeCall);
    expect(timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5);

    const body = capturedInit?.body as string;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual(payload);

    const expectedHmac = createHmac('sha256', KNOWN_PLAINTEXT_SECRET)
      .update(`${String(timestamp)}.${body}`)
      .digest('hex');
    expect(signatureHeader).toBe(`sha256=${expectedHmac}`);
  });

  it("sends fetch with redirect: 'manual' and an AbortSignal (timeout) attached", async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_url, init) => {
      capturedInit = init;
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const service = createService();
    await service.deliver({
      targetUrl: 'https://example.com/hook',
      encryptedSigningSecret: KNOWN_ENCRYPTED_SECRET,
      payload: { any: 'thing' },
    });

    expect(capturedInit?.redirect).toBe('manual');
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  // ---------------------------------------------------------------------
  // 2xx -> delivered
  // ---------------------------------------------------------------------

  it('a 2xx response resolves to { outcome: "delivered" }', async () => {
    stubFetchResolved(new Response(null, { status: 204 }));

    const service = createService();
    const result = await service.deliver({
      targetUrl: 'https://example.com/hook',
      encryptedSigningSecret: KNOWN_ENCRYPTED_SECRET,
      payload: { any: 'thing' },
    });

    expect(result).toEqual({ outcome: 'delivered' });
  });

  // ---------------------------------------------------------------------
  // non-2xx -> failed, response body never surfaced
  // ---------------------------------------------------------------------

  it('a non-2xx response resolves to { outcome: "failed" } with a sanitized error that NEVER contains the response body content', async () => {
    stubFetchResolved(new Response(LEAKED_BODY_MARKER, { status: 500 }));

    const service = createService();
    const result = await service.deliver({
      targetUrl: 'https://example.com/hook',
      encryptedSigningSecret: KNOWN_ENCRYPTED_SECRET,
      payload: { any: 'thing' },
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.sanitizedError).not.toContain(LEAKED_BODY_MARKER);
      expect(result.sanitizedError).toContain('500');
      expect(result.sanitizedError.length).toBeLessThan(200);
    }
  });

  // ---------------------------------------------------------------------
  // fetch rejects (network error/timeout) -> failed, never an uncaught throw
  // ---------------------------------------------------------------------

  it('a rejected fetch (network error) resolves to { outcome: "failed" }, never an uncaught throw out of deliver()', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('simulated network failure'));
    vi.stubGlobal('fetch', fetchMock);

    const service = createService();

    await expect(
      service.deliver({
        targetUrl: 'https://example.com/hook',
        encryptedSigningSecret: KNOWN_ENCRYPTED_SECRET,
        payload: { any: 'thing' },
      }),
    ).resolves.toMatchObject({ outcome: 'failed' });
  });

  // ---------------------------------------------------------------------
  // Delivery-time SSRF re-validation (ADR-0033 Karar a/f)
  // ---------------------------------------------------------------------

  it('a targetUrl that is a literal private/reserved IP is rejected BEFORE any fetch call, with a short sanitized error (never a stack trace)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const service = createService();
    const result = await service.deliver({
      targetUrl: 'https://169.254.169.254/hook',
      encryptedSigningSecret: KNOWN_ENCRYPTED_SECRET,
      payload: { any: 'thing' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.sanitizedError.length).toBeLessThan(50);
      expect(result.sanitizedError).not.toMatch(/\n/);
    }
  });
});
