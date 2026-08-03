import { createHash } from 'node:crypto';

/**
 * A minimal, dependency-free RFC 4122 v5 UUID derivation, used by
 * `TaskRecurrenceService` (ADR-0010 §"(c) Layer B") to turn a triggering
 * event's own id into deterministic, stable stream/event ids for the
 * cross-stream recurring-task write. There is no `uuid` npm package in this
 * repo's dependencies -- this exists so we don't have to add one for a
 * single, narrow use.
 *
 * Standard v5 algorithm: SHA-1(namespace bytes + name bytes), then the
 * version nibble is forced to `5` and the variant bits to RFC 4122's `10`,
 * formatted as a canonical `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` string. The
 * SAME `(namespace, name)` pair always produces the SAME UUID string -- this
 * is what lets a repeated call derive the exact same stream/event ids a
 * prior call already used, so `EventStoreService.append`'s own
 * idempotent-replay detection (id + expected-version match) fires "for
 * free" on a retried/duplicated call.
 */
export function deterministicUuid(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');

  const hash = createHash('sha1').update(namespaceBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));

  // Version nibble -> 5 (byte 6's high nibble).
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  // Variant bits -> RFC 4122 `10` (byte 8's two high bits).
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
