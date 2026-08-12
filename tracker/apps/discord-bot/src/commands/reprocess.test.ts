import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../lib/supabase.js';

// Same import-time workaround as correct.test.ts / find-duplicates.test.ts:
// every command module pulls in ../lib/supabase.js -> ../config.js, whose
// requireEnv() throws without real secrets in the test environment.
vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../lib/reprocess.js', () => ({
  reprocessMessageScreenshots: vi.fn().mockResolvedValue({ lines: [], embeds: [], rejectedRawTexts: [] }),
}));

import { execute } from './reprocess.js';
import { reprocessMessageScreenshots } from '../lib/reprocess.js';
import { invalidateAllianceCache } from '../lib/alliance.js';

type SupabaseFrom = typeof supabase.from;

const INVOKING_ALLIANCE = { id: 'alliance-1', name: 'Invoking Alliance', discord_channel_id: 'channel-1' };
const TARGET_ALLIANCE = { id: 'alliance-2', name: 'Other Alliance', discord_channel_id: '222222222222222222' };

/** Queues one `resolveAlliance` round-trip: `.select().eq('discord_channel_id', ...).maybeSingle()`. */
function queueAllianceLookup(data: unknown, error: unknown = null) {
  vi.mocked(supabase.from).mockReturnValueOnce({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
  } as unknown as ReturnType<SupabaseFrom>);
}

function fakeMessage(
  attachments: { url: string; name: string; contentType: string | null }[] = [
    { url: 'https://cdn.discordapp.com/att/shot.png', name: 'shot.png', contentType: 'image/png' },
  ],
) {
  return {
    attachments: { values: () => attachments.values() },
  };
}

function fakeInteraction(opts: {
  channelId?: string;
  messageUrl?: string;
  imageOption?: number;
  attachments?: { url: string; name: string; contentType: string | null }[];
}): ChatInputCommandInteraction {
  const {
    channelId = 'channel-1',
    messageUrl = 'https://discord.com/channels/999/222222222222222222/111111111111111111',
    imageOption,
    attachments,
  } = opts;
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: vi.fn().mockResolvedValue(attachments ? fakeMessage(attachments) : fakeMessage()),
    },
  };
  return {
    channelId,
    options: {
      getString: (name: string) => (name === 'message_url' ? messageUrl : null),
      getInteger: () => imageOption ?? null,
      getBoolean: () => false,
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
  } as unknown as ChatInputCommandInteraction;
}

describe('/reprocess execute', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    vi.mocked(reprocessMessageScreenshots).mockClear();
    // resolveAlliance caches per channelId (30s TTL) — clear both ids used
    // below so each test's own queued mocks are the ones actually consumed.
    invalidateAllianceCache('channel-1');
    invalidateAllianceCache('222222222222222222');
  });

  it("rejects a message_url from another alliance's channel", async () => {
    queueAllianceLookup(INVOKING_ALLIANCE); // requireAlliance (invoking channel)
    queueAllianceLookup(TARGET_ALLIANCE); // resolveAlliance (target channel)

    const interaction = fakeInteraction({
      channelId: 'channel-1',
      messageUrl: 'https://discord.com/channels/999/222222222222222222/111111111111111111',
    });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('not in an alliance channel you can reprocess from'),
    );
    expect(reprocessMessageScreenshots).not.toHaveBeenCalled();
  });

  it('reprocesses when the target channel belongs to the invoking alliance', async () => {
    queueAllianceLookup(INVOKING_ALLIANCE); // requireAlliance (invoking channel)
    queueAllianceLookup(INVOKING_ALLIANCE); // resolveAlliance (target channel, same alliance)

    const interaction = fakeInteraction({
      channelId: 'channel-1',
      messageUrl: 'https://discord.com/channels/999/222222222222222222/111111111111111111',
    });
    await execute(interaction);

    expect(reprocessMessageScreenshots).toHaveBeenCalledWith(
      expect.objectContaining({ allianceId: INVOKING_ALLIANCE.id }),
    );
  });

  it('passes the 1-based imageIndex through when the image option is set', async () => {
    queueAllianceLookup(INVOKING_ALLIANCE); // requireAlliance
    queueAllianceLookup(INVOKING_ALLIANCE); // resolveAlliance (same alliance)

    const interaction = fakeInteraction({
      channelId: 'channel-1',
      imageOption: 2,
      attachments: [
        { url: 'u1', name: 'a.png', contentType: 'image/png' },
        { url: 'u2', name: 'b.png', contentType: 'image/png' },
      ],
    });
    await execute(interaction);

    expect(reprocessMessageScreenshots).toHaveBeenCalledWith(
      expect.objectContaining({ imageIndex: 2 }),
    );
  });

  it('omits imageIndex entirely when the option is absent (reprocess all)', async () => {
    queueAllianceLookup(INVOKING_ALLIANCE);
    queueAllianceLookup(INVOKING_ALLIANCE);

    const interaction = fakeInteraction({ channelId: 'channel-1' });
    await execute(interaction);

    const arg = vi.mocked(reprocessMessageScreenshots).mock.calls[0]![0];
    expect(arg).not.toHaveProperty('imageIndex');
  });

  it('rejects an out-of-range image index without calling the reprocessor', async () => {
    queueAllianceLookup(INVOKING_ALLIANCE);
    queueAllianceLookup(INVOKING_ALLIANCE);

    const interaction = fakeInteraction({
      channelId: 'channel-1',
      imageOption: 9,
      attachments: [{ url: 'u1', name: 'only.png', contentType: 'image/png' }],
    });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('out of range'));
    expect(reprocessMessageScreenshots).not.toHaveBeenCalled();
  });

  it('refuses cleanly when the invoking channel is not linked to an alliance', async () => {
    queueAllianceLookup(null); // requireAlliance (invoking channel) -> not found

    const interaction = fakeInteraction({
      channelId: 'channel-1',
      messageUrl: 'https://discord.com/channels/999/222222222222222222/111111111111111111',
    });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('not linked to an alliance'));
    expect(reprocessMessageScreenshots).not.toHaveBeenCalled();
    // Only the invoking-channel lookup should fire — never reaches the target lookup.
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });
});
