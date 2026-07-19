import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../lib/supabase.js';

// Every command module pulls in ../lib/supabase.js -> ../config.js, whose
// requireEnv() throws at import time without a real DISCORD_BOT_TOKEN etc.
// (same workaround as permissions.test.ts / setup-alliance.test.ts).
vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import { autocomplete, data, execute } from './correct.js';
import { invalidateAllianceCache } from '../lib/alliance.js';
import { isoWeekStartParis } from '../lib/period.js';

type SupabaseFrom = typeof supabase.from;

const ALLIANCE = { id: 'alliance-1', name: 'Test Alliance', discord_channel_id: 'channel-1' };
const PLAYER = { id: 'player-1', name: 'Rin' };

/**
 * Queues a `.select(...).eq(...)[.eq(...)...].maybeSingle()` chain and
 * returns the `.eq()` mocks in call order (first call = index 0). Real code
 * previously got away with a swapped filter (e.g. findPlayer checking
 * `.eq('alliance_id', playerId)` instead of `.eq('id', playerId)`) because
 * nothing asserted which column/value each `.eq()` call actually used —
 * returning the mocks lets tests pin that down with
 * `expect(eqMocks[0]).toHaveBeenCalledWith('id', playerId)`.
 */
function queueMaybeSingle(
  data: unknown,
  error: unknown = null,
  eqCount = 1,
): ReturnType<typeof vi.fn>[] {
  const eqMocks: ReturnType<typeof vi.fn>[] = [];
  let chain: Record<string, unknown> = { maybeSingle: vi.fn().mockResolvedValue({ data, error }) };
  for (let i = 0; i < eqCount; i++) {
    const inner = chain;
    const eqFn = vi.fn().mockReturnValue(inner);
    eqMocks.unshift(eqFn); // built inside-out; unshift restores outer-to-inner (= call) order
    chain = { eq: eqFn };
  }
  vi.mocked(supabase.from).mockReturnValueOnce({
    select: vi.fn().mockReturnValue(chain),
  } as unknown as ReturnType<SupabaseFrom>);
  return eqMocks;
}

/**
 * Queues a `.rpc('at_apply_correction', {...}).single()` call resolving to
 * { data, error } — the atomic update+audit-insert (migration 0023) that
 * replaced the old separate `.update()` + `.insert()` pair.
 */
function queueRpc(data: unknown, error: unknown = null) {
  vi.mocked(supabase.rpc).mockReturnValueOnce({
    single: vi.fn().mockResolvedValue({ data, error }),
  } as unknown as ReturnType<typeof supabase.rpc>);
}

/**
 * Queues a `.select(...).eq(...).order(...).limit(...)[.ilike(...)]` chain
 * that resolves directly to `{ data, error }` when awaited (no
 * `.maybeSingle()` terminal) — the shape both autocompletePlayer and
 * autocompleteEvent build their query on.
 */
function queueChain(data: unknown, error: unknown = null) {
  const builder: Record<string, unknown> = {
    then: (resolve: (v: { data: unknown; error: unknown }) => void) => resolve({ data, error }),
  };
  for (const method of ['select', 'eq', 'order', 'limit', 'ilike']) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  vi.mocked(supabase.from).mockReturnValueOnce(builder as unknown as ReturnType<SupabaseFrom>);
}

function fakeAutocompleteInteraction(
  focusedName: 'player' | 'event_id',
  focusedValue: string,
  channelId = 'channel-1',
): AutocompleteInteraction {
  return {
    channelId,
    options: { getFocused: () => ({ name: focusedName, value: focusedValue }) },
    respond: vi.fn().mockResolvedValue(undefined),
  } as unknown as AutocompleteInteraction;
}

function fakeInteraction(opts: {
  player?: string;
  field?: 'points' | 'power' | 'honor';
  value?: number;
  eventId?: string | null;
  week?: string | null;
  channelId?: string;
  userId?: string;
}): ChatInputCommandInteraction {
  const {
    player = PLAYER.id,
    field = 'points',
    value = 999,
    eventId = 'event-1',
    week = null,
    channelId = 'channel-1',
    userId = 'user-1',
  } = opts;
  return {
    channelId,
    user: { id: userId },
    options: {
      getString: (name: string) => {
        if (name === 'player') return player;
        if (name === 'field') return field;
        if (name === 'event_id') return eventId;
        if (name === 'week') return week;
        return null;
      },
      getInteger: () => value,
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

describe('/correct command definition', () => {
  it('caps value at the int4 bound (at_participations.points column)', () => {
    const valueOption = data.toJSON().options?.find((o) => o.name === 'value') as
      | { min_value?: number; max_value?: number }
      | undefined;
    expect(valueOption?.min_value).toBe(0);
    expect(valueOption?.max_value).toBe(2_147_483_647);
  });
});

describe('/correct autocomplete', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    invalidateAllianceCache('channel-1');
  });

  it('slices player names to 100 chars and drops blank names', async () => {
    queueMaybeSingle(ALLIANCE, null, 1); // resolveAlliance
    const longName = 'x'.repeat(150);
    queueChain([
      { id: 'p1', name: longName },
      { id: 'p2', name: '   ' }, // OCR-blank name, must not reach Discord
      { id: 'p3', name: 'Rin' },
    ]);

    const interaction = fakeAutocompleteInteraction('player', 'r');
    await autocomplete(interaction);

    const choices = vi.mocked(interaction.respond).mock.calls[0]![0] as { name: string; value: string }[];
    expect(choices).toHaveLength(2);
    expect(choices.find((c) => c.value === 'p1')!.name).toHaveLength(100);
    expect(choices.some((c) => c.value === 'p2')).toBe(false);
  });

  it('filters event suggestions client-side by the typed text', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueChain([
      { id: 'e1', event_datetime: '2026-07-10T18:00:00Z', at_event_types: { display_name: 'Elite Wars' } },
      { id: 'e2', event_datetime: '2026-07-11T18:00:00Z', at_event_types: { display_name: 'Polar Invasion' } },
      { id: 'e3', event_datetime: '2026-07-12T18:00:00Z', at_event_types: { display_name: 'Elite Wars' } },
    ]);

    const interaction = fakeAutocompleteInteraction('event_id', 'elite');
    await autocomplete(interaction);

    const choices = vi.mocked(interaction.respond).mock.calls[0]![0] as { name: string; value: string }[];
    expect(choices).toHaveLength(2);
    expect(choices.every((c) => c.name.toLowerCase().includes('elite'))).toBe(true);
  });

  it('caps event suggestions at 25 even when every row matches', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueChain(
      Array.from({ length: 50 }, (_, i) => ({
        id: `event-${i}`,
        event_datetime: '2026-07-10T18:00:00Z',
        at_event_types: { display_name: 'Elite Wars' },
      })),
    );

    const interaction = fakeAutocompleteInteraction('event_id', '');
    await autocomplete(interaction);

    const choices = vi.mocked(interaction.respond).mock.calls[0]![0] as unknown[];
    expect(choices).toHaveLength(25);
  });
});

describe('/correct execute', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    vi.mocked(supabase.rpc).mockReset();
    // requireAlliance -> resolveAlliance now caches per channelId (30s TTL,
    // see lib/alliance.ts) — every test below reuses 'channel-1', so without
    // this the first test's queued mock would satisfy every later test's
    // requireAlliance call too, leaving their own queued mocks unconsumed.
    invalidateAllianceCache('channel-1');
  });

  it('corrects points on an existing participation and logs an audit row', async () => {
    const allianceEq = queueMaybeSingle(ALLIANCE, null, 1); // requireAlliance
    const playerEq = queueMaybeSingle(PLAYER, null, 2); // findPlayer
    const eventEq = queueMaybeSingle(
      { id: 'event-1', event_datetime: '2026-07-10T18:00:00Z', at_event_types: { display_name: 'Elite Wars' } },
      null,
      2,
    ); // event lookup
    const participationEq = queueMaybeSingle({ id: 'part-1' }, null, 2); // participation lookup
    queueRpc({ old_value: 100, new_value: 999 }); // at_apply_correction

    const interaction = fakeInteraction({ field: 'points', value: 999, eventId: 'event-1' });
    await execute(interaction);

    // Pins down exactly which column/value each lookup filters on — a
    // swapped .eq() argument (e.g. findPlayer filtering alliance_id by
    // playerId) previously passed every test unnoticed.
    expect(vi.mocked(supabase.from).mock.calls.map(([table]) => table)).toEqual([
      'at_alliances',
      'at_players',
      'at_events',
      'at_participations',
    ]);
    expect(allianceEq[0]).toHaveBeenCalledWith('discord_channel_id', 'channel-1');
    expect(playerEq[0]).toHaveBeenCalledWith('id', PLAYER.id);
    expect(playerEq[1]).toHaveBeenCalledWith('alliance_id', ALLIANCE.id);
    expect(eventEq[0]).toHaveBeenCalledWith('id', 'event-1');
    expect(eventEq[1]).toHaveBeenCalledWith('alliance_id', ALLIANCE.id);
    expect(participationEq[0]).toHaveBeenCalledWith('event_id', 'event-1');
    expect(participationEq[1]).toHaveBeenCalledWith('player_id', PLAYER.id);

    expect(supabase.rpc).toHaveBeenCalledWith('at_apply_correction', {
      p_target_table: 'at_participations',
      p_target_id: 'part-1',
      p_field: 'points',
      p_new_value: 999,
      p_alliance_id: ALLIANCE.id,
      p_player_id: PLAYER.id,
      p_corrected_by: 'user-1',
    });
    const reply = vi.mocked(interaction.editReply).mock.calls[0]![0] as { embeds: unknown[] };
    expect(reply.embeds).toHaveLength(1);
  });

  it('refuses cleanly when no participation exists for this player+event (ligne absente)', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(PLAYER, null, 2);
    queueMaybeSingle(
      { id: 'event-1', event_datetime: '2026-07-10T18:00:00Z', at_event_types: { display_name: 'Elite Wars' } },
      null,
      2,
    );
    queueMaybeSingle(null, null, 2); // no participation row

    const interaction = fakeInteraction({ field: 'power', value: 500000, eventId: 'event-1' });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining(PLAYER.name));
    // No update/insert calls beyond the four lookups above.
    expect(supabase.from).toHaveBeenCalledTimes(4);
  });

  it('requires event_id for points/power corrections', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    // No findPlayer mock queued: this is a pure input check that now runs
    // before findPlayer, so the player lookup must never fire.

    const interaction = fakeInteraction({ field: 'points', value: 999, eventId: null });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('event_id'));
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('corrects honor on an existing donation for a given week', async () => {
    const allianceEq = queueMaybeSingle(ALLIANCE, null, 1); // requireAlliance
    const playerEq = queueMaybeSingle(PLAYER, null, 2); // findPlayer
    const periodEq = queueMaybeSingle({ id: 'period-1' }, null, 3); // donation period lookup
    const donationEq = queueMaybeSingle({ id: 'donation-1' }, null, 2); // donation lookup
    queueRpc({ old_value: 1200, new_value: 5000 }); // at_apply_correction

    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: '2026-07-13' });
    await execute(interaction);

    expect(vi.mocked(supabase.from).mock.calls.map(([table]) => table)).toEqual([
      'at_alliances',
      'at_players',
      'at_donation_periods',
      'at_donations',
    ]);
    expect(allianceEq[0]).toHaveBeenCalledWith('discord_channel_id', 'channel-1');
    expect(playerEq[0]).toHaveBeenCalledWith('id', PLAYER.id);
    expect(playerEq[1]).toHaveBeenCalledWith('alliance_id', ALLIANCE.id);
    expect(periodEq[0]).toHaveBeenCalledWith('alliance_id', ALLIANCE.id);
    expect(periodEq[1]).toHaveBeenCalledWith('period_type', 'weekly');
    expect(periodEq[2]).toHaveBeenCalledWith('period_start', '2026-07-13');
    expect(donationEq[0]).toHaveBeenCalledWith('donation_period_id', 'period-1');
    expect(donationEq[1]).toHaveBeenCalledWith('player_id', PLAYER.id);

    expect(supabase.rpc).toHaveBeenCalledWith('at_apply_correction', {
      p_target_table: 'at_donations',
      p_target_id: 'donation-1',
      p_field: 'honor',
      p_new_value: 5000,
      p_alliance_id: ALLIANCE.id,
      p_player_id: PLAYER.id,
      p_corrected_by: 'user-1',
    });
  });

  it('refuses cleanly when no donation period exists for the given week (ligne absente)', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(PLAYER, null, 2);
    queueMaybeSingle(null, null, 3); // no donation period

    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: '2026-07-13' });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('2026-07-13'));
    expect(supabase.from).toHaveBeenCalledTimes(3);
  });

  it('rejects an invalid week format for honor corrections', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    // No findPlayer mock queued: this pure input check now runs first.

    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: 'not-a-date' });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('YYYY-MM-DD'));
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('rejects a calendar-invalid week date (regex passes, date does not exist)', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    // No findPlayer mock queued: this pure input check now runs first.

    // Matches \d{4}-\d{2}-\d{2} but February never has a 30th — plain JS
    // Date rolls this over to 2026-03-02 instead of rejecting it, which is
    // exactly the gap the round-trip check in parseWeekInput closes.
    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: '2026-02-30' });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('YYYY-MM-DD'));
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('snaps a non-Monday week to its Paris ISO Monday before looking up the donation period', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(PLAYER, null, 2);
    queueMaybeSingle(null, null, 3); // no donation period for the snapped Monday

    // 2026-07-15 is a Wednesday; its week's Monday is 2026-07-13.
    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: '2026-07-15' });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('2026-07-13'));
    expect(interaction.editReply).not.toHaveBeenCalledWith(expect.stringContaining('2026-07-15'));
  });

  it('defaults honor corrections to the current Paris ISO week when week is omitted', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(PLAYER, null, 2);
    const periodEq = queueMaybeSingle(null, null, 3); // no donation period for the default week

    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: null });
    await execute(interaction);

    // Computed the same way execute() does, at call time — this test must
    // stay correct regardless of which day it actually runs on.
    const expectedWeek = isoWeekStartParis(new Date());
    expect(periodEq[2]).toHaveBeenCalledWith('period_start', expectedWeek);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining(expectedWeek));
  });

  it('refuses cleanly when the player does not belong to this alliance', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(null, null, 2); // findPlayer -> not found

    const interaction = fakeInteraction({});
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Joueur introuvable'));
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });
});
