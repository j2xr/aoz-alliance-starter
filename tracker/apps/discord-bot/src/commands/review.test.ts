import { describe, expect, it, vi, beforeEach } from 'vitest';
import { supabase } from '../lib/supabase.js';

vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));

import { renderReviewList, renderReviewNames, resolveFlag } from './review.js';

type SupabaseFrom = typeof supabase.from;

/** Queues one awaited query chain resolving { data, error, count }. */
function queueQuery(data: unknown, count: number | null = null, error: unknown = null) {
  const result = { data, error, count };
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  for (const m of ['select', 'eq', 'order', 'range']) chain[m] = vi.fn(() => chain);
  vi.mocked(supabase.from).mockReturnValueOnce(chain as unknown as ReturnType<SupabaseFrom>);
}

/** Queues one .update(...).eq(...) write resolving { error }. Records the call. */
function queueUpdate(spy: { table?: string; payload?: unknown; id?: unknown }, error: unknown = null) {
  const chain: Record<string, unknown> = {
    update: vi.fn((payload: unknown) => {
      spy.payload = payload;
      return chain;
    }),
    eq: vi.fn((_col: string, val: unknown) => {
      spy.id = val;
      return { then: (resolve: (v: unknown) => unknown) => resolve({ error }) };
    }),
  };
  vi.mocked(supabase.from).mockImplementationOnce((table: string) => {
    spy.table = table;
    return chain as unknown as ReturnType<SupabaseFrom>;
  });
}

// Roster: an established player, a new misread one accent/glyph away, and an
// unrelated low-confidence player with no near-duplicate.
const ROSTER = [
  { player_id: 'p-est', name: 'Sincityfun', occurrences: 6 },
  { player_id: 'p-mis', name: 'Sincltyfun', occurrences: 1 },
  { player_id: 'p-low', name: 'RandomGuy', occurrences: 2 },
];

// A confident read (0.88) flagged only because Q3 saw it resembles an
// established player — the case the confidence gate alone misses.
const MISREAD_ROW = {
  kind: 'participation',
  row_id: 'aaaaaaaa-1111-2222-3333-444444444444',
  player_id: 'p-mis',
  player_name: 'Sincltyfun',
  ocr_confidence: 0.88,
  occurred_at: '2026-05-21T10:00:00Z',
  context_label: 'Polar Invasion',
  value: 1000,
  value_label: 'points',
};

// A genuinely low-confidence donation row, no established look-alike.
const LOWCONF_ROW = {
  kind: 'donation',
  row_id: 'bbbbbbbb-1111-2222-3333-444444444444',
  player_id: 'p-low',
  player_name: 'RandomGuy',
  ocr_confidence: 0.3,
  occurred_at: '2026-05-20T10:00:00Z',
  context_label: 'Week of 2026-05-18',
  value: 500,
  value_label: 'honor',
};

function textOf(result: { content?: string; embeds?: { data: { description?: string; footer?: { text?: string } } }[] }): string {
  if (typeof result.content === 'string') return result.content;
  const d = result.embeds?.[0]?.data;
  return `${d?.description ?? ''}\n${d?.footer?.text ?? ''}`;
}

beforeEach(() => {
  vi.mocked(supabase.from).mockReset();
});

describe('/review list', () => {
  it('reports an empty worklist without reading the roster', async () => {
    queueQuery([], 0);
    const result = await renderReviewList('alliance-1', 0);
    expect(textOf(result)).toContain('Nothing flagged');
    // roster query must NOT have been consumed (single from() call)
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it('annotates a suspected misread with /merge and a low-conf row with /correct', async () => {
    queueQuery([MISREAD_ROW, LOWCONF_ROW], 2); // at_v_needs_review
    queueQuery(ROSTER); // at_v_player_frequency
    const result = await renderReviewList('alliance-1', 0);
    const text = textOf(result);
    // suspected-misread → merge suggestion naming the established canonical + its frequency
    expect(text).toContain('/merge alias:Sincltyfun into:Sincityfun');
    expect(text).toContain('seen 6×');
    expect(text).toContain('suspected misread');
    // low-confidence non-resembling → value-fix hint, not a merge
    expect(text).toContain('/correct');
    expect(text).toContain('low confidence 0.30');
    // footer surfaces the total + how to clear
    expect(text).toContain('2 flagged');
    expect(text).toContain('/review resolve');
  });
});

describe('/review names', () => {
  it('keeps only rows resembling an established player and drops the rest', async () => {
    queueQuery([MISREAD_ROW, LOWCONF_ROW]); // at_v_needs_review window
    queueQuery(ROSTER); // at_v_player_frequency
    const result = await renderReviewNames('alliance-1');
    const text = textOf(result);
    expect(text).toContain('Sincltyfun');
    expect(text).toContain('/merge alias:Sincltyfun into:Sincityfun');
    expect(text).toContain('Names to reconcile — 1');
    // the unrelated low-conf player is not a name-reconciliation item
    expect(text).not.toContain('RandomGuy');
  });

  it('says so when nothing resembles an established player', async () => {
    queueQuery([LOWCONF_ROW]); // only the unrelated row
    queueQuery(ROSTER);
    const result = await renderReviewNames('alliance-1');
    expect(textOf(result)).toContain('No flagged row resembles an established player');
  });
});

describe('/review resolve', () => {
  it('rejects a too-short id prefix before any query', async () => {
    const outcome = await resolveFlag('alliance-1', 'abc');
    expect(outcome.status).toBe('too_short');
    expect(vi.mocked(supabase.from)).not.toHaveBeenCalled();
  });

  it('clears needs_review on the matching row in the right table', async () => {
    queueQuery([MISREAD_ROW, LOWCONF_ROW]); // alliance-scoped view read
    const spy: { table?: string; payload?: unknown; id?: unknown } = {};
    queueUpdate(spy);
    const outcome = await resolveFlag('alliance-1', 'aaaaaaaa');
    expect(outcome.status).toBe('cleared');
    expect(spy.table).toBe('at_participations'); // participation row → participations table
    expect(spy.payload).toEqual({ needs_review: false });
    expect(spy.id).toBe(MISREAD_ROW.row_id);
  });

  it('routes a donation row to the donations table', async () => {
    queueQuery([LOWCONF_ROW]);
    const spy: { table?: string; payload?: unknown; id?: unknown } = {};
    queueUpdate(spy);
    const outcome = await resolveFlag('alliance-1', 'bbbbbbbb');
    expect(outcome.status).toBe('cleared');
    expect(spy.table).toBe('at_donations');
  });

  it('reports not_found when no row matches', async () => {
    queueQuery([MISREAD_ROW]);
    const outcome = await resolveFlag('alliance-1', 'ffffff');
    expect(outcome.status).toBe('not_found');
  });

  it('reports ambiguous when a prefix matches more than one row', async () => {
    const twin1 = { ...MISREAD_ROW, row_id: 'cccccccc-1111-2222-3333-444444444444' };
    const twin2 = { ...LOWCONF_ROW, row_id: 'cccccccc-9999-2222-3333-444444444444' };
    queueQuery([twin1, twin2]);
    const outcome = await resolveFlag('alliance-1', 'cccccccc');
    expect(outcome.status).toBe('ambiguous');
    if (outcome.status === 'ambiguous') expect(outcome.count).toBe(2);
  });
});
