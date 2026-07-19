import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
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

import { data, execute } from './correct.js';

type SupabaseFrom = typeof supabase.from;

const ALLIANCE = { id: 'alliance-1', name: 'Test Alliance', discord_channel_id: 'channel-1' };
const PLAYER = { id: 'player-1', name: 'Rin' };

/** Queues a `.select(...).eq(...)[.eq(...)...].maybeSingle()` chain. */
function queueMaybeSingle(data: unknown, error: unknown = null, eqCount = 1) {
  let chain: Record<string, unknown> = { maybeSingle: vi.fn().mockResolvedValue({ data, error }) };
  for (let i = 0; i < eqCount; i++) {
    const inner = chain;
    chain = { eq: vi.fn().mockReturnValue(inner) };
  }
  vi.mocked(supabase.from).mockReturnValueOnce({
    select: vi.fn().mockReturnValue(chain),
  } as unknown as ReturnType<SupabaseFrom>);
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

describe('/correct execute', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    vi.mocked(supabase.rpc).mockReset();
  });

  it('corrects points on an existing participation and logs an audit row', async () => {
    queueMaybeSingle(ALLIANCE, null, 1); // requireAlliance
    queueMaybeSingle(PLAYER, null, 2); // findPlayer
    queueMaybeSingle(
      { id: 'event-1', event_datetime: '2026-07-10T18:00:00Z', at_event_types: { display_name: 'Elite Wars' } },
      null,
      2,
    ); // event lookup
    queueMaybeSingle({ id: 'part-1' }, null, 2); // participation lookup
    queueRpc({ old_value: 100, new_value: 999 }); // at_apply_correction

    const interaction = fakeInteraction({ field: 'points', value: 999, eventId: 'event-1' });
    await execute(interaction);

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
    queueMaybeSingle(PLAYER, null, 2);

    const interaction = fakeInteraction({ field: 'points', value: 999, eventId: null });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('event_id'));
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it('corrects honor on an existing donation for a given week', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(PLAYER, null, 2);
    queueMaybeSingle({ id: 'period-1' }, null, 3); // donation period lookup
    queueMaybeSingle({ id: 'donation-1' }, null, 2); // donation lookup
    queueRpc({ old_value: 1200, new_value: 5000 }); // at_apply_correction

    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: '2026-07-13' });
    await execute(interaction);

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
    queueMaybeSingle(PLAYER, null, 2);

    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: 'not-a-date' });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('YYYY-MM-DD'));
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it('rejects a calendar-invalid week date (regex passes, date does not exist)', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(PLAYER, null, 2);

    // Matches \d{4}-\d{2}-\d{2} but February never has a 30th — plain JS
    // Date rolls this over to 2026-03-02 instead of rejecting it, which is
    // exactly the gap the round-trip check in parseWeekInput closes.
    const interaction = fakeInteraction({ field: 'honor', value: 5000, eventId: null, week: '2026-02-30' });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('YYYY-MM-DD'));
    expect(supabase.from).toHaveBeenCalledTimes(2);
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

  it('refuses cleanly when the player does not belong to this alliance', async () => {
    queueMaybeSingle(ALLIANCE, null, 1);
    queueMaybeSingle(null, null, 2); // findPlayer -> not found

    const interaction = fakeInteraction({});
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Joueur introuvable'));
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });
});
