import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isoWeekStartParis } from './period.js';

// Vecteurs partagés avec le frontend (donationFormat.test.js) : les deux
// implémentations du lundi ISO Europe/Paris doivent rester d'accord.
const sharedVectors = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../..', 'shared-test-vectors/paris-iso-week.json'),
    'utf-8',
  ),
) as { vectors: { label: string; input: string; expected: string }[] };

describe('isoWeekStartParis — vecteurs partagés', () => {
  it.each(sharedVectors.vectors)('$label ($input → $expected)', ({ input, expected }) => {
    expect(isoWeekStartParis(new Date(input))).toBe(expected);
  });
});

describe('isoWeekStartParis', () => {
  it('returns the Monday for a Thursday afternoon in Europe/Paris (CEST)', () => {
    // 2026-04-30 is a Thursday; the ISO week starts on 2026-04-27.
    const ts = new Date('2026-04-30T16:00:00+02:00');
    expect(isoWeekStartParis(ts)).toBe('2026-04-27');
  });

  it('returns the same Monday when called on the Monday itself', () => {
    const ts = new Date('2026-04-27T08:30:00+02:00');
    expect(isoWeekStartParis(ts)).toBe('2026-04-27');
  });

  it('returns the previous Monday when called on a Sunday evening', () => {
    // 2026-05-03 is a Sunday → week starts 2026-04-27.
    const ts = new Date('2026-05-03T22:30:00+02:00');
    expect(isoWeekStartParis(ts)).toBe('2026-04-27');
  });

  it('respects the Europe/Paris timezone when the UTC date is the previous day', () => {
    // 2026-04-26T23:30 UTC is 2026-04-27 01:30 Europe/Paris (CEST = +02:00).
    // The ISO week start of that Paris-local date is itself (Monday).
    const ts = new Date('2026-04-26T23:30:00Z');
    expect(isoWeekStartParis(ts)).toBe('2026-04-27');
  });

  it('returns the new week when crossing midnight Paris-local on a Monday', () => {
    // 2026-04-26T22:30 UTC is 2026-04-27 00:30 Europe/Paris (Monday).
    const ts = new Date('2026-04-26T22:30:00Z');
    expect(isoWeekStartParis(ts)).toBe('2026-04-27');
  });

  it('handles the spring DST transition (+01 → +02 last Sunday of March)', () => {
    // 2026-03-29 is the spring DST switch in Europe/Paris (Sunday).
    // Week starts on Monday 2026-03-23.
    const ts = new Date('2026-03-29T03:30:00+02:00');
    expect(isoWeekStartParis(ts)).toBe('2026-03-23');
  });

  it('handles year boundary correctly', () => {
    // Friday 2026-01-02 → ISO week starts on Monday 2025-12-29.
    const ts = new Date('2026-01-02T12:00:00+01:00');
    expect(isoWeekStartParis(ts)).toBe('2025-12-29');
  });
});
