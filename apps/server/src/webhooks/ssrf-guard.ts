import { lookup } from 'node:dns/promises';
import { isIP, isIPv4, isIPv6 } from 'node:net';

import { ValidationError } from '@luminaos/shared';

/**
 * F2-T16 PR1 (ADR-0033 Karar a/b): the SSRF defense shared by both
 * write-time (`WebhookSubscriptionsService.create`) and, in a later PR,
 * delivery-time re-validation. Table-driven range checks only -- no I/O,
 * no connection-level IP pinning (that residual risk is an explicitly
 * accepted, human-approved v0 tradeoff per ADR-0033 Karar a).
 */

interface Ipv4Range {
  base: number;
  bits: number;
}

interface Ipv6Range {
  base: bigint;
  bits: number;
}

function ipv4ToInt(ip: string): number {
  const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
  const [a, b, c, d] = octets as [number, number, number, number];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function ipv4Range(cidr: string): Ipv4Range {
  const [range, bitsSegment] = cidr.split('/');
  return { base: ipv4ToInt(range ?? '0.0.0.0'), bits: Number.parseInt(bitsSegment ?? '32', 10) };
}

function ipv4Mask(bits: number): number {
  return bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
}

function isIpv4InRange(ip: string, range: Ipv4Range): boolean {
  const mask = ipv4Mask(range.bits);
  return (ipv4ToInt(ip) & mask) === (range.base & mask);
}

/**
 * A trailing dotted-decimal IPv4 address is valid IPv6 "mixed" notation
 * (RFC 4291 §2.2, e.g. `::ffff:169.254.169.254` -- `net.isIPv6` accepts
 * this form, and it is the form some resolvers return for an IPv4-mapped
 * address). It occupies TWO 16-bit groups worth of address space, so it
 * must be expanded to its two hex groups before group-count math (used to
 * pad `::` compression) runs, or the count will be off by one.
 */
function expandDottedDecimalGroup(groups: string[]): string[] {
  const last = groups.at(-1);
  if (last === undefined || !last.includes('.')) {
    return groups;
  }

  const ipv4Int = ipv4ToInt(last);
  const highGroup = ((ipv4Int >>> 16) & 0xffff).toString(16);
  const lowGroup = (ipv4Int & 0xffff).toString(16);
  return [...groups.slice(0, -1), highGroup, lowGroup];
}

/**
 * Expands a (possibly `::`-compressed) IPv6 literal into a 128-bit integer.
 * `isIPv6` has already validated the string before this is ever called.
 */
function ipv6ToBigInt(ip: string): bigint {
  let head = ip;
  let tail = '';

  if (ip.includes('::')) {
    const segments = ip.split('::');
    head = segments[0] ?? '';
    tail = segments[1] ?? '';
  }

  const headGroups = expandDottedDecimalGroup(head === '' ? [] : head.split(':'));
  const tailGroups = expandDottedDecimalGroup(tail === '' ? [] : tail.split(':'));
  const missingGroupCount = 8 - headGroups.length - tailGroups.length;
  const groups = [
    ...headGroups,
    ...Array.from({ length: Math.max(missingGroupCount, 0) }, () => '0'),
    ...tailGroups,
  ];

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(Number.parseInt(group === '' ? '0' : group, 16));
  }
  return value;
}

function ipv6Range(cidr: string): Ipv6Range {
  const [range, bitsSegment] = cidr.split('/');
  return { base: ipv6ToBigInt(range ?? '::'), bits: Number.parseInt(bitsSegment ?? '128', 10) };
}

const FULL_128_BIT_MASK = (1n << 128n) - 1n;

function ipv6Mask(bits: number): bigint {
  return bits === 0 ? 0n : (~0n << BigInt(128 - bits)) & FULL_128_BIT_MASK;
}

function isIpv6InRange(ip: string, range: Ipv6Range): boolean {
  const mask = ipv6Mask(range.bits);
  return (ipv6ToBigInt(ip) & mask) === (range.base & mask);
}

const RESERVED_IPV4_RANGES: Ipv4Range[] = [
  ipv4Range('0.0.0.0/8'),
  ipv4Range('10.0.0.0/8'),
  ipv4Range('172.16.0.0/12'),
  ipv4Range('192.168.0.0/16'),
  ipv4Range('169.254.0.0/16'),
  ipv4Range('127.0.0.0/8'),
];

const RESERVED_IPV6_RANGES: Ipv6Range[] = [
  ipv6Range('::1/128'),
  ipv6Range('fc00::/7'),
  ipv6Range('fe80::/10'),
];

const IPV4_MAPPED_IPV6_PREFIX: Ipv6Range = ipv6Range('::ffff:0:0/96');

/**
 * An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, RFC 4291 §2.5.5.2) embeds a
 * full IPv4 address in its low 32 bits. Left unchecked, a DNS-controlled
 * hostname (fully attacker-controlled for any externally registered domain)
 * can return e.g. `::ffff:169.254.169.254` to reach the cloud-metadata
 * endpoint despite `169.254.0.0/16` being blocked in `RESERVED_IPV4_RANGES`
 * -- this extracts the embedded v4 address so it goes through the exact same
 * range checks as a native v4 literal.
 */
function extractIpv4MappedAddress(ip: string): string | undefined {
  if (!isIpv6InRange(ip, IPV4_MAPPED_IPV6_PREFIX)) {
    return undefined;
  }

  const ipv4Int = Number(ipv6ToBigInt(ip) & 0xffff_ffffn);
  return [24, 16, 8, 0].map((shift) => (ipv4Int >>> shift) & 0xff).join('.');
}

/**
 * Pure, synchronous, no I/O. `ip` is an already-resolved literal -- a v4
 * dotted-quad, or a v6 literal WITHOUT surrounding `[...]` brackets (bracket
 * stripping is `assertSafeWebhookUrl`'s job, not this function's).
 */
export function isPrivateOrReservedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    return RESERVED_IPV4_RANGES.some((range) => isIpv4InRange(ip, range));
  }

  if (isIPv6(ip)) {
    const mappedIpv4 = extractIpv4MappedAddress(ip);
    if (mappedIpv4 !== undefined) {
      return isPrivateOrReservedAddress(mappedIpv4);
    }

    return RESERVED_IPV6_RANGES.some((range) => isIpv6InRange(ip, range));
  }

  return false;
}

/**
 * Throws `ValidationError` (ADR-0033 Karar a's "yazma anında 400") for a
 * non-`https:` scheme, a malformed URL, or a hostname whose IP (literal or
 * DNS-resolved) is private/reserved. Resolves for a normal public HTTPS URL.
 */
export async function assertSafeWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('Invalid webhook target URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new ValidationError('Webhook target URL must use https://');
  }

  const { hostname } = parsed;
  // `URL.hostname` keeps the `[...]` brackets WHATWG mandates for an IPv6
  // literal host (e.g. `[::1]`) -- `net.isIP`/`isIpv6InRange` operate on the
  // bare literal, so brackets must be stripped before either sees it.
  const literalCandidate =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIP(literalCandidate) !== 0) {
    if (isPrivateOrReservedAddress(literalCandidate)) {
      throw new ValidationError('Webhook target URL resolves to a private or reserved IP address');
    }
    return;
  }

  const { address } = await lookup(hostname);
  if (isPrivateOrReservedAddress(address)) {
    throw new ValidationError('Webhook target URL resolves to a private or reserved IP address');
  }
}
