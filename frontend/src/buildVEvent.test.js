// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildVEvent } from './helpers';

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
});
