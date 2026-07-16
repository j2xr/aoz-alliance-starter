// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildVEvent, icsEscape } from './helpers';

const EVENT = {
  id: 'evt-1',
  title: 'Polar Invasion',
  date: '2026-05-21',
  time: '18:00',
  description: 'Line one\nLine two',
  author: 'Chief',
  recurrence: 'weekly',
  recurrence_end: '2026-06-30',
};

const DTSTAMP = '20260501T120000Z';

describe('buildVEvent', () => {
  it('builds a VEVENT with UTC start/end and escaped description', () => {
    const v = buildVEvent(EVENT, null, DTSTAMP);
    expect(v).toContain('DTSTART:20260521T180000Z');
    expect(v).toContain('DTEND:20260521T190000Z');
    expect(v).toContain('UID:evt-1-2026-05-21@aoz-alliance');
    expect(v).toContain('DESCRIPTION:Line one\\nLine two');
    // Lignes séparées en CRLF pur (RFC 5545)
    expect(v.split('\r\n')[0]).toBe('BEGIN:VEVENT');
    expect(v).not.toMatch(/[^\r]\n/);
  });

  it('emits RRULE only when includeRrule is set', () => {
    const without = buildVEvent(EVENT, null, DTSTAMP);
    expect(without).not.toContain('RRULE');

    const withRrule = buildVEvent(EVENT, null, DTSTAMP, { includeRrule: true });
    expect(withRrule).toContain('RRULE:FREQ=WEEKLY;UNTIL=20260630T235959Z');
  });

  it('uses the occurrence date over the base date', () => {
    const v = buildVEvent(EVENT, '2026-05-28', DTSTAMP);
    expect(v).toContain('DTSTART:20260528T180000Z');
    expect(v).toContain('UID:evt-1-2026-05-28@aoz-alliance');
  });

  it('rolls DTEND into the next day for a 23:30 event', () => {
    const lateEvent = { ...EVENT, time: '23:30' };
    const v = buildVEvent(lateEvent, '2026-05-21', DTSTAMP);
    expect(v).toContain('DTSTART:20260521T233000Z');
    expect(v).toContain('DTEND:20260522T003000Z');
  });

  it('escapes RFC 5545 special characters in SUMMARY/DESCRIPTION/ORGANIZER', () => {
    const event = {
      ...EVENT,
      title: 'Raid, Boss; Fight\\Night',
      description: 'Loot: gold, gems; more\\stuff',
      author: 'Chief, Deputy',
    };
    const v = buildVEvent(event, null, DTSTAMP);
    expect(v).toContain('SUMMARY:Raid\\, Boss\\; Fight\\\\Night');
    expect(v).toContain('DESCRIPTION:Loot: gold\\, gems\\; more\\\\stuff');
    expect(v).toContain('ORGANIZER:CN=Chief\\, Deputy');
  });
});

describe('icsEscape', () => {
  it('escapes backslash, semicolon, comma, and newline in RFC 5545 order', () => {
    expect(icsEscape('a\\b,c;d\ne')).toBe('a\\\\b\\,c\\;d\\ne');
  });
});
