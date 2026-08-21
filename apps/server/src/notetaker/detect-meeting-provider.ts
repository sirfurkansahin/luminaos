import { ValidationError } from '@luminaos/shared';

import type { meetingProviderEnum } from '../db/schema/meeting-details.js';

/**
 * The literal union `meetingProviderEnum.enumValues` carries
 * (`'google-meet' | 'zoom' | 'microsoft-teams'`) — derived from the schema's
 * own enum so this type can never drift from the Postgres column's actual
 * value set.
 */
export type MeetingProvider = (typeof meetingProviderEnum.enumValues)[number];

/**
 * ADR-0030 §i ("[ARCHITECT KARARI] Sağlayıcı tespiti — açık body-alanı
 * DEĞİL, URL-deseninden OTOMATIK tespit") — patterns copied verbatim.
 */
const PROVIDER_PATTERNS: Array<{ provider: MeetingProvider; pattern: RegExp }> = [
  { provider: 'google-meet', pattern: /meet\.google\.com/i },
  { provider: 'zoom', pattern: /zoom\.us/i },
  { provider: 'microsoft-teams', pattern: /teams\.microsoft\.com/i },
];

/**
 * Pure, no-DB, no-HTTP classification of a meeting URL into one of the three
 * v0-supported providers. No pattern matching -> `ValidationError` (400) —
 * an unrecognized link is never silently accepted as "unknown provider"
 * (ADR-0030 §i).
 */
export function detectMeetingProvider(meetingUrl: string): MeetingProvider {
  const match = PROVIDER_PATTERNS.find(({ pattern }) => pattern.test(meetingUrl));

  if (!match) {
    throw new ValidationError(`Unsupported meeting link: ${meetingUrl}`);
  }

  return match.provider;
}
