import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../lib/supabase.js';

// Every command module pulls in ../lib/supabase.js -> ../config.js, whose
// requireEnv() throws at import time without a real DISCORD_BOT_TOKEN etc.
// (same workaround as permissions.test.ts / upload.test.ts).
vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));

import { execute } from './setup-alliance.js';
import { invalidateAllianceCache } from '../lib/alliance.js';

type SupabaseFrom = typeof supabase.from;

/** Queues a `.from(...).select(...).eq(...).maybeSingle()` chain (used by both
 * resolveAlliance's channel lookup and the name-conflict check). */
function queueMaybeSingle(data: unknown, error: unknown = null) {
  vi.mocked(supabase.from).mockReturnValueOnce({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
  } as unknown as ReturnType<SupabaseFrom>);
}

/** Queues a `.from('at_alliances').insert(...)` chain resolving to { error }. */
function queueInsert(error: unknown = null) {
  const insert = vi.fn().mockResolvedValue({ error });
  vi.mocked(supabase.from).mockReturnValueOnce({
    insert,
  } as unknown as ReturnType<SupabaseFrom>);
  return insert;
}

function fakeInteraction(name: string, channelId = 'channel-1'): ChatInputCommandInteraction {
  return {
    channelId,
    options: {
      getString: () => name,
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

describe('/setup-alliance execute', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    // resolveAlliance now caches per channelId (30s TTL, see lib/alliance.ts)
    // — every test below reuses 'channel-1', so without this a cached "no
    // alliance" miss (or hit) from an earlier test would short-circuit the
    // queued mock in a later one.
    invalidateAllianceCache('channel-1');
  });

  it('creates the alliance and links the current channel when name and channel are both free', async () => {
    queueMaybeSingle(null); // resolveAlliance(channelId) -> no existing alliance
    queueMaybeSingle(null); // name-conflict check -> no row
    const insert = queueInsert(null);

    const interaction = fakeInteraction('My Alliance', 'channel-1');
    await execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith({ name: 'My Alliance', discord_channel_id: 'channel-1' });
    const reply = vi.mocked(interaction.editReply).mock.calls[0]![0] as { embeds: unknown[] };
    expect(reply.embeds).toHaveLength(1);
  });

  it('refuses when this channel is already linked to an alliance', async () => {
    queueMaybeSingle({ id: 'a1', name: 'Existing Alliance', discord_channel_id: 'channel-1' });

    const interaction = fakeInteraction('New Name', 'channel-1');
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Existing Alliance'),
    );
    // Only the resolveAlliance lookup ran — no name check, no insert.
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('refuses when the name is already taken by another channel', async () => {
    queueMaybeSingle(null); // resolveAlliance(channelId) -> no existing alliance
    queueMaybeSingle({ id: 'a2' }); // name-conflict check -> row found

    const interaction = fakeInteraction('Taken Name', 'channel-1');
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Taken Name'));
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it('propagates a database error from the insert instead of swallowing it', async () => {
    queueMaybeSingle(null);
    queueMaybeSingle(null);
    queueInsert({ message: 'boom', code: '23505' });

    const interaction = fakeInteraction('My Alliance', 'channel-1');
    await expect(execute(interaction)).rejects.toMatchObject({ message: 'boom' });
  });
});
