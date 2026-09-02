import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { assertSafeWebhookUrl, isPrivateOrReservedAddress } from './ssrf-guard.js';

/**
 * F2-T16 PR1 (RED step), ADR-0033 Karar (a)/(b) — `ssrf-guard.ts` does NOT
 * exist yet (`./ssrf-guard.js` import below is expected to be unresolved).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `isPrivateOrReservedAddress` nor
 * `assertSafeWebhookUrl` exist -- this whole file fails to resolve its one
 * static import (`import-x/no-unresolved` at the `./ssrf-guard.js` line),
 * which fails every test below at collection time. This is the correct red:
 * the module this PR adds simply does not exist yet, not a test-logic bug.
 * ============================================================================
 *
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   isPrivateOrReservedAddress(ip: string): boolean
 *     Pure, synchronous, no I/O. Takes an already-resolved IP literal (v4
 *     dotted-quad or v6 WITHOUT surrounding `[...]` brackets -- bracket
 *     stripping, if the caller passes a bracketed literal, is
 *     `assertSafeWebhookUrl`'s job, not this function's) and returns whether
 *     it falls in any of ADR-0033 Karar (a)'s reserved ranges: RFC1918
 *     (10/8, 172.16/12, 192.168/16), link-local v4 (169.254/16, including the
 *     cloud-metadata address 169.254.169.254), loopback (127/8, ::1), IPv6
 *     unique-local (fc00::/7), IPv6 link-local (fe80::/10).
 *
 *   assertSafeWebhookUrl(url: string): Promise<void>
 *     Async (does DNS resolution for non-literal hostnames in the real
 *     implementation). Throws (this file asserts a real `@luminaos/shared`
 *     `ValidationError` specifically, matching ADR-0033 Karar (a)'s "yazma
 *     anında 400" contract -- `ValidationError`'s pinned `statusCode` is 400,
 *     see `packages/shared/src/errors/validation-error.ts`) when:
 *       - the URL's scheme is not exactly `https:` (Karar b, no exceptions);
 *       - the resolved (or, for a literal-IP hostname, the literal itself)
 *         address is private/reserved per `isPrivateOrReservedAddress`.
 *     Resolves (does not throw) for a normal public HTTPS URL.
 *
 * DNS-MOCKING CHOICE (per task brief: "no live network calls", noted here so
 * `implementer` knows the exact contract this suite pins): every URL used
 * below has a LITERAL IP as its hostname (e.g. `https://127.0.0.1/hook`,
 * `https://[fd00::1]/hook`) -- never a domain name. This is deliberate and
 * total (even the "valid https, does not throw" and the "wrong scheme"
 * cases use literal IPs) so this suite NEVER triggers a real DNS lookup or
 * any network I/O, regardless of whether the real implementation's internal
 * order-of-checks does the scheme check or the DNS/IP-literal check first.
 * `implementer` therefore MUST make `assertSafeWebhookUrl` recognize an
 * already-literal IP hostname (v4 dotted-quad, or v6 in the URL's
 * `[...]`-bracketed form) without requiring an injectable resolver for this
 * suite to pass -- an injectable-resolver overload/parameter is NOT
 * required by this test file, but is not precluded either if `implementer`
 * finds it useful for PR2's delivery-time re-validation reuse.
 */

describe('isPrivateOrReservedAddress', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
  ] as const)('RFC1918 %s -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it.each([
    ['172.15.255.255', false],
    ['172.32.0.0', false],
  ] as const)('RFC1918 172.16.0.0/12 boundary: %s is OUTSIDE the range -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it.each([
    ['169.254.0.1', true],
    ['169.254.169.254', true], // cloud-metadata endpoint, explicitly called out in ADR-0033 Karar (a)
    ['169.254.255.255', true],
  ] as const)('link-local 169.254.0.0/16: %s -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['::1', true],
  ] as const)('loopback: %s -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it.each([
    ['fc00::1', true],
    ['fd00::1', true],
  ] as const)('IPv6 unique-local fc00::/7: %s -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it.each([
    ['fe80::1', true],
    ['fe80::ffff:ffff:ffff:ffff', true],
  ] as const)('IPv6 link-local fe80::/10: %s -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it.each([
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['93.184.216.34', false],
  ] as const)('public IPs are never flagged: %s -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it("0.0.0.0 is reserved (several OS network stacks treat it as 'this host'/loopback)", () => {
    expect(isPrivateOrReservedAddress('0.0.0.0')).toBe(true);
  });

  // Security-review regression (F2-T16 PR1): an IPv4-mapped IPv6 address
  // (RFC 4291 §2.5.5.2, `::ffff:a.b.c.d`) embeds a full IPv4 address in its
  // low 32 bits. A DNS-controlled hostname can return one of these to reach
  // a private/reserved address despite the equivalent native v4 literal
  // being blocked. Node's resolvers can surface EITHER the dotted-decimal
  // "mixed" notation or the fully-hex notation for the same address -- both
  // must be covered.
  it.each([
    ['::ffff:169.254.169.254', true], // mixed/dotted notation, cloud metadata
    ['::ffff:a9fe:a9fe', true], // equivalent fully-hex notation
    ['::ffff:10.0.0.5', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false], // mapped PUBLIC address must NOT be flagged
  ] as const)('IPv4-mapped IPv6 (RFC 4291 §2.5.5.2): %s -> %s', (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });

  it('a public IPv6 address is never flagged (e.g. a real public DNS resolver address)', () => {
    expect(isPrivateOrReservedAddress('2001:4860:4860::8888')).toBe(false);
  });
});

describe('assertSafeWebhookUrl', () => {
  it('rejects a plain http:// URL even when the host IP itself is public (ADR-0033 Karar b: HTTPS is mandatory, no exceptions)', async () => {
    await expect(assertSafeWebhookUrl('http://1.1.1.1/hook')).rejects.toThrow(ValidationError);
  });

  it('rejects a non-https, non-http scheme (e.g. ftp:) the same way', async () => {
    await expect(assertSafeWebhookUrl('ftp://1.1.1.1/hook')).rejects.toThrow(ValidationError);
  });

  it('rejects an https:// URL whose literal hostname is a loopback address (127.0.0.1)', async () => {
    await expect(assertSafeWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(ValidationError);
  });

  it('rejects an https:// URL whose literal hostname is the cloud-metadata address (169.254.169.254)', async () => {
    await expect(assertSafeWebhookUrl('https://169.254.169.254/hook')).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects an https:// URL whose literal hostname is an RFC1918 private address (10.0.0.5)', async () => {
    await expect(assertSafeWebhookUrl('https://10.0.0.5/hook')).rejects.toThrow(ValidationError);
  });

  it('rejects an https:// URL whose literal hostname is an IPv6 loopback address ([::1])', async () => {
    await expect(assertSafeWebhookUrl('https://[::1]/hook')).rejects.toThrow(ValidationError);
  });

  it('rejects an https:// URL whose literal hostname is an IPv6 unique-local address ([fd00::1])', async () => {
    await expect(assertSafeWebhookUrl('https://[fd00::1]/hook')).rejects.toThrow(ValidationError);
  });

  it('rejects an https:// URL whose literal hostname is an IPv6 link-local address ([fe80::1])', async () => {
    await expect(assertSafeWebhookUrl('https://[fe80::1]/hook')).rejects.toThrow(ValidationError);
  });

  it('does NOT throw for a normal public https:// URL with a literal public IP hostname', async () => {
    await expect(assertSafeWebhookUrl('https://1.1.1.1/hook')).resolves.toBeUndefined();
  });

  it('rejects a malformed URL string (not a valid URL at all) rather than letting a raw TypeError escape', async () => {
    await expect(assertSafeWebhookUrl('not-a-url')).rejects.toThrow(ValidationError);
  });
});
