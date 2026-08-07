import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AppError } from '../errors/app-error.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const PACKED_SEGMENT_COUNT = 3;

export class DecryptionError extends AppError {
  constructor(message = 'Failed to decrypt secret') {
    super(message, 'DECRYPTION_FAILED', 500);
  }
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decodes a base64 segment, throwing `DecryptionError` if it does not
 * decode to exactly `expectedLength` bytes. `Buffer.from(_, 'base64')`
 * never throws on non-base64 input (it silently ignores invalid
 * characters), so the length check is what catches both malformed
 * base64 (e.g. `'!!!'` decodes to an empty buffer) and wrong-size
 * IV/authTag segments before they ever reach `node:crypto`.
 */
function decodeSegment(segment: string, expectedLength: number): Buffer {
  const decoded = Buffer.from(segment, 'base64');
  if (decoded.length !== expectedLength) {
    throw new DecryptionError();
  }
  return decoded;
}

export function decryptSecret(ciphertext: string, key: Buffer): string {
  const segments = ciphertext.split(':');
  if (segments.length !== PACKED_SEGMENT_COUNT) {
    throw new DecryptionError();
  }
  const [ivSegment, authTagSegment, ciphertextSegment] = segments as [string, string, string];

  const iv = decodeSegment(ivSegment, IV_LENGTH_BYTES);
  const authTag = decodeSegment(authTagSegment, AUTH_TAG_LENGTH_BYTES);
  const ciphertextBuf = Buffer.from(ciphertextSegment, 'base64');

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new DecryptionError();
  }
}
