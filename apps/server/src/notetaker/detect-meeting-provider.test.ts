import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { detectMeetingProvider } from './detect-meeting-provider.js';

/**
 * F2-T13 PR3 (RED step, part 2 of 3) — pure provider-detection function
 * (ADR-0030 §i, "[ARCHITECT KARARI] Sağlayıcı tespiti — açık body-alanı
 * DEĞİL, URL-deseninden OTOMATIK tespit"). `./detect-meeting-provider.js`
 * (new) must export exactly:
 *
 *   export function detectMeetingProvider(meetingUrl: string): MeetingProvider;
 *
 * where `MeetingProvider` is the literal union `'google-meet' | 'zoom' |
 * 'microsoft-teams'` (the same value union `meetingProviderEnum`'s
 * `enumValues` carries, `../db/schema/meeting-details.ts`).
 *
 * Regex patterns (ADR-0030 §i, copied verbatim):
 *   { provider: 'google-meet', pattern: /meet\.google\.com/i }
 *   { provider: 'zoom', pattern: /zoom\.us/i }
 *   { provider: 'microsoft-teams', pattern: /teams\.microsoft\.com/i }
 *
 * No pattern matches -> throws `ValidationError` (`@luminaos/shared`) whose
 * message mentions the unsupported link (this file only asserts the message
 * CONTAINS the offending URL and a human-readable "unsupported" signal, not
 * an exact string — the implementer picks the exact wording).
 *
 * This is a PURE function: no DB, no Nest app, no HTTP — plain unit tests
 * only, mirroring `packages/integrations`' own pure-function test style.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): this file fails at MODULE RESOLUTION time --
 * `./detect-meeting-provider.js` does not exist yet (nor does the
 * `apps/server/src/notetaker/` directory at all, prior to this PR). Every
 * `it` in this file fails as an import-resolution error, not a logic bug.
 * ============================================================================
 */

describe('detectMeetingProvider — matching URLs', () => {
  it('detects google-meet for a meet.google.com URL', () => {
    expect(detectMeetingProvider('https://meet.google.com/abc-defg-hij')).toBe('google-meet');
  });

  it('detects zoom for a zoom.us URL', () => {
    expect(detectMeetingProvider('https://zoom.us/j/1234567890')).toBe('zoom');
  });

  it('detects microsoft-teams for a teams.microsoft.com URL', () => {
    expect(
      detectMeetingProvider(
        'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
      ),
    ).toBe('microsoft-teams');
  });

  it('matches case-insensitively (mixed-case host segment)', () => {
    expect(detectMeetingProvider('https://MEET.Google.COM/abc-defg-hij')).toBe('google-meet');
    expect(detectMeetingProvider('https://ZOOM.us/j/1234567890')).toBe('zoom');
    expect(detectMeetingProvider('https://Teams.Microsoft.Com/l/meetup-join/abc')).toBe(
      'microsoft-teams',
    );
  });

  it('matches a bare domain with no path for each provider', () => {
    expect(detectMeetingProvider('https://meet.google.com')).toBe('google-meet');
    expect(detectMeetingProvider('https://zoom.us')).toBe('zoom');
    expect(detectMeetingProvider('https://teams.microsoft.com')).toBe('microsoft-teams');
  });
});

describe('detectMeetingProvider — no match', () => {
  it('throws ValidationError for an unrecognized meeting link, mentioning the offending URL', () => {
    const unsupportedUrl = 'https://example.com/some-link';

    expect(() => detectMeetingProvider(unsupportedUrl)).toThrow(ValidationError);

    try {
      detectMeetingProvider(unsupportedUrl);
      expect.unreachable('detectMeetingProvider must throw for an unrecognized link');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain(unsupportedUrl);
    }
  });

  it('throws ValidationError for a completely unrelated string (not a URL at all)', () => {
    expect(() => detectMeetingProvider('not-a-url-at-all')).toThrow(ValidationError);
  });

  it('throws ValidationError for an empty string', () => {
    expect(() => detectMeetingProvider('')).toThrow(ValidationError);
  });

  it('does not false-positive match a provider name that merely appears as a substring in an unrelated domain', () => {
    // "zoom.us" must NOT match e.g. "not-zoom.us.evil.example.com" being
    // mistaken for a legitimate zoom link is the wrong failure direction,
    // but this asserts the inverse-safe case: a domain that contains
    // "google" without the real meet.google.com host must not match.
    expect(() => detectMeetingProvider('https://google.com/search?q=meet')).toThrow(
      ValidationError,
    );
  });
});
