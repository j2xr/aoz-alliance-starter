import { describe, expect, it, vi, beforeEach } from 'vitest';
import { supabase } from '../lib/supabase.js';

vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));

import { renderEventList, renderIncompleteList } from './event.js';

type SupabaseFrom = typeof supabase.from;

/**
 * Queues one thenable query chain. The Supabase query builder is awaited
 * directly (no terminal .single()), so the chain resolves { data, error, count }
 * whenever any builder method ends the chain.
 */
function queueQuery(data: unknown, count: number | null = null, error: unknown = null) {
  const result = { data, error, count };
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  for (const m of ['select', 'eq', 'gt', 'order', 'range']) chain[m] = vi.fn(() => chain);
  vi.mocked(supabase.from).mockReturnValueOnce(chain as unknown as ReturnType<SupabaseFrom>);
}

/** Queues one .maybeSingle() lookup (used by the event-type validation). */
function queueMaybeSingle(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = { maybeSingle: vi.fn().mockResolvedValue({ data, error }) };
  for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
  vi.mocked(supabase.from).mockReturnValueOnce(chain as unknown as ReturnType<SupabaseFrom>);
}

const COMPLETE = {
  event_id: 'aaaaaaaa-1111-2222-3333-444444444444',
  event_datetime: '2026-05-21T10:00:00Z',
  event_type_code: 'polar_invasion',
  event_type: 'Polar Invasion',
  alliance_rank: 3,
  official_battlers: 30,
  imported_players: 30,
  battlers_delta: 0,
  battlers_coverage_pct: 100,
  official_points: 1_234_567,
};

const SHORT = {
  event_id: 'bbbbbbbb-1111-2222-3333-444444444444',
  event_datetime: '2026-05-20T10:00:00Z',
  event_type_code: 'polar_invasion',
  event_type: 'Polar Invasion',
  alliance_rank: 5,
  official_battlers: 11,
  imported_players: 8,
  battlers_delta: 3,
  battlers_coverage_pct: 72.7,
  official_points: 42_000,
};

describe('renderEventList completeness marker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks a short board with ⚠️ and coverage, leaves a complete one plain', async () => {
    queueQuery([COMPLETE, SHORT], 2);
    const result = await renderEventList('alliance-1', 0, null);

    expect('content' in result).toBe(true);
    if (!('content' in result)) return;
    // Complete board: plain count, no warning glyph on its line.
    expect(result.content).toContain('30 battlers');
    // Short board: warning with imported/official and coverage %.
    expect(result.content).toContain('⚠️ 8/11 battlers (72.7%)');
    expect(supabase.from).toHaveBeenCalledWith('at_v_event_import_delta');
  });

  it('shows an em dash when the header battler count was unreadable', async () => {
    queueQuery(
      [{ ...COMPLETE, official_battlers: null, battlers_delta: null, battlers_coverage_pct: null }],
      1,
    );
    const result = await renderEventList('alliance-1', 0, null);
    if (!('content' in result)) throw new Error('expected content');
    expect(result.content).toContain('— battlers');
    expect(result.content).not.toContain('⚠️');
  });

  it('rejects an unknown event type before querying the view', async () => {
    queueMaybeSingle(null); // at_event_types lookup misses
    const result = await renderEventList('alliance-1', 0, 'not_a_type');
    expect(result).toEqual({ error: 'Unknown event type: `not_a_type`' });
    // Only the validation lookup ran; the view was never queried.
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('returns the empty state when the alliance has no events', async () => {
    queueQuery([], 0);
    const result = await renderEventList('alliance-1', 0, null);
    if (!('content' in result)) throw new Error('expected content');
    expect(result.content).toContain('No events found');
    expect(result.components).toEqual([]);
  });
});

describe('renderIncompleteList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists short boards with missing counts and a low-conf note', async () => {
    queueQuery(
      [{ ...SHORT, needs_review_rows: 2 }],
      1,
    );
    const result = await renderIncompleteList('alliance-1');
    if (!('content' in result)) throw new Error('expected content');
    expect(result.content).toContain('Incomplete boards — 1');
    expect(result.content).toContain('⚠️ 8/11 battlers (72.7%)');
    expect(result.content).toContain('missing 3');
    expect(result.content).toContain('2 low-conf');
  });

  it('shows an N-of-M heading when more boards exist than the cap returns', async () => {
    queueQuery([{ ...SHORT, needs_review_rows: 0 }], 40);
    const result = await renderIncompleteList('alliance-1');
    if (!('content' in result)) throw new Error('expected content');
    expect(result.content).toContain('Incomplete boards — 1 of 40');
    expect(result.content).not.toContain('low-conf');
  });

  it('returns the all-clear state when nothing is short', async () => {
    queueQuery([], 0);
    const result = await renderIncompleteList('alliance-1');
    if (!('content' in result)) throw new Error('expected content');
    expect(result.content).toContain('No incomplete boards');
  });
});
