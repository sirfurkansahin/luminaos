import { describe, expect, it } from 'vitest';

import { deriveDeterministicUuid } from './deterministic-uuid.js';

/**
 * F1-T12 PR6 (RED step) — deterministic UUIDv5 helper, per ADR-0012 §f
 * (`docs/adr/ADR-0012-takvim-senkron.md`): `UserAvailability`'s event stream
 * must be re-opened (replay + append) every time a user changes Odak/OOO
 * status, so its `streamId` cannot be a per-call throwaway random UUID
 * (`recordAIUsage`'s pattern) — it must be a DETERMINISTIC function of
 * `userId`, i.e. RFC 4122 UUIDv5 (namespace + name -> SHA-1 -> fixed
 * version/variant bits).
 *
 * Pins the exact designed contract for the (not-yet-existing)
 * `packages/shared/src/ids/deterministic-uuid.ts`:
 *
 *   export function deriveDeterministicUuid(namespace: string, name: string): string;
 *
 * Algorithm (RFC 4122 §4.3, "Name-Based UUID"): parse `namespace` (a UUID
 * string) into its 16 raw bytes, concatenate with the UTF-8 bytes of `name`,
 * SHA-1 hash the result (`node:crypto`'s `createHash('sha1')`), take the
 * first 16 bytes of the digest, set the 4 high bits of byte 6 to `0101`
 * (version 5), set the 2 high bits of byte 8 to `10` (RFC 4122 variant),
 * format as a standard lowercase hyphenated `xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx`
 * UUID string.
 *
 * Test vectors #1/#2 below are WELL-KNOWN, independently-checkable RFC4122
 * UUIDv5 outputs, copied character-for-character from Python's stdlib `uuid`
 * module (`uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')` and
 * `uuid.uuid5(uuid.NAMESPACE_URL, 'www.example.com')`) — they are the
 * correctness proof for this implementation, not just self-consistency
 * checks. `uuid.NAMESPACE_DNS` == `'6ba7b810-9dad-11d1-80b4-00c04fd430c8'`,
 * `uuid.NAMESPACE_URL` == `'6ba7b811-9dad-11d1-80b4-00c04fd430c8'`.
 *
 * Expected to fail (red) until `implementer` adds
 * `packages/shared/src/ids/deterministic-uuid.ts`, `packages/shared/src/ids/index.ts`
 * (barrel: `export * from './deterministic-uuid.js';`), and wires the new
 * barrel into `packages/shared/src/index.ts` — right now this file cannot
 * even resolve its import.
 *
 * LINT NOTE (mirrors `recurrence/task-recurrence.service.test.ts`'s own
 * note): since `./deterministic-uuid.ts` doesn't exist yet, its named export
 * resolves to `any`, which would otherwise cascade
 * `@typescript-eslint/no-unsafe-*` errors through every call site on top of
 * the one genuinely-expected `import-x/no-unresolved` error this file is
 * supposed to fail with. The single `as unknown as DeriveDeterministicUuidFn`
 * cast below is the narrow escape hatch — once the real
 * `deterministic-uuid.ts` exists with this exact shape, the cast becomes a
 * no-op and can be deleted in favor of using the import directly.
 */
describe('deriveDeterministicUuid', () => {
  const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

  it('matches the well-known Python uuid.uuid5(NAMESPACE_DNS, "python.org") test vector', () => {
    expect(deriveDeterministicUuid(NAMESPACE_DNS, 'python.org')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it('matches the well-known Python uuid.uuid5(NAMESPACE_URL, "www.example.com") test vector (second, independent namespace)', () => {
    expect(deriveDeterministicUuid(NAMESPACE_URL, 'www.example.com')).toBe(
      'b63cdfa4-3df9-568e-97ae-006c5b8fd652',
    );
  });

  it('is deterministic: the same namespace+name pair produces the identical string on repeated calls', () => {
    const first = deriveDeterministicUuid(NAMESPACE_DNS, 'some-user-id-123');
    const second = deriveDeterministicUuid(NAMESPACE_DNS, 'some-user-id-123');
    expect(first).toBe(second);
  });

  it('produces a different uuid for a different name under the same namespace', () => {
    const a = deriveDeterministicUuid(NAMESPACE_DNS, 'user-a');
    const b = deriveDeterministicUuid(NAMESPACE_DNS, 'user-b');
    expect(a).not.toBe(b);
  });

  it('produces a different uuid for a different namespace given the same name', () => {
    const a = deriveDeterministicUuid(NAMESPACE_DNS, 'same-name');
    const b = deriveDeterministicUuid(NAMESPACE_URL, 'same-name');
    expect(a).not.toBe(b);
  });

  it('produces a well-formed lowercase UUIDv5 string (8-4-4-4-12 hex shape, version nibble 5, RFC4122 variant bits)', () => {
    const uuid = deriveDeterministicUuid(NAMESPACE_DNS, 'shape-check');

    // Full shape: 8-4-4-4-12 lowercase hex groups, hyphens in the right spots.
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Version nibble: the first hex digit of the 3rd group must be '5'
    // (UUIDv5). E.g. in `xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx`.
    const groups = uuid.split('-');
    expect(groups[2]?.charAt(0)).toBe('5');

    // Variant bits: the first hex digit of the 4th group must be one of
    // 8/9/a/b (the two high bits of that nibble are `10`, per RFC 4122).
    expect(['8', '9', 'a', 'b']).toContain(groups[3]?.charAt(0));
  });
});
