import { describe, it, expect, vi, beforeEach } from 'vitest';
import { upsertEventResult, upsertDonationResult, recordUploadError } from './upsert.js';
import { supabase } from './supabase.js';
import logger from '../logger.js';

vi.mock('./supabase.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Supabase-style fluent builder that resolves to { data, error }.
 * Chainable methods (select, eq, in, …) return the same object.
 * .single() / .maybeSingle() also resolve to the same value.
 * `await chain` works via the `then` property.
 */
function mkChain(data: unknown, error: string | null = null) {
  const resolved = { data, error };
  const terminal = Promise.resolve(resolved);
  const c: Record<string, unknown> = {
    then: terminal.then.bind(terminal),
    catch: terminal.catch.bind(terminal),
    finally: terminal.finally.bind(terminal),
    single: vi.fn().mockResolvedValue(resolved),
    maybeSingle: vi.fn().mockResolvedValue(resolved),
  };
  for (const m of ['select', 'eq', 'in', 'is', 'insert', 'upsert', 'update', 'delete', 'order', 'limit', 'range']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  return c;
}

type SupabaseFrom = typeof supabase.from;

/** Enqueues one mockReturnValueOnce on supabase.from. */
function queueFrom(data: unknown, error: string | null = null) {
  vi.mocked(supabase.from).mockReturnValueOnce(
    mkChain(data, error) as unknown as ReturnType<SupabaseFrom>,
  );
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const BASE_EVENT_PARAMS = {
  messageId: 'msg-1',
  userId: 'user-1',
  allianceId: 'alliance-1',
  fileHash: 'hash-abc',
  filePath: '/data/inbox/msg-1/shot.png',
  ocr: {
    kind: 'event' as const,
    event_type: 'polar_invasion',
    event_datetime: '2026-05-21T10:00:00Z',
    alliance_rank: 5,
    total_battlers: 30,
    total_points: 150_000,
    members: [
      { name: 'Alpha', rank: 'R5', power: 1_000_000, points: 50_000, confidence: 0.95 },
      { name: 'Beta',  rank: 'R4', power:   800_000, points: 40_000, confidence: 0.90 },
      { name: 'Gamma', rank: 'R3', power:   600_000, points: 30_000, confidence: 0.85 },
    ],
  },
};

const BASE_DONATION_PARAMS = {
  messageId: 'msg-2',
  userId: 'user-1',
  allianceId: 'alliance-1',
  fileHash: 'hash-def',
  filePath: '/data/inbox/msg-2/donation.png',
  messageCreatedAt: new Date('2026-05-21T10:00:00Z'), // Thursday → week starts 2026-05-18
  ocr: {
    kind: 'donation' as const,
    period_type: 'weekly' as const,
    members: [
      { name: 'Alpha', alliance_tag: 'SOD', rank: 'R5', alliance_honor: 5_000, confidence: 0.95 },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// upsertEventResult
// ---------------------------------------------------------------------------

describe('upsertEventResult', () => {
  it('returns duplicate when the file hash already exists', async () => {
    // dedup check finds an existing upload → early return
    queueFrom({ id: 'existing-upload' });

    const result = await upsertEventResult(BASE_EVENT_PARAMS);

    expect(result).toEqual({ status: 'duplicate' });
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it('returns unknown_event when OCR event type is not in at_event_types', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: not found
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom(null);               // at_event_types: not found
    queueFrom(null);               // at_screenshot_uploads update status → unknown_event

    const result = await upsertEventResult(BASE_EVENT_PARAMS);

    expect(result).toEqual({ status: 'unknown_event', eventType: 'polar_invasion' });
  });

  it('returns processed result and calls at_participations upsert on happy path', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'et-1', display_name: 'Polar Invasion' }); // at_event_types
    queueFrom({ id: 'event-1' }); // at_events upsert
    queueFrom([]);                 // at_player_aliases: no aliases
    queueFrom([]);                 // roster fetch for fuzzy name resolution: empty
    queueFrom([                    // at_players upsert
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
      { id: 'p3', name: 'Gamma' },
    ]);
    queueFrom([]);  // at_alliance_memberships select: none existing
    queueFrom(null); // at_alliance_memberships upsert
    queueFrom(null); // at_participations upsert
    queueFrom(null); // at_screenshot_uploads update → processed

    const result = await upsertEventResult(BASE_EVENT_PARAMS);

    expect(result).toMatchObject({
      status: 'processed',
      eventId: 'event-1',
      eventTypeDisplayName: 'Polar Invasion',
      memberCount: 3,
      newMemberCount: 3,
    });

    // Verify participations were written
    const allTables = vi.mocked(supabase.from).mock.calls.map(([t]) => t);
    expect(allTables).toContain('at_participations');
  });

  it('flags needs_review from ocr_confidence, excluding the LLM-corrected sentinel', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'et-1', display_name: 'Polar Invasion' }); // at_event_types
    queueFrom({ id: 'event-1' }); // at_events upsert
    queueFrom([]);                 // at_player_aliases: no aliases
    queueFrom([]);                 // roster fetch for fuzzy name resolution: empty
    queueFrom([                    // at_players upsert
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
      { id: 'p3', name: 'Gamma' },
    ]);
    queueFrom([]);   // at_alliance_memberships select: none existing
    queueFrom(null); // at_alliance_memberships upsert
    // at_participations: chaîne capturée pour inspecter le payload de l'upsert
    const participationsChain = mkChain(null);
    vi.mocked(supabase.from).mockReturnValueOnce(
      participationsChain as unknown as ReturnType<SupabaseFrom>,
    );
    queueFrom(null); // at_screenshot_uploads update → processed

    const params = {
      ...BASE_EVENT_PARAMS,
      ocr: {
        ...BASE_EVENT_PARAMS.ocr,
        members: [
          { name: 'Alpha', rank: 'R5', power: 1_000_000, points: 50_000, confidence: 0.3 },
          { name: 'Beta', rank: 'R4', power: 800_000, points: 40_000, confidence: 0.9 },
          // -1 sentinel: an LLM correction that was accepted — never needs_review.
          { name: 'Gamma', rank: 'R3', power: 600_000, points: 30_000, confidence: -1 },
        ],
      },
    };

    const result = await upsertEventResult(params);
    expect(result.status).toBe('processed');

    const upsertMock = participationsChain['upsert'] as ReturnType<typeof vi.fn>;
    const payload = upsertMock.mock.calls[0]?.[0] as {
      player_id: string;
      needs_review: boolean;
    }[];
    expect(payload.find((r) => r.player_id === 'p1')?.needs_review).toBe(true);
    expect(payload.find((r) => r.player_id === 'p2')?.needs_review).toBe(false);
    expect(payload.find((r) => r.player_id === 'p3')?.needs_review).toBe(false);
  });

  it('merges aliased members into the single at_players upsert with canonical names', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'et-1', display_name: 'Polar Invasion' }); // at_event_types
    queueFrom({ id: 'event-1' }); // at_events upsert
    // at_player_aliases : 'A1pha' → canonique p1 ('Alpha'), nom embarqué
    queueFrom([{ raw_name: 'A1pha', player_id: 'p1', at_players: { name: 'Alpha' } }]);
    queueFrom([]); // roster fetch for fuzzy name resolution: empty ('Alpha'/'Beta' still unaliased)
    // at_players : chaîne capturée pour inspecter le payload de l'upsert unique
    const playersChain = mkChain([
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ]);
    vi.mocked(supabase.from).mockReturnValueOnce(
      playersChain as unknown as ReturnType<SupabaseFrom>,
    );
    queueFrom([]);   // at_alliance_memberships select
    queueFrom(null); // at_alliance_memberships upsert
    queueFrom(null); // at_participations upsert
    queueFrom(null); // at_screenshot_uploads update

    const params = {
      ...BASE_EVENT_PARAMS,
      ocr: {
        ...BASE_EVENT_PARAMS.ocr,
        members: [
          { name: 'Alpha', rank: 'R5', power: 1_000_000, points: 50_000, confidence: 0.95 },
          // Alias du même joueur canonique, confiance plus faible : sa ligne
          // doit être repliée sur 'Alpha' et perdre le dédup par confiance.
          { name: 'A1pha', rank: 'R5', power: 1_100_000, points: 60_000, confidence: 0.5 },
          { name: 'Beta', rank: 'R4', power: 800_000, points: 40_000, confidence: 0.9 },
        ],
      },
    };

    const result = await upsertEventResult(params);
    expect(result.status).toBe('processed');

    // 2 appels à 'at_players' : la lecture roster pour la résolution floue,
    // et un seul upsert batch (plus d'UPDATE par alias).
    const playerCalls = vi.mocked(supabase.from).mock.calls.filter(([t]) => t === 'at_players');
    expect(playerCalls).toHaveLength(2);
    expect(playersChain['upsert']).toHaveBeenCalledTimes(1);

    const upsertMock = playersChain['upsert'] as ReturnType<typeof vi.fn>;
    const payload = upsertMock.mock.calls[0]?.[0] as { name: string; last_power: number }[];
    expect(payload.map((r) => r.name).sort()).toEqual(['Alpha', 'Beta']);
    // La ligne directe (confiance 0.95) gagne sur l'alias (0.5) pour 'Alpha'.
    expect(payload.find((r) => r.name === 'Alpha')?.last_power).toBe(1_000_000);
  });

  it('fuzzy-redirects an OCR name variant to an existing roster player and persists the alias', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'et-1', display_name: 'Polar Invasion' }); // at_event_types
    queueFrom({ id: 'event-1' }); // at_events upsert
    queueFrom([]); // at_player_aliases: no exact alias for '6ig§teelCurtain'
    // roster fetch: an earlier capture of the same player already exists,
    // itself misread ('§' standing in for 'S') but consistently so.
    queueFrom([{ id: 'p1', name: 'Big§teelCurtain' }]);
    // at_player_aliases upsert: the auto-resolved alias gets persisted
    const aliasInsertChain = mkChain(null);
    vi.mocked(supabase.from).mockReturnValueOnce(
      aliasInsertChain as unknown as ReturnType<SupabaseFrom>,
    );
    // at_players upsert: captured to assert it targets the canonical name
    const playersChain = mkChain([{ id: 'p1', name: 'Big§teelCurtain' }]);
    vi.mocked(supabase.from).mockReturnValueOnce(
      playersChain as unknown as ReturnType<SupabaseFrom>,
    );
    queueFrom([]);   // at_alliance_memberships select
    queueFrom(null); // at_alliance_memberships upsert
    queueFrom(null); // at_participations upsert
    queueFrom(null); // at_screenshot_uploads update

    const params = {
      ...BASE_EVENT_PARAMS,
      ocr: {
        ...BASE_EVENT_PARAMS.ocr,
        members: [
          { name: '6ig§teelCurtain', rank: 'R3', power: 900_000, points: 20_000, confidence: 0.4 },
        ],
      },
    };

    const result = await upsertEventResult(params);
    expect(result.status).toBe('processed');

    const aliasUpsertMock = aliasInsertChain['upsert'] as ReturnType<typeof vi.fn>;
    expect(aliasUpsertMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          alliance_id: 'alliance-1',
          raw_name: '6ig§teelCurtain',
          player_id: 'p1',
          created_by: 'auto:name-resolve',
        }),
      ],
      { onConflict: 'alliance_id,raw_name', ignoreDuplicates: true },
    );

    const playersUpsertMock = playersChain['upsert'] as ReturnType<typeof vi.fn>;
    const payload = playersUpsertMock.mock.calls[0]?.[0] as { name: string }[];
    expect(payload.map((r) => r.name)).toEqual(['Big§teelCurtain']);
  });

  it('leaves an ambiguous fuzzy match as a new player and logs a warning instead of guessing', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'et-1', display_name: 'Polar Invasion' }); // at_event_types
    queueFrom({ id: 'event-1' }); // at_events upsert
    queueFrom([]); // at_player_aliases: no exact alias
    // roster fetch: two existing players are both within edit distance 1
    queueFrom([
      { id: 'p1', name: 'Somethin_kool' },
      { id: 'p2', name: 'Somethin_kooI' },
    ]);
    // No alias insert call: ambiguous match is left unresolved.
    queueFrom([{ id: 'p3', name: 'Somethin-koo1' }]); // at_players upsert: a genuinely new player
    queueFrom([]);   // at_alliance_memberships select
    queueFrom(null); // at_alliance_memberships upsert
    queueFrom(null); // at_participations upsert
    queueFrom(null); // at_screenshot_uploads update

    const params = {
      ...BASE_EVENT_PARAMS,
      ocr: {
        ...BASE_EVENT_PARAMS.ocr,
        members: [
          { name: 'Somethin-koo1', rank: 'R2', power: 700_000, points: 10_000, confidence: 0.6 },
        ],
      },
    };

    const result = await upsertEventResult(params);
    expect(result.status).toBe('processed');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        rawName: 'Somethin-koo1',
        candidates: expect.arrayContaining(['Somethin_kool', 'Somethin_kooI']),
      }),
      expect.stringContaining('Ambiguous'),
    );

    // Aucun alias inséré pour ce nom
    const aliasCalls = vi.mocked(supabase.from).mock.calls.filter(([t]) => t === 'at_player_aliases');
    expect(aliasCalls).toHaveLength(1); // le seul appel est le lookup exact, pas un insert
  });
});

// ---------------------------------------------------------------------------
// upsertDonationResult
// ---------------------------------------------------------------------------

describe('upsertDonationResult', () => {
  it('returns duplicate when the file hash already exists', async () => {
    queueFrom({ id: 'existing-upload' });

    const result = await upsertDonationResult(BASE_DONATION_PARAMS);

    expect(result).toEqual({ status: 'duplicate' });
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it('returns unsupported_period_type for daily periods (only weekly is supported in V1)', async () => {
    queueFrom(null); // dedup: clear (period_type check happens after dedup)

    const result = await upsertDonationResult({
      ...BASE_DONATION_PARAMS,
      ocr: { ...BASE_DONATION_PARAMS.ocr, period_type: 'daily' as const },
    });

    expect(result).toEqual({ status: 'unsupported_period_type', periodType: 'daily' });
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it('returns processed result on happy path', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'period-1' }); // at_donation_periods upsert
    queueFrom([]);                 // at_player_aliases: no aliases
    queueFrom([]);                 // roster fetch for fuzzy name resolution: empty
    queueFrom([{ id: 'p1', name: 'Alpha' }]); // at_players upsert
    queueFrom([]);  // at_alliance_memberships select: none existing
    queueFrom(null); // at_alliance_memberships upsert
    queueFrom(null); // at_donations upsert
    queueFrom(null); // at_screenshot_uploads update → processed

    const result = await upsertDonationResult(BASE_DONATION_PARAMS);

    expect(result).toMatchObject({
      status: 'processed',
      periodId: 'period-1',
      memberCount: 1,
      newMemberCount: 1,
    });
  });

  it('passes leaderboard_position through to the at_donations upsert payload', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'period-1' }); // at_donation_periods upsert
    queueFrom([]);                 // at_player_aliases: no aliases
    queueFrom([]);                 // roster fetch for fuzzy name resolution: empty
    queueFrom([{ id: 'p1', name: 'Alpha' }]); // at_players upsert
    queueFrom([]);  // at_alliance_memberships select: none existing
    queueFrom(null); // at_alliance_memberships upsert
    // at_donations : chaîne capturée pour inspecter le payload de l'upsert
    const donationsChain = mkChain(null);
    vi.mocked(supabase.from).mockReturnValueOnce(
      donationsChain as unknown as ReturnType<SupabaseFrom>,
    );
    queueFrom(null); // at_screenshot_uploads update → processed

    const params = {
      ...BASE_DONATION_PARAMS,
      ocr: {
        ...BASE_DONATION_PARAMS.ocr,
        members: [{ ...BASE_DONATION_PARAMS.ocr.members[0]!, leaderboard_position: 41 }],
      },
    };

    const result = await upsertDonationResult(params);
    expect(result.status).toBe('processed');

    const upsertMock = donationsChain['upsert'] as ReturnType<typeof vi.fn>;
    const payload = upsertMock.mock.calls[0]?.[0] as { leaderboard_position: number | null }[];
    expect(payload[0]?.leaderboard_position).toBe(41);
  });

  it('defaults leaderboard_position to null when the OCR result omits it', async () => {
    queueFrom(null);
    queueFrom({ id: 'upload-1' });
    queueFrom({ id: 'period-1' });
    queueFrom([]);
    queueFrom([]); // roster fetch for fuzzy name resolution: empty
    queueFrom([{ id: 'p1', name: 'Alpha' }]);
    queueFrom([]);
    queueFrom(null);
    const donationsChain = mkChain(null);
    vi.mocked(supabase.from).mockReturnValueOnce(
      donationsChain as unknown as ReturnType<SupabaseFrom>,
    );
    queueFrom(null);

    // BASE_DONATION_PARAMS' lone member has no leaderboard_position field.
    const result = await upsertDonationResult(BASE_DONATION_PARAMS);

    expect(result.status).toBe('processed');
    const upsertMock = donationsChain['upsert'] as ReturnType<typeof vi.fn>;
    const payload = upsertMock.mock.calls[0]?.[0] as { leaderboard_position: number | null }[];
    expect(payload[0]?.leaderboard_position).toBeNull();
  });

  it('flags needs_review from ocr_confidence, excluding the LLM-corrected sentinel', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'period-1' }); // at_donation_periods upsert
    queueFrom([]);                 // at_player_aliases: no aliases
    queueFrom([]);                 // roster fetch for fuzzy name resolution: empty
    queueFrom([
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
      { id: 'p3', name: 'Gamma' },
    ]); // at_players upsert
    queueFrom([]);   // at_alliance_memberships select: none existing
    queueFrom(null); // at_alliance_memberships upsert
    // at_donations: chaîne capturée pour inspecter le payload de l'upsert
    const donationsChain = mkChain(null);
    vi.mocked(supabase.from).mockReturnValueOnce(
      donationsChain as unknown as ReturnType<SupabaseFrom>,
    );
    queueFrom(null); // at_screenshot_uploads update → processed

    const params = {
      ...BASE_DONATION_PARAMS,
      ocr: {
        ...BASE_DONATION_PARAMS.ocr,
        members: [
          { name: 'Alpha', alliance_tag: 'SOD', rank: 'R5', alliance_honor: 5_000, confidence: 0.3 },
          { name: 'Beta', alliance_tag: 'SOD', rank: 'R4', alliance_honor: 4_000, confidence: 0.9 },
          // -1 sentinel: an LLM correction that was accepted — never needs_review.
          { name: 'Gamma', alliance_tag: 'SOD', rank: 'R3', alliance_honor: 3_000, confidence: -1 },
        ],
      },
    };

    const result = await upsertDonationResult(params);
    expect(result.status).toBe('processed');

    const upsertMock = donationsChain['upsert'] as ReturnType<typeof vi.fn>;
    const payload = upsertMock.mock.calls[0]?.[0] as {
      player_id: string;
      needs_review: boolean;
    }[];
    expect(payload.find((r) => r.player_id === 'p1')?.needs_review).toBe(true);
    expect(payload.find((r) => r.player_id === 'p2')?.needs_review).toBe(false);
    expect(payload.find((r) => r.player_id === 'p3')?.needs_review).toBe(false);
  });

  it('logs a warning when leaderboard_position is not strictly increasing within a capture', async () => {
    queueFrom(null);               // at_screenshot_uploads dedup: clear
    queueFrom({ id: 'upload-1' }); // at_screenshot_uploads insert
    queueFrom({ id: 'period-1' }); // at_donation_periods upsert
    queueFrom([]);                 // at_player_aliases: no aliases
    queueFrom([]);                 // roster fetch for fuzzy name resolution: empty
    queueFrom([
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ]); // at_players upsert
    queueFrom([]);   // at_alliance_memberships select: none existing
    queueFrom(null); // at_alliance_memberships upsert
    queueFrom(null); // at_donations upsert
    queueFrom(null); // at_screenshot_uploads update → processed

    const params = {
      ...BASE_DONATION_PARAMS,
      ocr: {
        ...BASE_DONATION_PARAMS.ocr,
        members: [
          { name: 'Alpha', alliance_tag: 'SOD', rank: 'R5', alliance_honor: 5_000, confidence: 0.95, leaderboard_position: 5 },
          { name: 'Beta', alliance_tag: 'SOD', rank: 'R4', alliance_honor: 4_000, confidence: 0.9, leaderboard_position: 3 },
        ],
      },
    };

    await upsertDonationResult(params);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ positions: [5, 3] }),
      expect.stringContaining('not strictly increasing'),
    );
  });
});

// ---------------------------------------------------------------------------
// recordUploadError
// ---------------------------------------------------------------------------

describe('recordUploadError', () => {
  const BASE_ERROR_PARAMS = {
    messageId: 'msg-1',
    userId: 'user-1',
    allianceId: 'alliance-1',
    fileHash: 'hash-abc',
    filePath: '/data/inbox/msg-1/shot.png',
    status: 'failed' as const,
    errorMessage: 'OCR parse error',
  };

  it('does nothing when an upload record already exists for this hash', async () => {
    queueFrom({ id: 'existing-upload' }); // maybeSingle finds existing

    await recordUploadError(BASE_ERROR_PARAMS);

    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it('inserts a new error record when the upload does not exist yet', async () => {
    queueFrom(null);   // maybeSingle: not found
    queueFrom(null);   // insert

    await recordUploadError(BASE_ERROR_PARAMS);

    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(2);
    // Second call must be to the uploads table for the insert
    expect(vi.mocked(supabase.from).mock.calls[1]?.[0]).toBe('at_screenshot_uploads');
  });
});
