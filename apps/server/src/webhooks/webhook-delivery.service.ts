import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { decryptSecret } from '@luminaos/shared';

import { assertSafeWebhookUrl } from './ssrf-guard.js';

const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookDeliveryServiceConfig {
  /**
   * Security-review finding (F2-T16 PR2): deliberately `Buffer | undefined`,
   * not a required `Buffer` -- `webhooks.module.ts` passes `env.encryptionKey`
   * straight through without an eager boot-time check, mirroring
   * `ConnectorCredentialsService`/`WebhookSubscriptionsService`'s own
   * established "absent -> fail lazily, per call, never at boot" convention
   * (`env.ts`'s own doc comment: "a deployment without calendar features
   * configured must not crash boot over this"). An unconfigured key means
   * every `deliver()` call fails with a short sanitized outcome instead of
   * the whole server refusing to start over an unrelated feature's config.
   */
  encryptionKey: Buffer | undefined;
}

export interface WebhookDeliverInput {
  targetUrl: string;
  encryptedSigningSecret: string;
  payload: unknown;
}

export type WebhookDeliverResult =
  { outcome: 'delivered' } | { outcome: 'failed'; sanitizedError: string };

/**
 * `WebhookDeliveryService` (F2-T16 PR2, ADR-0033 §e/§f): the pure
 * signing+HTTP delivery mechanism. No DB access, no persistence -- that is
 * `WebhookDeliveryWorker`'s job (`./webhook-delivery-worker.service.ts`).
 *
 * Every failure path returns a SHORT, sanitized `sanitizedError` string
 * (never a stack trace, never the raw response body -- ADR-0033 §f, "yanıt
 * gövdesi ASLA loglanmaz") rather than throwing, so a caller never needs its
 * own try/catch around `deliver()`.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly encryptionKey: Buffer | undefined;

  constructor(config: WebhookDeliveryServiceConfig) {
    this.encryptionKey = config.encryptionKey;
  }

  async deliver(input: WebhookDeliverInput): Promise<WebhookDeliverResult> {
    if (this.encryptionKey === undefined) {
      return { outcome: 'failed', sanitizedError: 'encryption-key-not-configured' };
    }

    try {
      // Delivery-time SSRF re-validation (ADR-0033 §a/§f): a subscription's
      // target URL was already validated at write time, but DNS can change
      // between then and now -- re-check immediately before any network
      // call, and NEVER call fetch if this rejects.
      await assertSafeWebhookUrl(input.targetUrl);
    } catch {
      return { outcome: 'failed', sanitizedError: 'ssrf-rejected' };
    }

    let signingSecret: string;
    try {
      signingSecret = decryptSecret(input.encryptedSigningSecret, this.encryptionKey);
    } catch {
      return { outcome: 'failed', sanitizedError: 'decryption-failed' };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(input.payload);
    const signature = createHmac('sha256', signingSecret)
      .update(`${String(timestamp)}.${body}`)
      .digest('hex');

    let response: Response;
    try {
      response = await fetch(input.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LuminaOS-Timestamp': String(timestamp),
          'X-LuminaOS-Signature': `sha256=${signature}`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
    } catch {
      return { outcome: 'failed', sanitizedError: 'network-error' };
    }

    const outcomeStatus = response.status;
    const wasOk = response.ok;

    // ADR-0033 §f: response body must NEVER be read/logged, and a
    // misbehaving/malicious receiver holding the response stream open must
    // never hold a connection out of the pool indefinitely -- cancel the
    // body immediately (never buffered, never inspected) rather than
    // reading it, satisfying both the "never surface body content" and the
    // "bounded resource use" halves of that requirement in one step.
    try {
      await response.body?.cancel();
    } catch {
      // Cancellation failures are irrelevant to the delivery outcome.
    }

    if (wasOk) {
      return { outcome: 'delivered' };
    }

    return { outcome: 'failed', sanitizedError: `HTTP ${String(outcomeStatus)}` };
  }
}
