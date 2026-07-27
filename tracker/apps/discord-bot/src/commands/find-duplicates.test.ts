import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { supabase } from '../lib/supabase.js';

vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));

import { data, execute, handleButton } from './find-duplicates.js';
import { invalidateAllianceCache } from '../lib/alliance.js';

type SupabaseFrom = typeof supabase.from;

const ALLIANCE = { id: 'alliance-1', name: 'Test Alliance', discord_channel_id: 'channel-1' };

/** Same shape as commands/merge.test.ts's mkChain. */
function mkChain(data: unknown, error: unknown = null) {
  const resolved = { data, error };
  const terminal = Promise.resolve(resolved);
  const c: Record<string, unknown> = {
    then: terminal.then.bind(terminal),
    catch: terminal.catch.bind(terminal),
    finally: terminal.finally.bind(terminal),
    single: vi.fn().mockResolvedValue(resolved),
    maybeSingle: vi.fn().mockResolvedValue(resolved),
  };
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete', 'upsert']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  return c;
}

function queueFrom(data: unknown, error: unknown = null) {
  vi.mocked(supabase.from).mockReturnValueOnce(
    mkChain(data, error) as unknown as ReturnType<SupabaseFrom>,
  );
}

function fakeInteraction(channelId = 'channel-1', minTier: string | null = null): ChatInputCommandInteraction {
  return {
    channelId,
    options: { getString: (name: string) => (name === 'min_tier' ? minTier : null) },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

function fakeButtonInteraction(channelId = 'channel-1'): ButtonInteraction {
  return {
    channelId,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

// Sequential query order inside scanAllContexts (see find-duplicates.ts):
// at_events, at_participations, at_donation_periods, at_donations.
function queueEmptyScan() {
  queueFrom([]); // at_events
  queueFrom([]); // at_donation_periods (fetchEventContexts returns [] before touching at_participations)
}

describe('/find-duplicates command definition', () => {
  it('requires ManageGuild', () => {
    expect(data.toJSON().default_member_permissions).toBe(
      PermissionFlagsBits.ManageGuild.toString(),
    );
  });
});

describe('/find-duplicates execute', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    invalidateAllianceCache('channel-1');
  });

  it('replies with the standard message and queries nothing when the channel has no alliance', async () => {
    queueFrom(null); // requireAlliance
    const interaction = fakeInteraction();
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      "⚠️ Ce channel n'est pas associé à une alliance.",
    );
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it('is read-only: never calls insert/update/delete/upsert on any table', async () => {
    queueFrom(ALLIANCE); // requireAlliance
    queueEmptyScan();

    const interaction = fakeInteraction();
    await execute(interaction);

    for (const call of vi.mocked(supabase.from).mock.results) {
      const chain = call.value as Record<string, unknown>;
      for (const method of ['insert', 'update', 'delete', 'upsert']) {
        if (method in chain) {
          expect(chain[method], `${method} should never be called`).not.toHaveBeenCalled();
        }
      }
    }
  });

  it('reports "no duplicates" when nothing is found', async () => {
    queueFrom(ALLIANCE);
    queueEmptyScan();

    const interaction = fakeInteraction();
    await execute(interaction);

    const replyArg = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as {
      embeds: { data: { description?: string } }[];
    };
    expect(replyArg.embeds[0]?.data.description).toContain('Aucun doublon probable détecté');
  });

  it('golden path: surfaces a HIGH-tier pair above a LOW-tier same-value coincidence', async () => {
    queueFrom(ALLIANCE); // requireAlliance
    queueFrom([
      { id: 'ev1', event_datetime: '2026-04-06T13:30:00Z', at_event_types: { display_name: 'Elite Wars' } },
    ]); // at_events
    queueFrom([
      // ГАШВУХMARKHOR / ZAIBYXMARKHOR: strong name proximity, same points -> HIGH
      { event_id: 'ev1', player_id: 'p1', points: 1555956, ocr_confidence: 0.69, at_players: { name: 'ГАШВУХMARKHOR' } },
      { event_id: 'ev1', player_id: 'p2', points: 1555956, ocr_confidence: 0.72, at_players: { name: 'ZAIBYXMARKHOR' } },
      // kotarou / Moud: same value, unrelated names -> LOW
      { event_id: 'ev1', player_id: 'p3', points: 600, ocr_confidence: 0.9, at_players: { name: 'kotarou' } },
      { event_id: 'ev1', player_id: 'p4', points: 600, ocr_confidence: 0.9, at_players: { name: 'Moud' } },
    ]); // at_participations
    queueFrom([]); // at_donation_periods

    const interaction = fakeInteraction('channel-1', 'low'); // include LOW tier too
    await execute(interaction);

    const replyArg = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as {
      embeds: { data: { description?: string } }[];
    };
    const description = replyArg.embeds[0]?.data.description ?? '';
    expect(description).toContain('ГАШВУХMARKHOR');
    expect(description).toContain('ZAIBYXMARKHOR');
    expect(description).toContain('kotarou');
    // HIGH-tier pair must render before the LOW-tier coincidence.
    expect(description.indexOf('ГАШВУХMARKHOR')).toBeLessThan(description.indexOf('kotarou'));
  });

  it('min_tier=high filters out LOW-tier same-value coincidences', async () => {
    queueFrom(ALLIANCE);
    queueFrom([
      { id: 'ev1', event_datetime: '2026-04-06T13:30:00Z', at_event_types: { display_name: 'Elite Wars' } },
    ]);
    queueFrom([
      { event_id: 'ev1', player_id: 'p1', points: 600, ocr_confidence: 0.9, at_players: { name: 'kotarou' } },
      { event_id: 'ev1', player_id: 'p2', points: 600, ocr_confidence: 0.9, at_players: { name: 'Moud' } },
    ]);
    queueFrom([]); // at_donation_periods

    const interaction = fakeInteraction('channel-1', 'high');
    await execute(interaction);

    const replyArg = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as {
      embeds: { data: { description?: string } }[];
    };
    expect(replyArg.embeds[0]?.data.description).toContain('Aucun doublon probable détecté');
  });
});

describe('/find-duplicates handleButton', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    invalidateAllianceCache('channel-1');
  });

  it('defers the update, then edits with the requested page', async () => {
    queueFrom(ALLIANCE); // resolveAlliance
    queueEmptyScan();

    const interaction = fakeButtonInteraction();
    await handleButton(interaction, ['dup', 'medium', '0']);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('replies with a content message (not editReply(string)) when the channel lost its alliance', async () => {
    queueFrom(null); // resolveAlliance
    const interaction = fakeButtonInteraction();
    await handleButton(interaction, ['dup', 'medium', '0']);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('alliance') }),
    );
  });
});
