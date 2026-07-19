import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import { routeOcrResult, type OcrRoutingMessages } from './ingestion.js';
import {
  recordUploadError,
  upsertDonationResult,
  upsertEventResult,
  upsertPlayerStatsResult,
} from './upsert.js';
import { buildDonationEmbed, buildEventEmbed, buildPlayerStatsEmbed } from './embed.js';
import logger from '../logger.js';

// routeOcrResult is the dispatch shared between messageCreate.ts and
// reprocess.ts (Cleanup-2): given an OCR result, decide which upsert*Result
// to call and turn its status into a caller-agnostic outcome. Response
// wording is caller-supplied (see MESSAGES below) — real callers both use
// the shared lib/messages.ts wording (B4); this test uses distinctive
// wording instead, to prove routeOcrResult actually uses what's injected.

// ingestion.ts imports `config` at module top, and config.ts calls
// requireEnv(...) at evaluation time — throwing if the env vars are unset (as
// they are in CI, which has no .env). routeOcrResult never reads config, so an
// empty stub is enough to suppress that module-load throw (same workaround as
// messageCreate.test.ts / permissions.test.ts).
vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./upsert.js', () => ({
  recordUploadError: vi.fn(),
  upsertDonationResult: vi.fn(),
  upsertEventResult: vi.fn(),
  upsertPlayerStatsResult: vi.fn(),
}));
vi.mock('./embed.js', () => ({
  buildDonationEmbed: vi.fn(),
  buildEventEmbed: vi.fn(),
  buildPlayerStatsEmbed: vi.fn(),
}));

const MESSAGE = { id: 'msg-1', author: { id: 'user-1' }, createdAt: new Date('2026-05-21T10:00:00Z') };

// Distinctive wording (not any real caller's) so a test failure clearly
// shows whether routeOcrResult used the injected messages at all.
const MESSAGES: OcrRoutingMessages = {
  screenUnrecognized: (filename, detail) => `SCREEN_UNRECOGNIZED:${filename}:${detail}`,
  ocrError: (filename, error, detail) => `OCR_ERROR:${filename}:${error}:${detail ?? ''}`,
  databaseError: (filename, err) => `DB_ERROR:${filename}:${err}`,
  unknownEventType: (filename, eventType) => `UNKNOWN_EVENT:${filename}:${eventType}`,
  missingDatetime: (filename) => `MISSING_DATETIME:${filename}`,
};

const BASE_PARAMS = {
  message: MESSAGE,
  allianceId: 'alliance-1',
  fileHash: 'hash-abc',
  filePath: '/data/inbox/msg-1/shot.png',
  filename: 'shot.png',
  messages: MESSAGES,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('routeOcrResult — OCR errors', () => {
  it('unknown_event: records the upload error and uses screenUnrecognized wording', async () => {
    vi.mocked(recordUploadError).mockResolvedValue(undefined);

    const result = await routeOcrResult({
      ...BASE_PARAMS,
      ocr: { error: 'unknown_event', detail: 'blurry header' },
    });

    expect(result).toEqual({ outcome: 'unknown_event', line: 'SCREEN_UNRECOGNIZED:shot.png:blurry header' });
    expect(vi.mocked(recordUploadError)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unknown_event', errorMessage: 'unknown_event: blurry header' }),
    );
  });

  it('other OCR error: records as failed and uses ocrError wording', async () => {
    vi.mocked(recordUploadError).mockResolvedValue(undefined);

    const result = await routeOcrResult({
      ...BASE_PARAMS,
      ocr: { error: 'ocr_timeout' },
    });

    expect(result).toEqual({ outcome: 'failed', line: 'OCR_ERROR:shot.png:ocr_timeout:' });
    expect(vi.mocked(recordUploadError)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('logs but does not throw when recordUploadError itself fails', async () => {
    vi.mocked(recordUploadError).mockRejectedValue(new Error('db down'));

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: { error: 'ocr_timeout' } });

    expect(result.outcome).toBe('failed');
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('db down') }),
      'Failed to record upload error',
    );
  });
});

describe('routeOcrResult — player_stats', () => {
  const OCR = { kind: 'player_stats' as const, members: [] };

  it('success: builds the embed and surfaces rejectedRawTexts', async () => {
    const fakeEmbed = { data: {} } as unknown as EmbedBuilder;
    vi.mocked(buildPlayerStatsEmbed).mockReturnValue(fakeEmbed);
    vi.mocked(upsertPlayerStatsResult).mockResolvedValue({
      status: 'processed',
      recordedDate: '2026-05-21',
      memberCount: 2,
      skippedCount: 1,
      lowConfidenceCount: 0,
      rejectedRawTexts: ['garbled line'],
    });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({
      outcome: 'success',
      embed: fakeEmbed,
      rejectedRawTexts: ['garbled line'],
    });
  });

  it('success with no rejected members omits rejectedRawTexts entirely', async () => {
    vi.mocked(buildPlayerStatsEmbed).mockReturnValue({} as EmbedBuilder);
    vi.mocked(upsertPlayerStatsResult).mockResolvedValue({
      status: 'processed',
      recordedDate: '2026-05-21',
      memberCount: 2,
      skippedCount: 0,
      lowConfidenceCount: 0,
      rejectedRawTexts: [],
    });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result.rejectedRawTexts).toBeUndefined();
  });

  it('duplicate', async () => {
    vi.mocked(upsertPlayerStatsResult).mockResolvedValue({ status: 'duplicate' });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'duplicate', line: '🔁 **shot.png** — capture déjà traitée (doublon).' });
  });

  it('no_members', async () => {
    vi.mocked(upsertPlayerStatsResult).mockResolvedValue({ status: 'no_members' });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({
      outcome: 'failed',
      line: '⚠️ **shot.png** — aucun joueur extrait de la capture stats.',
    });
  });

  it('upsert throws: uses caller-supplied databaseError wording', async () => {
    vi.mocked(upsertPlayerStatsResult).mockRejectedValue(new Error('connection reset'));

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'failed', line: 'DB_ERROR:shot.png:Error: connection reset' });
  });
});

describe('routeOcrResult — donation', () => {
  const OCR = { kind: 'donation' as const, period_type: 'weekly' as const, members: [] };

  it('success', async () => {
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

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'success', embed: fakeEmbed });
  });

  it('success with a reversed correction: embed and warning line both come through', async () => {
    const fakeEmbed = { data: {} } as unknown as EmbedBuilder;
    vi.mocked(buildDonationEmbed).mockReturnValue(fakeEmbed);
    vi.mocked(upsertDonationResult).mockResolvedValue({
      status: 'processed',
      periodId: 'period-1',
      periodStart: '2026-05-18',
      memberCount: 3,
      newMemberCount: 1,
      reversedCorrectionsCount: 2,
    });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result.embed).toBe(fakeEmbed);
    expect(result.line).toContain('shot.png');
    expect(result.line).toContain('2 corrections');
  });

  it('duplicate', async () => {
    vi.mocked(upsertDonationResult).mockResolvedValue({ status: 'duplicate' });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'duplicate', line: '🔁 **shot.png** — capture déjà traitée (doublon).' });
  });

  it('unsupported_period_type', async () => {
    vi.mocked(upsertDonationResult).mockResolvedValue({
      status: 'unsupported_period_type',
      periodType: 'daily',
    });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({
      outcome: 'failed',
      line: '⚠️ **shot.png** — onglet `daily` non géré (V1 = Weekly uniquement).',
    });
  });

  it('upsert throws: uses caller-supplied databaseError wording', async () => {
    vi.mocked(upsertDonationResult).mockRejectedValue(new Error('constraint violation'));

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'failed', line: 'DB_ERROR:shot.png:Error: constraint violation' });
  });
});

describe('routeOcrResult — event', () => {
  const OCR = {
    kind: 'event' as const,
    event_type: 'polar_invasion',
    event_datetime: '2026-05-21T10:00:00Z',
    alliance_rank: 5,
    total_battlers: 30,
    total_points: 150_000,
    members: [],
  };

  it('success', async () => {
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

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'success', embed: fakeEmbed });
  });

  it('duplicate', async () => {
    vi.mocked(upsertEventResult).mockResolvedValue({ status: 'duplicate' });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'duplicate', line: '🔁 **shot.png** — capture déjà traitée (doublon).' });
  });

  it('unknown_event: uses caller-supplied unknownEventType wording', async () => {
    vi.mocked(upsertEventResult).mockResolvedValue({ status: 'unknown_event', eventType: 'mystery_event' });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'unknown_event', line: 'UNKNOWN_EVENT:shot.png:mystery_event' });
  });

  it('missing_datetime: uses caller-supplied missingDatetime wording', async () => {
    vi.mocked(upsertEventResult).mockResolvedValue({ status: 'missing_datetime' });

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'failed', line: 'MISSING_DATETIME:shot.png' });
  });

  it('upsert throws: uses caller-supplied databaseError wording', async () => {
    vi.mocked(upsertEventResult).mockRejectedValue(new Error('timeout'));

    const result = await routeOcrResult({ ...BASE_PARAMS, ocr: OCR });

    expect(result).toEqual({ outcome: 'failed', line: 'DB_ERROR:shot.png:Error: timeout' });
  });
});

describe('routeOcrResult — legacy OCR results without a kind discriminator', () => {
  it('defaults to event routing (ensureKind)', async () => {
    vi.mocked(buildEventEmbed).mockReturnValue({} as EmbedBuilder);
    vi.mocked(upsertEventResult).mockResolvedValue({
      status: 'processed',
      eventId: 'event-1',
      eventTypeDisplayName: 'Polar Invasion',
      memberCount: 1,
      newMemberCount: 1,
      reversedCorrectionsCount: 0,
    });

    const legacyOcr = {
      event_type: 'polar_invasion',
      event_datetime: '2026-05-21T10:00:00Z',
      alliance_rank: 5,
      total_battlers: 30,
      total_points: 150_000,
      members: [],
    };

    const result = await routeOcrResult({
      ...BASE_PARAMS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ocr: legacyOcr as any,
    });

    expect(result.outcome).toBe('success');
    expect(vi.mocked(upsertEventResult)).toHaveBeenCalledOnce();
  });
});
