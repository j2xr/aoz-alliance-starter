import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, EmbedBuilder } from 'discord.js';
import { handleMessageCreate } from './messageCreate.js';
import { resolveAlliance } from '../lib/alliance.js';
import { processImageAttachment } from '../lib/ingestion.js';
import { upsertEventResult, recordUploadError } from '../lib/upsert.js';
import { buildEventEmbed } from '../lib/embed.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']) },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../lib/alliance.js', () => ({ resolveAlliance: vi.fn() }));
vi.mock('../lib/ingestion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ingestion.js')>()),
  processImageAttachment: vi.fn(),
}));
vi.mock('../lib/upsert.js', () => ({
  upsertEventResult: vi.fn(),
  upsertDonationResult: vi.fn(),
  upsertPlayerStatsResult: vi.fn(),
  recordUploadError: vi.fn(),
}));
vi.mock('../lib/embed.js', () => ({
  buildEventEmbed: vi.fn(),
  buildDonationEmbed: vi.fn(),
  buildPlayerStatsEmbed: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Message builder helper
// ---------------------------------------------------------------------------

type FakeAttachment = {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
};

function buildMessage(overrides: {
  authorBot?: boolean;
  channelId?: string;
  attachments?: FakeAttachment[];
} = {}) {
  const { authorBot = false, channelId = 'allowed-channel', attachments = [] } = overrides;
  const ackMsg = { edit: vi.fn().mockResolvedValue(undefined) };
  const attMap = new Map(attachments.map((a) => [a.id, a]));
  const msg = {
    author: { bot: authorBot, id: 'user-123' },
    channelId,
    id: 'msg-123',
    createdAt: new Date('2026-05-21T10:00:00Z'),
    channel: { send: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(ackMsg),
    attachments: {
      filter: vi.fn().mockImplementation(
        (pred: (att: FakeAttachment) => boolean) => {
          const filtered = new Map([...attMap.entries()].filter(([, v]) => pred(v)));
          return {
            size: filtered.size,
            [Symbol.iterator]: () => filtered.entries(),
          };
        },
      ),
    },
  };
  return { msg, ackMsg };
}

const IMAGE_ATT: FakeAttachment = {
  id: 'att-1',
  name: 'shot.png',
  url: 'https://cdn.discordapp.com/attachments/shot.png',
  contentType: 'image/png',
};

const ALLIANCE = { id: 'alliance-1', name: 'TestAlliance', discord_channel_id: 'allowed-channel' };

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleMessageCreate
// ---------------------------------------------------------------------------

describe('handleMessageCreate', () => {
  it('ignores messages from bots (early return, no DB calls)', async () => {
    const { msg } = buildMessage({ authorBot: true, attachments: [IMAGE_ATT] });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    expect(vi.mocked(resolveAlliance)).not.toHaveBeenCalled();
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('ignores messages from non-whitelisted channels', async () => {
    const { msg } = buildMessage({ channelId: 'not-allowed', attachments: [IMAGE_ATT] });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    expect(vi.mocked(resolveAlliance)).not.toHaveBeenCalled();
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('ignores messages with no image attachments', async () => {
    const { msg } = buildMessage({
      attachments: [{ id: 'att-1', name: 'doc.pdf', url: 'https://cdn/doc.pdf', contentType: 'application/pdf' }],
    });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    expect(msg.reply).not.toHaveBeenCalled();
    expect(vi.mocked(resolveAlliance)).not.toHaveBeenCalled();
  });

  it('editReplies with alliance error message when resolveAlliance returns null', async () => {
    vi.mocked(resolveAlliance).mockResolvedValue(null);
    const { msg, ackMsg } = buildMessage({ attachments: [IMAGE_ATT] });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    expect(msg.reply).toHaveBeenCalledOnce();
    const editArg = ackMsg.edit.mock.calls[0]?.[0] as string;
    expect(editArg).toContain('alliance');
  });

  it('editReplies with ❌ and filename when processImageAttachment throws', async () => {
    vi.mocked(resolveAlliance).mockResolvedValue(ALLIANCE);
    vi.mocked(processImageAttachment).mockRejectedValue(new Error('network timeout'));
    const { msg, ackMsg } = buildMessage({ attachments: [IMAGE_ATT] });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    const editArg = ackMsg.edit.mock.calls[0]?.[0] as string;
    expect(editArg).toContain('❌');
    expect(editArg).toContain('shot.png');
  });

  it('editReplies with ⚠️ and "type d\'écran non reconnu" when OCR returns unknown_event error', async () => {
    vi.mocked(resolveAlliance).mockResolvedValue(ALLIANCE);
    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'abc123',
      filePath: '/data/inbox/msg-123/shot.png',
      ocr: { error: 'unknown_event' },
    });
    vi.mocked(recordUploadError).mockResolvedValue(undefined);
    const { msg, ackMsg } = buildMessage({ attachments: [IMAGE_ATT] });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    const editArg = ackMsg.edit.mock.calls[0]?.[0] as string;
    expect(editArg).toContain('⚠️');
    expect(editArg).toContain("type d'écran non reconnu");
  });

  it('calls buildEventEmbed and editReplies with embeds on nominal event path', async () => {
    const ocrEvent = {
      kind: 'event' as const,
      event_type: 'polar_invasion',
      event_datetime: '2026-05-21T10:00:00Z',
      alliance_rank: 5,
      total_battlers: 30,
      total_points: 150_000,
      members: [
        { name: 'Alpha', rank: 'R5', power: 1_000_000, points: 50_000, confidence: 0.95 },
      ],
    };
    vi.mocked(resolveAlliance).mockResolvedValue(ALLIANCE);
    vi.mocked(processImageAttachment).mockResolvedValue({
      ok: true,
      filename: 'shot.png',
      fileHash: 'abc123',
      filePath: '/data/inbox/msg-123/shot.png',
      ocr: ocrEvent,
    });
    vi.mocked(upsertEventResult).mockResolvedValue({
      status: 'processed',
      eventId: 'event-1',
      eventTypeDisplayName: 'Polar Invasion',
      memberCount: 1,
      newMemberCount: 0,
      reversedCorrectionsCount: 0,
    });
    const fakeEmbed = { data: {} } as unknown as EmbedBuilder;
    vi.mocked(buildEventEmbed).mockReturnValue(fakeEmbed);
    const { msg, ackMsg } = buildMessage({ attachments: [IMAGE_ATT] });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    expect(vi.mocked(buildEventEmbed)).toHaveBeenCalledOnce();
    expect(ackMsg.edit).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: [fakeEmbed] }),
    );
  });

  it('reports progress between multiple images and lands on the final summary', async () => {
    const SHOT2: FakeAttachment = {
      id: 'att-2',
      name: 'shot2.png',
      url: 'https://cdn.discordapp.com/attachments/shot2.png',
      contentType: 'image/png',
    };

    vi.mocked(resolveAlliance).mockResolvedValue(ALLIANCE);
    vi.mocked(recordUploadError).mockResolvedValue(undefined);
    vi.mocked(processImageAttachment).mockImplementation(async (_messageId, url) => {
      if (url.includes('shot2')) {
        return {
          ok: true,
          filename: 'shot2.png',
          fileHash: 'def456',
          filePath: '/data/inbox/msg-123/shot2.png',
          ocr: {
            kind: 'event' as const,
            event_type: 'polar_invasion',
            event_datetime: '2026-05-21T10:00:00Z',
            alliance_rank: 5,
            total_battlers: 30,
            total_points: 150_000,
            members: [
              { name: 'Alpha', rank: 'R5', power: 1_000_000, points: 50_000, confidence: 0.95 },
            ],
          },
        };
      }
      return {
        ok: true,
        filename: 'shot.png',
        fileHash: 'abc123',
        filePath: '/data/inbox/msg-123/shot.png',
        ocr: { error: 'unknown_event' as const },
      };
    });
    vi.mocked(upsertEventResult).mockResolvedValue({
      status: 'processed',
      eventId: 'event-1',
      eventTypeDisplayName: 'Polar Invasion',
      memberCount: 1,
      newMemberCount: 0,
      reversedCorrectionsCount: 0,
    });
    const fakeEmbed = { data: {} } as unknown as EmbedBuilder;
    vi.mocked(buildEventEmbed).mockReturnValue(fakeEmbed);

    const { msg, ackMsg } = buildMessage({ attachments: [IMAGE_ATT, SHOT2] });

    await handleMessageCreate(msg as unknown as Message<boolean>);

    // One intermediate progress edit (after image 1/2), then the final summary.
    expect(ackMsg.edit).toHaveBeenCalledTimes(2);

    const progressArg = ackMsg.edit.mock.calls[0]?.[0] as string;
    expect(progressArg).toContain('🔄 Image 1/2');
    expect(progressArg).toContain('1 ⚠️');

    const finalArg = ackMsg.edit.mock.calls[1]?.[0];
    expect(finalArg).toEqual(expect.objectContaining({ embeds: [fakeEmbed] }));
  });
});
