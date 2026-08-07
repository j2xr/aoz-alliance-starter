import { describe, it, expect } from 'vitest';
import { importVerdict } from './ImportQuality';

// The verdict is driven by the ROW COUNT only, never by points: the header's
// points figure is a different metric than the sum of member points for
// several event types (see 0025_at_event_import_delta.sql for the measured
// ratios). These tests pin that decision down.

describe('importVerdict', () => {
  it('reports unknown when the header yielded no fighter count', () => {
    // Real case in the live data: 4 events (ironblood_battlefield, one
    // polar_invasion) have a NULL official count. Must NOT read as success
    // just because there is no evidence of failure.
    expect(importVerdict({ battlers_coverage_pct: null }).level).toBe('unknown');
  });

  it('reports unknown for a null row', () => {
    expect(importVerdict(null).level).toBe('unknown');
  });

  it('reports ok on a complete import', () => {
    const v = importVerdict({ battlers_coverage_pct: 100 });
    expect(v.level).toBe('ok');
    expect(v.label).toBe('Complete');
  });

  it('tolerates the rounding slack of the view (99.5%)', () => {
    expect(importVerdict({ battlers_coverage_pct: 99.6 }).level).toBe('ok');
  });

  it('warns between 90% and the ok threshold', () => {
    // Live case: elite_wars 2026-04-12, 24 of 26 imported.
    const v = importVerdict({ battlers_coverage_pct: 92.3 });
    expect(v.level).toBe('warn');
    expect(v.label).toContain('92.3');
  });

  it('flags below 90% as bad', () => {
    // Live case: void_war 2026-04-19, 33 of 100 imported.
    const v = importVerdict({ battlers_coverage_pct: 33.0 });
    expect(v.level).toBe('bad');
    expect(v.label).toContain('33');
  });

  it('warns when more rows were imported than declared', () => {
    // Live case: elite_wars 2026-04-06, 17 imported for 15 declared —
    // duplicate players or a misread header, either way worth surfacing.
    const v = importVerdict({ battlers_coverage_pct: 113.3 });
    expect(v.level).toBe('warn');
    expect(v.label).toContain('more rows than declared');
  });

  it('does not treat a 1-row overshoot as an anomaly beyond rounding', () => {
    expect(importVerdict({ battlers_coverage_pct: 100.4 }).level).toBe('ok');
  });

  it('ignores points entirely, however inconsistent they are', () => {
    // elite_wars: header says 21,075 while the import sums to 35,298,670 —
    // a 167,490% "coverage" if the two were (wrongly) compared. The verdict
    // must stay driven by the row count, which is complete here.
    const v = importVerdict({
      battlers_coverage_pct: 100,
      official_points: 21075,
      imported_points: 35298670,
    });
    expect(v.level).toBe('ok');
  });
});
