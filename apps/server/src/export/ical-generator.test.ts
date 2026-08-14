import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';

import { generateICalendar } from './ical-generator.js';

import type { TimeblockEvent } from './ical-generator.js';

/**
 * F1-T18 PR3 (RED step) -- ADR-0016 §(e). Pure, DB-free unit tests (no
 * NestJS, no Testcontainers -- mirrors `../docs/yjs-to-markdown.test.ts`'s
 * self-contained convention) for `generateICalendar(events: TimeblockEvent[]):
 * string`, the hand-written, minimal RFC5545 `VEVENT` generator. `./ical-
 * generator.ts` does not exist yet, so every test in this file fails at
 * IMPORT time (module not found) -- the correct RED state.
 *
 * Output is validated against a REAL, independent RFC5545 parser (`ical.js`,
 * a test-only devDependency -- never imported by `ical-generator.ts` itself,
 * which per ADR-0016 §(e) has NO new runtime dependency) rather than by
 * string-matching our own generated output, so a parser bug in our hand-
 * rolled generator can't hide behind a self-consistent but wrong assertion.
 *
 * `ical.js@2.2.1`'s package.json declares `"types": "dist/types/module.d.ts"`
 * with a SINGLE `export default` (no named exports) -- confirmed by reading
 * that file directly. A namespace import (`import * as ICAL from 'ical.js'`)
 * would therefore only expose `ICAL.default.parse`/etc, NOT `ICAL.parse`
 * directly; the DEFAULT import below (`import ICAL from 'ical.js'`) is the
 * shape that gives `.parse`/`.Component`/`.Event` directly, verified against
 * the real dist/types/*.d.ts files (component.d.ts, event.d.ts, parse.d.ts,
 * time.d.ts).
 */

type ParsedComponent = InstanceType<typeof ICAL.Component>;
type ParsedEvent = InstanceType<typeof ICAL.Event>;

/**
 * Parses a raw iCalendar string into an `ICAL.Component`. `ICAL.parse`'s own
 * shipped `.d.ts` (dist/types/parse.d.ts) declares its return type as the
 * literal `any` (`declare function parse(input: string): any | any[];`) --
 * narrowed here to `unknown[]` (assignable to `Component`'s own `any[] |
 * string` constructor parameter, since `any` accepts `unknown` values
 * element-wise) rather than left as `any`, per CLAUDE.md's `any` ban. A
 * top-level `VCALENDAR` string always parses to a single jCal array, never an
 * array of jCal arrays, so this narrowing is safe for every call site below.
 */
function parseICalendar(raw: string): ParsedComponent {
  const jcalData = ICAL.parse(raw) as unknown[];
  return new ICAL.Component(jcalData);
}

function parseVevents(raw: string): ParsedEvent[] {
  const component = parseICalendar(raw);
  return component.getAllSubcomponents('vevent').map((vevent) => new ICAL.Event(vevent));
}

function makeEvent(overrides: Partial<TimeblockEvent> = {}): TimeblockEvent {
  return {
    objectId: 'obj-1111-2222-3333',
    title: 'Sprint Planning',
    start: '2026-08-10T09:00:00.000Z',
    end: '2026-08-10T10:00:00.000Z',
    ...overrides,
  };
}

describe('generateICalendar (pure RFC5545 VEVENT generator, no runtime ical.js dependency)', () => {
  // -----------------------------------------------------------------------
  // 1. Empty events array -> a valid, still-parseable, zero-VEVENT calendar.
  // -----------------------------------------------------------------------
  it('an empty events array produces a valid VCALENDAR that parses with zero VEVENTs', () => {
    const raw = generateICalendar([]);

    expect(() => parseICalendar(raw)).not.toThrow();
    const component = parseICalendar(raw);
    expect(component.getAllSubcomponents('vevent')).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 2. Single event -> exactly 1 VEVENT with correctly round-tripped fields.
  // -----------------------------------------------------------------------
  it('a single event parses to exactly 1 VEVENT with matching uid/summary/startDate/endDate', () => {
    const event = makeEvent({
      objectId: 'obj-solo-0001',
      title: 'Solo focus block',
      start: '2026-08-11T13:30:00.000Z',
      end: '2026-08-11T15:00:00.000Z',
    });

    const raw = generateICalendar([event]);
    const events = parseVevents(raw);

    expect(events).toHaveLength(1);
    const parsed = events[0];
    expect(parsed).toBeDefined();
    expect(parsed?.uid).toBe(`${event.objectId}@luminaos`);
    expect(parsed?.summary).toBe(event.title);
    expect(parsed?.startDate.toJSDate().toISOString()).toBe(event.start);
    expect(parsed?.endDate.toJSDate().toISOString()).toBe(event.end);
  });

  // -----------------------------------------------------------------------
  // 3. Three events, input order preserved / all present, order-independent
  // lookup by UID.
  // -----------------------------------------------------------------------
  it('three events in a specific input order all parse to distinct VEVENTs, matched by UID', () => {
    const events: TimeblockEvent[] = [
      makeEvent({
        objectId: 'obj-three-a',
        title: 'Morning standup',
        start: '2026-08-12T08:00:00.000Z',
        end: '2026-08-12T08:15:00.000Z',
      }),
      makeEvent({
        objectId: 'obj-three-b',
        title: 'Design review',
        start: '2026-08-12T10:00:00.000Z',
        end: '2026-08-12T11:00:00.000Z',
      }),
      makeEvent({
        objectId: 'obj-three-c',
        title: 'Retro',
        start: '2026-08-12T16:00:00.000Z',
        end: '2026-08-12T16:45:00.000Z',
      }),
    ];

    const raw = generateICalendar(events);
    const parsedEvents = parseVevents(raw);
    expect(parsedEvents).toHaveLength(3);

    const byUid = new Map(parsedEvents.map((parsed) => [parsed.uid, parsed]));

    for (const expected of events) {
      const expectedUid = `${expected.objectId}@luminaos`;
      const match = byUid.get(expectedUid);
      expect(match).toBeDefined();
      expect(match?.summary).toBe(expected.title);
      expect(match?.startDate.toJSDate().toISOString()).toBe(expected.start);
      expect(match?.endDate.toJSDate().toISOString()).toBe(expected.end);
    }
  });

  // -----------------------------------------------------------------------
  // 4. UID determinism: same objectId -> same UID, across repeated calls.
  // -----------------------------------------------------------------------
  it('UID is deterministic: the same event produces the identical UID across two separate generateICalendar calls', () => {
    const event = makeEvent({ objectId: 'obj-deterministic-uid' });

    const firstRaw = generateICalendar([event]);
    const secondRaw = generateICalendar([event]);

    const firstEvents = parseVevents(firstRaw);
    const secondEvents = parseVevents(secondRaw);

    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    expect(firstEvents[0]?.uid).toBe(secondEvents[0]?.uid);
    expect(firstEvents[0]?.uid).toBe(`${event.objectId}@luminaos`);
  });

  // -----------------------------------------------------------------------
  // 5-9. RFC5545 TEXT escaping of SUMMARY, individually then combined.
  // -----------------------------------------------------------------------
  it('escapes a comma in the title, round-tripping back to the exact original via a real parser', () => {
    const event = makeEvent({ title: 'Sprint Planning, Q3' });
    const raw = generateICalendar([event]);
    const events = parseVevents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('Sprint Planning, Q3');
  });

  it('escapes a semicolon in the title, round-tripping back to the exact original', () => {
    const event = makeEvent({ title: 'Standup; daily' });
    const raw = generateICalendar([event]);
    const events = parseVevents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('Standup; daily');
  });

  it('escapes a literal backslash in the title, round-tripping back to the exact original', () => {
    const event = makeEvent({ title: 'C:\\Projects\\Q3' });
    const raw = generateICalendar([event]);
    const events = parseVevents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('C:\\Projects\\Q3');
  });

  it('escapes an embedded newline in the title, round-tripping back to a real newline character', () => {
    const event = makeEvent({ title: 'Line one\nLine two' });
    const raw = generateICalendar([event]);
    const events = parseVevents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('Line one\nLine two');
  });

  it('escapes comma, semicolon, backslash, AND newline combined in a single title without corruption', () => {
    const title = 'Meeting, Part 2; "quoted"\\ end\nfollow-up';
    const event = makeEvent({ title });
    const raw = generateICalendar([event]);
    const events = parseVevents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe(title);
  });

  // -----------------------------------------------------------------------
  // 10. VERSION/PRODID sanity.
  // -----------------------------------------------------------------------
  it('VERSION is exactly "2.0" and PRODID contains "LuminaOS" (loose substring check, not an exact pin)', () => {
    const raw = generateICalendar([makeEvent()]);
    const component = parseICalendar(raw);

    expect(component.getFirstPropertyValue('version')).toBe('2.0');

    const prodid = component.getFirstPropertyValue('prodid');
    expect(typeof prodid).toBe('string');
    if (typeof prodid !== 'string') {
      throw new Error('expected PRODID to be a string property value');
    }
    expect(prodid).toContain('LuminaOS');
  });

  // -----------------------------------------------------------------------
  // 11. CRLF line endings (RFC5545-mandated), never a bare LF.
  // -----------------------------------------------------------------------
  it('the raw output uses CRLF line endings exclusively -- no bare LF not preceded by CR', () => {
    const raw = generateICalendar([makeEvent()]);

    expect(raw).toContain('\r\n');
    expect(/(?<!\r)\n/.test(raw)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 12. Line folding at 75 octets, transparently reassembled by a real
  // parser.
  // -----------------------------------------------------------------------
  it('folds a long (200+ char) SUMMARY line at 75 octets, which a real parser reassembles losslessly', () => {
    const longTitle = 'A'.repeat(210);
    const event = makeEvent({ title: longTitle });

    const raw = generateICalendar([event]);
    const rawLines = raw.split('\r\n');

    // At least one physical continuation line, starting with exactly one
    // leading space, must exist -- proof that SOME content line (the long
    // SUMMARY, the only field long enough to need it here) was folded.
    const hasFoldedContinuationLine = rawLines.some((line) => /^ /.test(line));
    expect(hasFoldedContinuationLine).toBe(true);

    // No single raw line (pre-parse) should be the full 210-character
    // SUMMARY value unfolded -- otherwise no folding actually happened.
    expect(rawLines.some((line) => line.includes(longTitle))).toBe(false);

    // The parser must transparently unfold it back to the exact original.
    const events = parseVevents(raw);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe(longTitle);
    expect(events[0]?.summary.length).toBe(210);
  });
});
