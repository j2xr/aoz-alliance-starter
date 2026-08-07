import { describe, it, expect } from 'vitest';
import { PERIOD_OPTIONS, periodStartIso } from './periods';

// Fixed instant so the rolling windows are deterministic regardless of when the
// suite runs. 2026-08-07T12:34:56Z is a Friday, mid-year.
const NOW = new Date('2026-08-07T12:34:56.000Z');

describe('periodStartIso', () => {
  it("'all' has no lower bound", () => {
    expect(periodStartIso('all', NOW)).toBeNull();
  });

  it('unknown keys fall back to no lower bound', () => {
    expect(periodStartIso('nonsense', NOW)).toBeNull();
  });

  it("'7d' is exactly 7 days before now", () => {
    expect(periodStartIso('7d', NOW)).toBe('2026-07-31T12:34:56.000Z');
  });

  it("'30d' is exactly 30 days before now", () => {
    expect(periodStartIso('30d', NOW)).toBe('2026-07-08T12:34:56.000Z');
  });

  it("'ytd' anchors to Jan 1 00:00 UTC of now's year", () => {
    expect(periodStartIso('ytd', NOW)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('defaults `now` to the current time when omitted', () => {
    const before = Date.now();
    const iso = periodStartIso('7d');
    const after = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const t = new Date(iso).getTime();
    expect(t).toBeGreaterThanOrEqual(before - sevenDays);
    expect(t).toBeLessThanOrEqual(after - sevenDays);
  });
});

describe('PERIOD_OPTIONS', () => {
  it('offers the four windows with 7d/30d/ytd/all keys', () => {
    expect(PERIOD_OPTIONS.map(o => o.key)).toEqual(['7d', '30d', 'ytd', 'all']);
    for (const opt of PERIOD_OPTIONS) {
      expect(typeof opt.label).toBe('string');
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });
});
