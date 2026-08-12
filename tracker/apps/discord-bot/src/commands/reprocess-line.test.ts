import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance, resolveAlliance } from '../lib/alliance.js';
import { processImageAttachment } from '../lib/ingestion.js';
import { resolvePlayerByName } from '../lib/players.js';
import { applyCorrection } from '../lib/corrections.js';

vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../lib/alliance.js', () => ({ requireAlliance: vi.fn(), resolveAlliance: vi.fn() }));
vi.mock('../lib/ingestion.js', () => ({ processImageAttachment: vi.fn() }));
vi.mock('../lib/players.js', () => ({ resolvePlayerByName: vi.fn() }));
vi.mock('../lib/corrections.js', () => ({ applyCorrection: vi.fn() }));

import { execute } from './reprocess-line.js';

type SupabaseFrom = typeof supabase.from;

const ALLIANCE = { id: 'alliance-1', name: 'Test Alliance', discord_channel_id: 'allowed-channel' };
const IMAGE_ATT = { url: 'https://cdn/shot.png', name: 'shot.png', contentType: 'image/png' };

/** Queues one `supabase.from(...).…maybeSingle()` resolving to { data, error }. */
function queueMaybeSingle(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = { maybeSingle: vi.fn().mockResolvedValue({ data, error }) };
  for (const m of ['select', 'eq']) chain[m] = vi.fn().mockReturnValue(chain);
  vi.mocked(supabase.from).mockReturnValueOnce(chain as unknown as ReturnType<SupabaseFrom>);
}

function fakeInteraction(opts: {
  rank?: number;
  image?: number | null;
  messageUrl?: string;
  attachments?: { url: string; name: string; contentType: string | null }[];
}): ChatInputCommandInteraction {
  const {
    rank = 1,
    image = null,
    messageUrl = 'https://discord.com/channels/1/999/222',
    attachments = [IMAGE_ATT],
  } = opts;
  const message = {
    id: '222',
    createdAt: new Date('2026-05-21T10:00:00Z'),
    attachments: { values: () => attachments.values() },
  };
  const channel = { isTextBased: () => true, messages: { fetch: vi.fn().mockResolvedValue(message) } };
  return {
    channelId: 'allowed-channel',
    user: { id: 'user-1' },
    options: {
      getString: (name: string) => (name === 'message_url' ? messageUrl : null),
      getInteger: (name: string) => (name === 'rank' ? rank : name === 'image' ? image : null),
      getBoolean: () => null,
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
  } as unknown as ChatInputCommandInteraction;
}

function lastReply(interaction: ChatInputCommandInteraction): unknown {
  const calls = vi.mocked(interaction.editReply).mock.calls;
  return calls[calls.length - 1]![0];
}

const DONATION_OCR = {
  ok: true,
  filename: 'shot.png',
  fileHash: 'h',
  filePath: '/p',
  ocr: {
    kind: 'donation',
    period_type: 'weekly',
    possible_truncation: false,
    members: [
      { name: 'DarKKnight', alliance_tag: 'SOD', rank: 'R2', alliance_honor: 4200, confidence: 0.9 },
    ],
  },
};

const EVENT_OCR = {
  ok: true,
  filename: 'shot.png',
  fileHash: 'h',
  filePath: '/p',
  ocr: {
    kind: 'event',
    event_type: 'polar_invasion',
    event_datetime: '2026-05-21T10:00:00Z',
    alliance_rank: 3,
    total_battlers: 30,
    total_points: 150000,
    possible_truncation: false,
    members: [{ name: 'Thor', rank: 'R1', power: 5000, points: 100, confidence: 0.9 }],
  },
};

describe('/reprocess-line execute', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    vi.mocked(processImageAttachment).mockReset();
    vi.mocked(resolvePlayerByName).mockReset();
    vi.mocked(applyCorrection).mockReset();
    vi.mocked(requireAlliance).mockResolvedValue(ALLIANCE);
    vi.mocked(resolveAlliance).mockResolvedValue(ALLIANCE);
  });

  it("rejects a message_url from another alliance's channel and never re-reads", async () => {
    vi.mocked(resolveAlliance).mockResolvedValue({ ...ALLIANCE, id: 'other-alliance' });
    const interaction = fakeInteraction({});

    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('not in an alliance channel you can reprocess from'),
    );
    expect(processImageAttachment).not.toHaveBeenCalled();
  });

  it('applies a donation honor correction when the re-read differs from the stored value', async () => {
    vi.mocked(processImageAttachment).mockResolvedValue(DONATION_OCR as never);
    vi.mocked(resolvePlayerByName).mockResolvedValue({
      status: 'found',
      player: { id: 'p1', name: 'DarKKnight' },
    });
    queueMaybeSingle({ id: 'period-1' }); // at_donation_periods
    queueMaybeSingle({ id: 'don-1', alliance_honor: 4000 }); // at_donations (stored differs)
    vi.mocked(applyCorrection).mockResolvedValue({ oldValue: 4000, newValue: 4200 });

    const interaction = fakeInteraction({ rank: 1 });
    await execute(interaction);

    expect(applyCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ targetTable: 'at_donations', field: 'honor', newValue: 4200, playerId: 'p1' }),
    );
    const reply = lastReply(interaction) as { embeds: { data: { title?: string } }[] };
    expect(reply.embeds[0]!.data.title).toContain('correction applied');
  });

  it('applies only the differing event field (points changed, power unchanged)', async () => {
    vi.mocked(processImageAttachment).mockResolvedValue(EVENT_OCR as never);
    vi.mocked(resolvePlayerByName).mockResolvedValue({
      status: 'found',
      player: { id: 'p1', name: 'Thor' },
    });
    queueMaybeSingle({ id: 'et-1' }); // at_event_types
    queueMaybeSingle({ id: 'event-1' }); // at_events
    queueMaybeSingle({ id: 'part-1', points: 90, power: 5000 }); // stored: points differ, power same
    vi.mocked(applyCorrection).mockResolvedValue({ oldValue: 90, newValue: 100 });

    const interaction = fakeInteraction({ rank: 1 });
    await execute(interaction);

    expect(applyCorrection).toHaveBeenCalledTimes(1);
    expect(applyCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ targetTable: 'at_participations', field: 'points', newValue: 100 }),
    );
  });

  it('suggests /merge and writes nothing when the re-read name is not on the roster', async () => {
    vi.mocked(processImageAttachment).mockResolvedValue(DONATION_OCR as never);
    vi.mocked(resolvePlayerByName).mockResolvedValue({ status: 'none' });

    const interaction = fakeInteraction({ rank: 1 });
    await execute(interaction);

    expect(applyCorrection).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    const reply = lastReply(interaction) as { embeds: { data: { description?: string } }[] };
    expect(reply.embeds[0]!.data.description).toContain('/merge');
  });

  it('reports "already correct" and writes nothing when the re-read matches the stored value', async () => {
    vi.mocked(processImageAttachment).mockResolvedValue(DONATION_OCR as never);
    vi.mocked(resolvePlayerByName).mockResolvedValue({
      status: 'found',
      player: { id: 'p1', name: 'DarKKnight' },
    });
    queueMaybeSingle({ id: 'period-1' });
    queueMaybeSingle({ id: 'don-1', alliance_honor: 4200 }); // equals the re-read

    const interaction = fakeInteraction({ rank: 1 });
    await execute(interaction);

    expect(applyCorrection).not.toHaveBeenCalled();
    const reply = lastReply(interaction) as { embeds: { data: { title?: string } }[] };
    expect(reply.embeds[0]!.data.title).toContain('already correct');
  });

  it('rejects a rank past the number of readable rows', async () => {
    vi.mocked(processImageAttachment).mockResolvedValue(DONATION_OCR as never);

    const interaction = fakeInteraction({ rank: 9 });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenLastCalledWith(expect.stringContaining('out of range'));
    expect(resolvePlayerByName).not.toHaveBeenCalled();
  });

  it('refuses player-stats screens (no per-row score to correct)', async () => {
    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'h',
      filePath: '/p',
      ocr: { kind: 'player_stats', members: [{ name: 'x' }] },
    } as never);

    const interaction = fakeInteraction({ rank: 1 });
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.stringContaining('player-stats'),
    );
    expect(applyCorrection).not.toHaveBeenCalled();
  });
});
