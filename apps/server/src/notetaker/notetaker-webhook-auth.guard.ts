import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { env } from '../config/env.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

interface NotetakerWebhookRequest extends Request {
  rawBody?: Buffer;
}

/**
 * ADR-0030 §f: `POST /webhooks/notetaker` has no user identity/cookie/Bearer
 * token — the ONLY authentication is an HMAC-SHA256 signature (hex-encoded,
 * `X-Notetaker-Signature` header) computed over the raw request body bytes
 * with a shared secret (`env.notetakerWebhookSecret`). FAIL-CLOSED: if no
 * secret is configured at all, every request is rejected, never silently
 * let through.
 */
@Injectable()
export class NotetakerWebhookAuthGuard implements CanActivate {
  // eslint-disable-next-line @typescript-eslint/require-await -- CanActivate contract; no await needed, keeps signature consistent with other guards
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = env.notetakerWebhookSecret;

    if (secret === undefined) {
      throw new UnauthorizedError();
    }

    const request = context.switchToHttp().getRequest<NotetakerWebhookRequest>();
    const rawBody = request.rawBody;

    if (rawBody === undefined) {
      throw new UnauthorizedError();
    }

    const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
    const providedHex = request.headers['x-notetaker-signature'];

    // Hex-format check matters alongside the length check: a same-length
    // but non-hex header (e.g. 64 'g' characters) passes the length
    // comparison, but `Buffer.from(..., 'hex')` silently stops decoding at
    // the first invalid byte, handing `timingSafeEqual` a SHORTER buffer
    // than `expectedHex`'s -- which throws a TypeError instead of failing
    // closed with a 401 (security-reviewer finding, PR4).
    if (
      typeof providedHex !== 'string' ||
      providedHex.length !== expectedHex.length ||
      !/^[0-9a-f]+$/i.test(providedHex) ||
      !timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'))
    ) {
      throw new UnauthorizedError();
    }

    return true;
  }
}
