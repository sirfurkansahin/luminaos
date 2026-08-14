/**
 * F1-T18 PR3 (ADR-0016 §e): a hand-written, minimal RFC5545 `VEVENT`
 * generator for the `format=ical` data-export branch. Per ADR-0016 §(e) this
 * takes on NO new runtime dependency -- `ical.js` (used by this package's own
 * test files to parse/validate the output against a real, independent
 * parser) is a test-only devDependency, never imported here. The generator
 * covers exactly the fields the spec's acceptance criteria need
 * (start/end/title/UID); recurrence-rule/timezone library complexity is
 * unnecessary because recurring task instances are already expanded into
 * separate `LuminaObject`s by F1-T10, so plain UTC `Z`-suffixed timestamps
 * are sufficient.
 *
 * Mirrors `../docs/yjs-to-markdown.ts`'s file-header doc-comment convention:
 * this header explains intent and the non-obvious "why", not a line-by-line
 * restatement of the code below.
 */

/**
 * A single native `timeblock`-type `LuminaObject`'s calendar-relevant
 * fields, as read by `ExportService.exportIcal` off `objects_view` (never
 * `calendar_events_cache` -- that table is structurally excluded, per
 * ADR-0016 §e's exclusion-by-construction).
 */
export interface TimeblockEvent {
  objectId: string;
  title: string;
  start: string; // ISO-8601
  end: string; // ISO-8601
}

const PRODID = '-//LuminaOS//Data Export//EN';
const MAX_LINE_OCTETS = 75;

/**
 * Escapes RFC5545 TEXT special characters (§3.3.11) in `SUMMARY`'s value.
 * Order matters: the backslash escape MUST run first, before the later
 * substitutions introduce new backslashes of their own (otherwise those
 * newly-introduced backslashes would themselves get re-escaped).
 */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Formats a `Date` as RFC5545's UTC `DATE-TIME` form (`YYYYMMDDTHHMMSSZ`),
 * using UTC field accessors so the output is independent of the host
 * process's local timezone.
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = String(date.getUTCFullYear());
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Folds a single logical content line into one or more `\r\n`-joined
 * physical lines per RFC5545 §3.1, whenever the line exceeds 75 OCTETS
 * (`Buffer.byteLength`, not `.length` -- a UTF-8 multi-byte character must
 * never straddle a fold boundary, so the walk below tracks octets per
 * character, not characters themselves). Every continuation line carries a
 * single mandatory leading space, which eats one octet of that
 * continuation's budget (74, not 75).
 */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_OCTETS) {
    return line;
  }

  const segments: string[] = [];
  let current = '';
  let currentBytes = 0;
  let isFirst = true;

  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    const budget = isFirst ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (currentBytes + charBytes > budget) {
      segments.push(current);
      isFirst = false;
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current) {
    segments.push(current);
  }

  return segments.map((segment, index) => (index === 0 ? segment : ` ${segment}`)).join('\r\n');
}

/**
 * Builds a full `VCALENDAR` document (zero or more `VEVENT`s, one per input
 * `event`, in input order) as a single RFC5545-compliant string, `\r\n`-line-
 * ended (mandated by the spec, never a bare `\n`) with a trailing `\r\n`.
 *
 * `UID` is deterministic -- derived solely from `event.objectId` (`{objectId}
 * @luminaos`) -- so repeated exports of the same timeblock produce the same
 * `UID`, letting a calendar client treat re-imports as idempotent updates
 * rather than duplicate events. `DTSTAMP`, by contrast, is intentionally NOT
 * deterministic: RFC5545 defines it as "the instant the iCalendar object was
 * created", i.e. export time, not the underlying event's own timestamps --
 * `DTSTART`/`DTEND` already carry the interval's real schedule.
 */
export function generateICalendar(events: TimeblockEvent[]): string {
  const now = formatTimestamp(new Date());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
  ];

  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.objectId}@luminaos`,
      `DTSTAMP:${now}`,
      `DTSTART:${formatTimestamp(new Date(event.start))}`,
      `DTEND:${formatTimestamp(new Date(event.end))}`,
      `SUMMARY:${escapeText(event.title)}`,
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}
