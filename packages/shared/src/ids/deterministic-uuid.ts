import { createHash } from 'node:crypto';

/**
 * Derives a deterministic RFC 4122 UUIDv5 ("name-based UUID", §4.3) from a
 * fixed namespace UUID and an arbitrary name string. Unlike `randomUUID()`,
 * calling this twice with the same `namespace`/`name` pair always yields the
 * identical UUID — used wherever an aggregate's `streamId` must be derived
 * from a stable business key (e.g. `UserAvailabilityService.streamIdFor`,
 * per ADR-0012 §f) rather than generated fresh per write.
 *
 * Algorithm: parse `namespace` into its 16 raw bytes, concatenate with the
 * UTF-8 bytes of `name`, SHA-1 hash the result, take the first 16 bytes of
 * the digest, then overwrite the version nibble (byte 6's high nibble ->
 * `0101`) and the variant bits (byte 8's top two bits -> `10`) per RFC 4122,
 * and format as a standard lowercase hyphenated UUID string.
 */
export function deriveDeterministicUuid(namespace: string, name: string): string {
  const namespaceHex = namespace.replace(/-/g, '');
  const namespaceBytes = Buffer.from(namespaceHex, 'hex');
  const nameBytes = Buffer.from(name, 'utf8');

  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
