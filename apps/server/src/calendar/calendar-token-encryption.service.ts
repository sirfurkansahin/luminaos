import { Injectable } from '@nestjs/common';

import { decryptSecret, encryptSecret, InvalidObjectStateError } from '@luminaos/shared';

import { env } from '../config/env.js';

/**
 * Wraps `@luminaos/shared`'s `encryptSecret`/`decryptSecret` (AES-256-GCM)
 * with `env.encryptionKey` for calendar-account OAuth token storage (F1-T12
 * PR5a). `env.encryptionKey` is deliberately optional at the boot layer (see
 * `../config/env.ts`) so a deployment without calendar features configured
 * doesn't crash boot — the absence is only surfaced here, lazily, at first
 * actual use of a calendar feature.
 */
@Injectable()
export class CalendarTokenEncryptionService {
  encrypt(plaintext: string): string {
    if (env.encryptionKey === undefined) {
      throw new InvalidObjectStateError(
        'ENCRYPTION_KEY is not configured; calendar features are unavailable',
      );
    }

    return encryptSecret(plaintext, env.encryptionKey);
  }

  decrypt(ciphertext: string): string {
    if (env.encryptionKey === undefined) {
      throw new InvalidObjectStateError(
        'ENCRYPTION_KEY is not configured; calendar features are unavailable',
      );
    }

    return decryptSecret(ciphertext, env.encryptionKey);
  }
}
