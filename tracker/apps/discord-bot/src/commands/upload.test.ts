import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AutocompleteInteraction, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance } from '../lib/alliance.js';
import { processImageAttachment } from '../lib/ingestion.js';
import { upsertDonationResult, upsertEventResult } from '../lib/upsert.js';
import { buildDonationEmbed, buildEventEmbed } from '../lib/embed.js';

// Every command module pulls in ../lib/supabase.js -> ../config.js, whose
// requireEnv() throws at import time without a real DISCORD_BOT_TOKEN etc.
// (same workaround as permissions.test.ts).
vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../lib/alliance.js', () => ({ requireAlliance: vi.fn() }));
// routeOcrResult itself is real (not mocked) — /upload's whole point here is
// proving it now goes THROUGH routeOcrResult instead of reimplementing its
// dispatch, so only its dependencies (upsert*, embed builders) are faked.
vi.mock('../lib/ingestion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ingestion.js')>()),
  processImageAttachment: vi.fn(),
}));
vi.mock('../lib/upsert.js', () => ({
  upsertDonationResult: vi.fn(),
  upsertEventResult: vi.fn(),
  upsertPlayerStatsResult: vi.fn(),
  recordUploadError: vi.fn(),
}));
vi.mock('../lib/embed.js', () => ({
  buildDonationEmbed: vi.fn(),
  buildEventEmbed: vi.fn(),
  buildPlayerStatsEmbed: vi.fn(),
}));

import { autocomplete, execute } from './upload.js';

const EVENT_TYPES = [
  { code: 'polar_invasion', display_name: 'Polar Invasion' },
  { code: 'elite_wars', display_name: 'Elite Wars' },
  { code: 'void_war', display_name: 'Void War' },
];

type SupabaseFrom = typeof supabase.from;

/** Queues a `.from('at_event_types').select(...).order(...)` chain resolving to { data, error }. */
function queueEventTypes(data: unknown, error: unknown = null) {
  vi.mocked(supabase.from).mockReturnValueOnce({
    select: vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data, error }),
    }),
  } as unknown as ReturnType<SupabaseFrom>);
}

function fakeInteraction(focused: string): AutocompleteInteraction {
  return {
    options: { getFocused: () => focused },
    respond: vi.fn(),
  } as unknown as AutocompleteInteraction;
}

describe('upload autocomplete (event_type)', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
  });

  it('lists all event types from the table when nothing typed yet', async () => {
    queueEventTypes(EVENT_TYPES);

    const interaction = fakeInteraction('');
    await autocomplete(interaction);

    expect(supabase.from).toHaveBeenCalledWith('at_event_types');
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Polar Invasion (polar_invasion)', value: 'polar_invasion' },
      { name: 'Elite Wars (elite_wars)', value: 'elite_wars' },
      { name: 'Void War (void_war)', value: 'void_war' },
    ]);
  });

  it('filters by code or display name, case-insensitively', async () => {
    queueEventTypes(EVENT_TYPES);

    const interaction = fakeInteraction('WAR');
    await autocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Elite Wars (elite_wars)', value: 'elite_wars' },
      { name: 'Void War (void_war)', value: 'void_war' },
    ]);
  });

  it('caps results at 25 (Discord autocomplete limit)', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      code: `type_${i}`,
      display_name: `Type ${i}`,
    }));
    queueEventTypes(many);

    const interaction = fakeInteraction('');
    await autocomplete(interaction);

    const respondArg = vi.mocked(interaction.respond).mock.calls[0]![0];
    expect(respondArg).toHaveLength(25);
  });

  it('responds with an empty list on query error instead of throwing', async () => {
    queueEventTypes(null, { message: 'boom' });

    const interaction = fakeInteraction('war');
    await autocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});

// ---------------------------------------------------------------------------
// execute — /upload's OCR routing (Lot 3/8 follow-up: previously reimplemented
// routeOcrResult's dispatch verbatim, ~90 lines, missing whatever routeOcrResult
// gained afterward — possible_truncation, no_members, reversed corrections.
// These tests exercise the real routeOcrResult, only faking its dependencies.
// ---------------------------------------------------------------------------

type FakeAttachment = { id: string; name: string; url: string; contentType: string | null };

const IMAGE_ATT: FakeAttachment = {
  id: 'att-1',
  name: 'shot.png',
  url: 'https://cdn.discordapp.com/attachments/shot.png',
  contentType: 'image/png',
};

const ALLIANCE = { id: 'alliance-1', name: 'TestAlliance', discord_channel_id: 'allowed-channel' };

function fakeOriginalMessage(attachments: FakeAttachment[]) {
  const attMap = new Map(attachments.map((a) => [a.id, a]));
  return {
    id: 'orig-msg-1',
    author: { id: 'uploader-1' },
    createdAt: new Date('2026-05-21T10:00:00Z'),
    attachments: {
      filter: vi.fn().mockImplementation((pred: (att: FakeAttachment) => boolean) => {
        const filtered = new Map([...attMap.entries()].filter(([, v]) => pred(v)));
        return { size: filtered.size, [Symbol.iterator]: () => filtered.entries() };
      }),
    },
  };
}

function fakeUploadInteraction(opts: {
  kind?: 'event' | 'donation';
  eventType?: string | null;
  originalMessage: ReturnType<typeof fakeOriginalMessage>;
}) {
  const { kind = 'donation', eventType = null, originalMessage } = opts;
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    channelId: 'allowed-channel',
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    options: {
      getString: (name: string) => {
        if (name === 'message_url') return 'https://discord.com/channels/1/2/3';
        if (name === 'kind') return kind;
        if (name === 'event_type') return eventType;
        return null;
      },
      getBoolean: () => false,
    },
    client: {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          messages: { fetch: vi.fn().mockResolvedValue(originalMessage) },
        }),
      },
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, editReply };
}

/** `.from('at_screenshot_uploads').delete().eq().eq()` — always called, result unused. */
function queueDeleteExistingUploads() {
  vi.mocked(supabase.from).mockReturnValueOnce({
    delete: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    }),
  } as unknown as ReturnType<typeof supabase.from>);
}

/** `.from('at_event_types').select().eq().maybeSingle()` — only on kind=event. */
function queueEventTypeLookup(row: { id: string; display_name: string } | null) {
  vi.mocked(supabase.from).mockReturnValueOnce({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }) }),
    }),
  } as unknown as ReturnType<typeof supabase.from>);
}

describe('upload execute — donation routing (goes through routeOcrResult)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAlliance).mockResolvedValue(ALLIANCE);
  });

  it('success: embed comes through', async () => {
    queueDeleteExistingUploads();
    const originalMessage = fakeOriginalMessage([IMAGE_ATT]);
    const { interaction, editReply } = fakeUploadInteraction({ kind: 'donation', originalMessage });

    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'hash-1',
      filePath: '/data/inbox/orig-msg-1/shot.png',
      ocr: { kind: 'donation', period_type: 'weekly', members: [], possible_truncation: false },
    });
    const fakeEmbed = { data: {} } as unknown as EmbedBuilder;
    vi.mocked(buildDonationEmbed).mockReturnValue(fakeEmbed);
    vi.mocked(upsertDonationResult).mockResolvedValue({
      status: 'processed',
      periodId: 'period-1',
      periodStart: '2026-05-18',
      memberCount: 3,
      newMemberCount: 1,
      reversedCorrectionsCount: 0,
    });

    await execute(interaction);

    expect(editReply).toHaveBeenLastCalledWith(expect.objectContaining({ embeds: [fakeEmbed] }));
  });

  it('possible_truncation warning surfaces alongside the embed', async () => {
    // This is the concrete bug the reuse fixes: the old hand-rolled dispatch
    // never read possible_truncation at all, so re-testing a suspect capture
    // via /upload silently dropped the warning routeOcrResult already knew
    // how to build.
    queueDeleteExistingUploads();
    const originalMessage = fakeOriginalMessage([IMAGE_ATT]);
    const { interaction, editReply } = fakeUploadInteraction({ kind: 'donation', originalMessage });

    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'hash-1',
      filePath: '/data/inbox/orig-msg-1/shot.png',
      ocr: { kind: 'donation', period_type: 'weekly', members: [], possible_truncation: true },
    });
    vi.mocked(buildDonationEmbed).mockReturnValue({ data: {} } as unknown as EmbedBuilder);
    vi.mocked(upsertDonationResult).mockResolvedValue({
      status: 'processed',
      periodId: 'period-1',
      periodStart: '2026-05-18',
      memberCount: 3,
      newMemberCount: 1,
      reversedCorrectionsCount: 0,
    });

    await execute(interaction);

    const call = editReply.mock.calls.at(-1)?.[0] as { content?: string; embeds?: unknown[] };
    expect(call.embeds).toHaveLength(1);
    expect(call.content).toContain('shot.png');
    expect(call.content).toContain('interrompue');
  });

  it('no_members: failed line, no embed', async () => {
    queueDeleteExistingUploads();
    const originalMessage = fakeOriginalMessage([IMAGE_ATT]);
    const { interaction, editReply } = fakeUploadInteraction({ kind: 'donation', originalMessage });

    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'hash-1',
      filePath: '/data/inbox/orig-msg-1/shot.png',
      ocr: { kind: 'donation', period_type: 'weekly', members: [], possible_truncation: false },
    });
    vi.mocked(upsertDonationResult).mockResolvedValue({ status: 'no_members' });

    await execute(interaction);

    expect(editReply).toHaveBeenLastCalledWith(expect.stringContaining('aucun membre extrait'));
    expect(vi.mocked(buildDonationEmbed)).not.toHaveBeenCalled();
  });

  it('OCR returned the wrong kind (service did not honor the override): flagged before routing', async () => {
    queueDeleteExistingUploads();
    const originalMessage = fakeOriginalMessage([IMAGE_ATT]);
    const { interaction, editReply } = fakeUploadInteraction({ kind: 'donation', originalMessage });

    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'hash-1',
      filePath: '/data/inbox/orig-msg-1/shot.png',
      ocr: {
        kind: 'event',
        event_type: 'polar_invasion',
        event_datetime: null,
        alliance_rank: 1,
        total_battlers: 1,
        total_points: 1,
        members: [],
        possible_truncation: false,
      },
    });

    await execute(interaction);

    expect(editReply).toHaveBeenLastCalledWith(expect.stringContaining('réponse OCR incohérente'));
    expect(vi.mocked(upsertDonationResult)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertEventResult)).not.toHaveBeenCalled();
  });
});

describe('upload execute — event routing (goes through routeOcrResult)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAlliance).mockResolvedValue(ALLIANCE);
  });

  it('success: embed comes through', async () => {
    // Call order matters: execute() validates event_type (at_event_types)
    // before it ever reaches the delete-existing-uploads step.
    queueEventTypeLookup({ id: 'et-1', display_name: 'Polar Invasion' });
    queueDeleteExistingUploads();
    const originalMessage = fakeOriginalMessage([IMAGE_ATT]);
    const { interaction, editReply } = fakeUploadInteraction({
      kind: 'event',
      eventType: 'polar_invasion',
      originalMessage,
    });

    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'hash-1',
      filePath: '/data/inbox/orig-msg-1/shot.png',
      ocr: {
        kind: 'event',
        event_type: 'polar_invasion',
        event_datetime: '2026-05-21T10:00:00Z',
        alliance_rank: 5,
        total_battlers: 30,
        total_points: 150_000,
        members: [],
        possible_truncation: false,
      },
    });
    const fakeEmbed = { data: {} } as unknown as EmbedBuilder;
    vi.mocked(buildEventEmbed).mockReturnValue(fakeEmbed);
    vi.mocked(upsertEventResult).mockResolvedValue({
      status: 'processed',
      eventId: 'event-1',
      eventTypeDisplayName: 'Polar Invasion',
      memberCount: 1,
      newMemberCount: 1,
      reversedCorrectionsCount: 0,
    });

    await execute(interaction);

    expect(editReply).toHaveBeenLastCalledWith(expect.objectContaining({ embeds: [fakeEmbed] }));
  });
});
