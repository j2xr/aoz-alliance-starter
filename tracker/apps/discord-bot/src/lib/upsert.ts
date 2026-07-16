import type {
  OcrDonationResult,
  OcrEventResult,
  OcrPlayerStatsMember,
  OcrPlayerStatsResult,
} from '@alliance-tracker/shared-types';
import { supabase } from './supabase.js';
import { isoWeekStartParis } from './period.js';
import logger from '../logger.js';

export type ProcessedUpsertResult = {
  status: 'processed';
  eventId: string;
  eventTypeDisplayName: string;
  memberCount: number;
  newMemberCount: number;
};

export type UpsertResult =
  | ProcessedUpsertResult
  | { status: 'duplicate' }
  | { status: 'unknown_event'; eventType: string }
  | { status: 'missing_datetime' };

export type ProcessedDonationUpsertResult = {
  status: 'processed';
  periodId: string;
  periodStart: string;
  memberCount: number;
  newMemberCount: number;
};

export type DonationUpsertResult =
  | ProcessedDonationUpsertResult
  | { status: 'duplicate' }
  | { status: 'unsupported_period_type'; periodType: string };

interface UpsertParams {
  messageId: string;
  userId: string;
  allianceId: string;
  fileHash: string;
  filePath: string;
  ocr: OcrEventResult;
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Deduplicates members by name (keeping the highest-confidence entry), then
 * resolves player aliases and splits members into direct vs aliased sets.
 */
async function resolveAndDedup<T extends { name: string; confidence: number }>(
  members: T[],
  allianceId: string,
  context = 'OCR result',
): Promise<{
  uniqueMembers: T[];
  directMembers: T[];
  aliasedMembers: T[];
  aliasToCanonicalId: Map<string, string>;
  canonicalNameById: Map<string, string>;
}> {
  const uniqueMembers = [
    ...members
      .reduce((map: Map<string, T>, m: T) => {
        const existing = map.get(m.name);
        if (!existing || m.confidence > existing.confidence) map.set(m.name, m);
        return map;
      }, new Map<string, T>())
      .values(),
  ];

  if (uniqueMembers.length < members.length) {
    logger.warn(
      { original: members.length, deduplicated: uniqueMembers.length },
      `Duplicate member names in ${context}, keeping highest-confidence entry per name`,
    );
  }

  // Le nom canonique est embarqué via la FK player_id → at_players : il permet
  // aux membres aliasés de rejoindre l'upsert batch (onConflict alliance_id,name)
  // au lieu d'un UPDATE par ligne (N+1).
  const { data: aliasRows, error: aliasError } = await supabase
    .from('at_player_aliases')
    .select('raw_name, player_id, at_players(name)')
    .eq('alliance_id', allianceId)
    .in('raw_name', uniqueMembers.map((m) => m.name));

  if (aliasError) throw new Error(`Alias lookup failed: ${aliasError.message}`);

  // supabase-js type la relation embarquée en tableau ; le runtime renvoie un
  // objet pour une FK to-one. On accepte les deux formes.
  const typedAliasRows = (aliasRows ?? []) as unknown as {
    raw_name: string;
    player_id: string;
    at_players: { name: string } | { name: string }[] | null;
  }[];
  const aliasToCanonicalId = new Map<string, string>(
    typedAliasRows.map((r) => [r.raw_name, r.player_id]),
  );
  const canonicalNameById = new Map<string, string>();
  for (const r of typedAliasRows) {
    const rel = Array.isArray(r.at_players) ? r.at_players[0] : r.at_players;
    if (rel?.name) canonicalNameById.set(r.player_id, rel.name);
  }

  const directMembers = uniqueMembers.filter((m) => !aliasToCanonicalId.has(m.name));
  const aliasedMembers = uniqueMembers.filter((m) => aliasToCanonicalId.has(m.name));

  if (aliasedMembers.length > 0) {
    logger.info(
      { count: aliasedMembers.length, names: aliasedMembers.map((m) => m.name) },
      'Redirecting aliased OCR names to canonical players',
    );
  }

  return { uniqueMembers, directMembers, aliasedMembers, aliasToCanonicalId, canonicalNameById };
}

/**
 * Déduplique un payload d'upsert at_players par sa clé de conflit (le nom,
 * l'alliance étant constante) en gardant la ligne de meilleure confiance.
 * Nécessaire quand membres directs et aliasés partagent un même joueur
 * canonique : Postgres rejette un upsert qui touche deux fois la même ligne
 * (« cannot affect row a second time »).
 */
function dedupeByName<R extends { name: string }>(
  entries: { row: R; confidence: number }[],
): R[] {
  const best = new Map<string, { row: R; confidence: number }>();
  for (const entry of entries) {
    const current = best.get(entry.row.name);
    if (!current || entry.confidence > current.confidence) best.set(entry.row.name, entry);
  }
  return [...best.values()].map((e) => e.row);
}

/**
 * Combine les lignes joueurs résolues : membres directs (nom OCR) + membres
 * aliasés re-clés sur leur nom OCR (pour que memberByName, construit depuis
 * uniqueMembers, résolve à l'étape participations/donations), dédupliquées
 * par id.
 */
function combinePlayerRows(
  directPlayerRows: { id: string; name: string }[],
  aliasedMembers: { name: string }[],
  aliasToCanonicalId: Map<string, string>,
): { id: string; name: string }[] {
  const seenIds = new Set<string>();
  return [
    ...directPlayerRows,
    ...aliasedMembers.map((m) => ({ id: aliasToCanonicalId.get(m.name)!, name: m.name })),
  ].filter((p) => {
    if (seenIds.has(p.id)) return false;
    seenIds.add(p.id);
    return true;
  });
}

/**
 * Ensures every player in playerRows has an active membership record.
 * Returns the number of newly inserted memberships.
 */
async function upsertMemberships(
  playerRows: { id: string }[],
  allianceId: string,
  joinedAt: string,
): Promise<number> {
  if (playerRows.length === 0) return 0;

  const playerIds = playerRows.map((p) => p.id);

  const { data: existingMemberships, error: memError } = await supabase
    .from('at_alliance_memberships')
    .select('player_id')
    .eq('alliance_id', allianceId)
    .in('player_id', playerIds)
    .is('left_at', null);

  if (memError) throw new Error(`Memberships query failed: ${memError.message} [${memError.code}]`);

  const memberedIds = new Set(
    ((existingMemberships ?? []) as { player_id: string }[]).map((m) => m.player_id),
  );
  const newPlayerRows = playerRows.filter((p) => !memberedIds.has(p.id));

  if (newPlayerRows.length > 0) {
    const { error: memInsertError } = await supabase.from('at_alliance_memberships').upsert(
      newPlayerRows.map((p) => ({
        alliance_id: allianceId,
        player_id: p.id,
        joined_at: joinedAt,
      })),
      // ignoreDuplicates guards against concurrent processing of the same event
      { onConflict: 'alliance_id,player_id,joined_at', ignoreDuplicates: true },
    );
    if (memInsertError)
      throw new Error(
        `Memberships insert failed: ${memInsertError.message} [${memInsertError.code}]`,
      );
  }

  return newPlayerRows.length;
}

/** True si une capture (file_hash, alliance_id) a déjà été enregistrée. */
async function findExistingUpload(fileHash: string, allianceId: string): Promise<boolean> {
  const { data } = await supabase
    .from('at_screenshot_uploads')
    .select('id')
    .eq('file_hash', fileHash)
    .eq('alliance_id', allianceId)
    .maybeSingle();
  return data != null;
}

type InsertUploadOutcome = { status: 'inserted'; uploadId: string } | { status: 'duplicate' };

/**
 * Insère la ligne at_screenshot_uploads. Une violation de la contrainte
 * unique (file_hash, alliance_id) — insertion concurrente entre le check et
 * l'insert — est traduite en { status: 'duplicate' } au lieu d'une erreur
 * brute (Postgres 23505).
 */
async function insertUploadRecord(params: {
  messageId: string;
  userId: string;
  allianceId: string;
  filePath: string;
  fileHash: string;
  processingStatus?: string;
  errorMessage?: string;
  processedAt?: string;
}): Promise<InsertUploadOutcome> {
  const { data: upload, error: uploadError } = await supabase
    .from('at_screenshot_uploads')
    .insert({
      discord_message_id: params.messageId,
      discord_user_id: params.userId,
      alliance_id: params.allianceId,
      file_path: params.filePath,
      file_hash: params.fileHash,
      processing_status: params.processingStatus ?? 'pending',
      ...(params.errorMessage !== undefined && { error_message: params.errorMessage }),
      ...(params.processedAt !== undefined && { processed_at: params.processedAt }),
    })
    .select('id')
    .single();

  if (uploadError ?? !upload) {
    if (uploadError?.code === '23505') {
      logger.info(
        { fileHash: params.fileHash, allianceId: params.allianceId },
        'Duplicate upload (concurrent insert), skipping',
      );
      return { status: 'duplicate' };
    }
    throw new Error(`Failed to insert screenshot upload: ${String(uploadError?.message)}`);
  }
  return { status: 'inserted', uploadId: (upload as { id: string }).id };
}

// ── Exported functions ───────────────────────────────────────────────────────

export async function upsertEventResult(params: UpsertParams): Promise<UpsertResult> {
  const { messageId, userId, allianceId, fileHash, filePath, ocr } = params;

  // Date/heure illisible sur la capture : at_events.event_datetime est NOT NULL
  // et fait partie de la clé de dédup — refus propre plutôt qu'une erreur brute
  // Postgres 23502 qui jetterait aussi les participations.
  if (!ocr.event_datetime) {
    logger.warn({ fileHash, allianceId }, 'OCR result has no event_datetime, skipping');
    return { status: 'missing_datetime' };
  }

  // 1. Dedup check: (file_hash, alliance_id) unique constraint
  if (await findExistingUpload(fileHash, allianceId)) {
    logger.info({ fileHash, allianceId }, 'Duplicate upload, skipping');
    return { status: 'duplicate' };
  }

  // Insert screenshot_uploads record (pending, updated at the end)
  const inserted = await insertUploadRecord({ messageId, userId, allianceId, filePath, fileHash });
  if (inserted.status === 'duplicate') return { status: 'duplicate' };
  const uploadId = inserted.uploadId;

  // 2. Resolve event_type_id from OCR-reported event code
  const { data: eventType, error: etError } = await supabase
    .from('at_event_types')
    .select('id, display_name')
    .eq('code', ocr.event_type)
    .maybeSingle();

  if (etError) throw new Error(`Event type query failed: ${etError.message} [${etError.code}]`);

  if (!eventType) {
    await supabase
      .from('at_screenshot_uploads')
      .update({ processing_status: 'unknown_event' })
      .eq('id', uploadId);
    logger.warn({ eventType: ocr.event_type }, 'Unknown event type');
    return { status: 'unknown_event', eventType: ocr.event_type };
  }

  const et = eventType as { id: string; display_name: string };

  // 3. UPSERT at_events
  const { data: eventRow, error: eventError } = await supabase
    .from('at_events')
    .upsert(
      {
        alliance_id: allianceId,
        event_type_id: et.id,
        event_datetime: ocr.event_datetime,
        alliance_rank: ocr.alliance_rank,
        total_battlers: ocr.total_battlers,
        total_points: ocr.total_points,
        source_message_id: messageId,
      },
      { onConflict: 'alliance_id,event_type_id,event_datetime' },
    )
    .select('id')
    .single();

  if (eventError ?? !eventRow) {
    throw new Error(`Failed to upsert event: ${String(eventError?.message)}`);
  }

  const eventId = (eventRow as { id: string }).id;

  // 4. Batch UPSERT at_players — also updates last_power, last_rank, last_seen_at
  // Deduplicate by name: OCR errors can produce identical names; keep highest confidence.
  const { uniqueMembers, directMembers, aliasedMembers, aliasToCanonicalId, canonicalNameById } =
    await resolveAndDedup(ocr.members, allianceId);

  // 4b. Un seul upsert batch pour membres directs ET aliasés : les lignes
  // aliasées visent le joueur canonique par son nom (conflit alliance_id,name
  // → update), au lieu d'un UPDATE par ligne. Les aliasés dont le nom
  // canonique n'a pu être résolu sont simplement omis du batch (leur ligne
  // at_players existe déjà ; seuls last_* ne sont pas rafraîchis).
  const playerPayload = dedupeByName([
    ...directMembers.map((m) => ({
      row: {
        alliance_id: allianceId,
        name: m.name,
        last_power: m.power,
        last_rank: m.rank,
        last_seen_at: ocr.event_datetime,
      },
      confidence: m.confidence,
    })),
    ...aliasedMembers.flatMap((m) => {
      const canonicalName = canonicalNameById.get(aliasToCanonicalId.get(m.name)!);
      if (!canonicalName) return [];
      return [
        {
          row: {
            alliance_id: allianceId,
            name: canonicalName,
            last_power: m.power,
            last_rank: m.rank,
            last_seen_at: ocr.event_datetime,
          },
          confidence: m.confidence,
        },
      ];
    }),
  ]);

  let directPlayerRows: { id: string; name: string }[] = [];
  if (playerPayload.length > 0) {
    const { data: players, error: playersError } = await supabase
      .from('at_players')
      .upsert(playerPayload, { onConflict: 'alliance_id,name' })
      .select('id, name');

    if (playersError ?? !players) {
      throw new Error(`Failed to upsert players: ${String(playersError?.message)}`);
    }
    // playerRows doit rester indexé par nom OCR : les lignes canoniques issues
    // des aliasés sont réintroduites par combinePlayerRows sous leur nom OCR.
    const directNames = new Set(directMembers.map((m) => m.name));
    directPlayerRows = (players as { id: string; name: string }[]).filter((p) =>
      directNames.has(p.name),
    );
  }

  const playerRows = combinePlayerRows(directPlayerRows, aliasedMembers, aliasToCanonicalId);

  // 5. Determine which players have no active membership and insert for them
  const newMemberCount = await upsertMemberships(playerRows, allianceId, ocr.event_datetime);

  // 6. Batch UPSERT at_participations (participants only — points !== null)
  const memberByName = new Map(uniqueMembers.map((m) => [m.name, m]));

  const participationRows = playerRows.flatMap((p) => {
    const m = memberByName.get(p.name);
    if (!m) {
      logger.warn({ playerName: p.name }, 'Player from DB has no OCR match, skipping participation');
      return [];
    }
    if (m.points === null) {
      return []; // non-participant (game shows "--"), tracked in at_players but not at_participations
    }
    return [
      {
        event_id: eventId,
        player_id: p.id,
        player_rank: m.rank,
        power: m.power,
        points: m.points,
        ocr_confidence: m.confidence,
        raw_ocr: m as unknown as Record<string, unknown>,
      },
    ];
  });

  const { error: partError } = await supabase
    .from('at_participations')
    .upsert(participationRows, { onConflict: 'event_id,player_id' });

  if (partError) throw new Error(`Participations upsert failed: ${partError.message} [${partError.code}]`);

  // 7. Mark screenshot upload as processed
  await supabase
    .from('at_screenshot_uploads')
    .update({
      processing_status: 'processed',
      extracted_event_id: eventId,
      processed_at: new Date().toISOString(),
    })
    .eq('id', uploadId);

  logger.info(
    { eventId, allianceId, memberCount: playerRows.length, newMemberCount },
    'OCR result upserted',
  );

  return {
    status: 'processed',
    eventId,
    eventTypeDisplayName: et.display_name,
    memberCount: playerRows.length,
    newMemberCount,
  };
}

// Records a failed or unknown_event upload (for OCR errors where we have the file hash).
export async function recordUploadError(params: {
  messageId: string;
  userId: string;
  allianceId: string;
  fileHash: string;
  filePath: string;
  status: 'failed' | 'unknown_event';
  errorMessage: string;
}): Promise<void> {
  const { messageId, userId, allianceId, fileHash, filePath, status, errorMessage } = params;

  if (await findExistingUpload(fileHash, allianceId)) return;

  try {
    await insertUploadRecord({
      messageId,
      userId,
      allianceId,
      filePath,
      fileHash,
      processingStatus: status,
      errorMessage,
      processedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Best-effort : l'enregistrement de l'échec ne doit pas masquer l'erreur
    // d'origine (comportement historique : insert sans vérification).
    logger.warn({ fileHash, err: String(err) }, 'Failed to record upload error');
  }
}

interface DonationUpsertParams {
  messageId: string;
  userId: string;
  allianceId: string;
  fileHash: string;
  filePath: string;
  messageCreatedAt: Date;
  ocr: OcrDonationResult;
}

export async function upsertDonationResult(
  params: DonationUpsertParams,
): Promise<DonationUpsertResult> {
  const { messageId, userId, allianceId, fileHash, filePath, messageCreatedAt, ocr } = params;

  // 1. Dedup check
  if (await findExistingUpload(fileHash, allianceId)) {
    logger.info({ fileHash, allianceId }, 'Duplicate donation upload, skipping');
    return { status: 'duplicate' };
  }

  // 2. V1: only weekly supported
  if (ocr.period_type !== 'weekly') {
    logger.warn({ periodType: ocr.period_type }, 'Unsupported donation period type');
    return { status: 'unsupported_period_type', periodType: ocr.period_type };
  }

  // Insert upload record (pending)
  const inserted = await insertUploadRecord({ messageId, userId, allianceId, filePath, fileHash });
  if (inserted.status === 'duplicate') return { status: 'duplicate' };
  const uploadId = inserted.uploadId;

  // 3. UPSERT at_donation_periods
  const periodStart = isoWeekStartParis(messageCreatedAt);
  const { data: periodRow, error: periodError } = await supabase
    .from('at_donation_periods')
    .upsert(
      { alliance_id: allianceId, period_type: 'weekly', period_start: periodStart },
      { onConflict: 'alliance_id,period_type,period_start' },
    )
    .select('id')
    .single();

  if (periodError ?? !periodRow) {
    throw new Error(`Failed to upsert donation period: ${String(periodError?.message)}`);
  }

  const periodId = (periodRow as { id: string }).id;

  // 4. Deduplicate members by name (keep highest confidence) and resolve aliases
  const { uniqueMembers, directMembers, aliasedMembers, aliasToCanonicalId, canonicalNameById } =
    await resolveAndDedup(ocr.members, allianceId, 'donation OCR result');

  // 5. Un seul upsert batch (directs + aliasés via leur nom canonique) —
  // donations only refresh last_rank, not last_seen_at/last_power.
  const playerPayload = dedupeByName([
    ...directMembers.map((m) => ({
      row: { alliance_id: allianceId, name: m.name, last_rank: m.rank },
      confidence: m.confidence,
    })),
    ...aliasedMembers.flatMap((m) => {
      const canonicalName = canonicalNameById.get(aliasToCanonicalId.get(m.name)!);
      if (!canonicalName) return [];
      return [
        {
          row: { alliance_id: allianceId, name: canonicalName, last_rank: m.rank },
          confidence: m.confidence,
        },
      ];
    }),
  ]);

  let directPlayerRows: { id: string; name: string }[] = [];
  if (playerPayload.length > 0) {
    const { data: players, error: playersError } = await supabase
      .from('at_players')
      .upsert(playerPayload, { onConflict: 'alliance_id,name' })
      .select('id, name');

    if (playersError ?? !players) {
      throw new Error(`Failed to upsert players: ${String(playersError?.message)}`);
    }
    const directNames = new Set(directMembers.map((m) => m.name));
    directPlayerRows = (players as { id: string; name: string }[]).filter((p) =>
      directNames.has(p.name),
    );
  }

  const playerRows = combinePlayerRows(directPlayerRows, aliasedMembers, aliasToCanonicalId);

  // 6. Upsert memberships for new players (joined_at = messageCreatedAt)
  const newMemberCount = await upsertMemberships(
    playerRows,
    allianceId,
    messageCreatedAt.toISOString(),
  );

  // 7. UPSERT at_donations — latest-wins on re-upload
  const memberByName = new Map(uniqueMembers.map((m) => [m.name, m]));

  const donationRows = playerRows.map((p) => {
    const m = memberByName.get(p.name)!;
    return {
      donation_period_id: periodId,
      player_id: p.id,
      alliance_honor: m.alliance_honor,
      player_rank: m.rank,
      alliance_tag: m.alliance_tag,
      ocr_confidence: m.confidence,
      raw_ocr: m as unknown as Record<string, unknown>,
      source_message_id: messageId,
      source_upload_id: uploadId,
      updated_at: new Date().toISOString(),
    };
  });

  const { error: donationError } = await supabase
    .from('at_donations')
    .upsert(donationRows, { onConflict: 'donation_period_id,player_id' });

  if (donationError) throw new Error(`Donations upsert failed: ${donationError.message}`);

  // 8. Mark upload processed
  await supabase
    .from('at_screenshot_uploads')
    .update({ processing_status: 'processed', processed_at: new Date().toISOString() })
    .eq('id', uploadId);

  logger.info(
    { periodId, allianceId, memberCount: playerRows.length, newMemberCount },
    'Donation OCR result upserted',
  );

  return {
    status: 'processed',
    periodId,
    periodStart,
    memberCount: playerRows.length,
    newMemberCount,
  };
}

// ── Player stats (military stats chat) ───────────────────────────────────────

export type ProcessedPlayerStatsUpsertResult = {
  status: 'processed';
  recordedDate: string;        // "YYYY-MM-DD"
  memberCount: number;
  skippedCount: number;        // members not found in at_players (new players forbidden)
  lowConfidenceCount: number;  // members with confidence < 0.67 (< 2 stats parsed)
  rejectedRawTexts: string[];  // raw_lines of skipped members for Discord logging
};

export type PlayerStatsUpsertResult =
  | ProcessedPlayerStatsUpsertResult
  | { status: 'duplicate' }
  | { status: 'no_members' };

interface PlayerStatsUpsertParams {
  messageId: string;
  userId: string;
  allianceId: string;
  fileHash: string;
  filePath: string;
  messageCreatedAt: Date;
  ocr: OcrPlayerStatsResult;
}

export async function upsertPlayerStatsResult(
  params: PlayerStatsUpsertParams,
): Promise<PlayerStatsUpsertResult> {
  const { messageId, userId, allianceId, fileHash, filePath, messageCreatedAt, ocr } = params;

  // 1. Dedup check: (file_hash, alliance_id) unique constraint
  if (await findExistingUpload(fileHash, allianceId)) {
    logger.info({ fileHash, allianceId }, 'Duplicate player stats upload, skipping');
    return { status: 'duplicate' };
  }

  if (ocr.members.length === 0) {
    logger.warn({ messageId }, 'Player stats OCR returned no members');
    return { status: 'no_members' };
  }

  // Insert upload record (pending)
  const inserted = await insertUploadRecord({ messageId, userId, allianceId, filePath, fileHash });
  if (inserted.status === 'duplicate') return { status: 'duplicate' };
  const uploadId = inserted.uploadId;

  // recorded_date = UTC date of the Discord message
  const recordedDate = messageCreatedAt.toISOString().slice(0, 10); // "YYYY-MM-DD"

  // 2. Discard unnamed entries, then deduplicate by name (keep highest confidence) and resolve aliases
  const namedMembers = ocr.members.filter((m) => m.name.trim().length > 0);
  const { uniqueMembers, directMembers, aliasedMembers, aliasToCanonicalId } =
    await resolveAndDedup(namedMembers, allianceId, 'player stats OCR');

  // 3. Look up direct (non-aliased) members — military stats never create new players.
  //    Members not found in at_players are rejected and their raw_lines logged to Discord.
  const memberByOcrName = new Map(uniqueMembers.map((m) => [m.name, m]));
  let directPlayerRows: { id: string; name: string }[] = [];
  const skippedMembers: OcrPlayerStatsMember[] = [];

  if (directMembers.length > 0) {
    const { data: players, error: playersError } = await supabase
      .from('at_players')
      .select('id, name')
      .eq('alliance_id', allianceId)
      .in('name', directMembers.map((m) => m.name));

    if (playersError) throw new Error(`Failed to look up players: ${playersError.message}`);

    const foundNames = new Set(((players ?? []) as { id: string; name: string }[]).map((p) => p.name));
    directPlayerRows = (players ?? []) as { id: string; name: string }[];

    for (const m of directMembers) {
      if (!foundNames.has(m.name)) {
        skippedMembers.push(m);
        logger.warn(
          { allianceId, name: m.name },
          'Player stats: unknown player skipped (new player creation forbidden for military stats)',
        );
      }
    }
  }

  const playerRows = combinePlayerRows(directPlayerRows, aliasedMembers, aliasToCanonicalId);

  // 4. UPSERT at_player_stats — latest-wins on (alliance_id, player_id, recorded_date)
  // Stats captures do not create players or memberships — intentional: only known players
  // get stats recorded, and membership lifecycle is driven by event/donation captures.
  const statsRows = playerRows.map((p) => {
    const m = memberByOcrName.get(p.name)!;
    return {
      alliance_id: allianceId,
      player_id: p.id,
      attack_pct: m.attack_pct,
      attack_kind: m.attack_kind,
      hp_pct: m.hp_pct,
      defense_pct: m.defense_pct,
      ocr_confidence: m.confidence,
      raw_text: m.raw_lines,
      source_upload_id: uploadId,
      recorded_date: recordedDate,
      updated_at: new Date().toISOString(),
    };
  });

  const { error: statsError } = await supabase
    .from('at_player_stats')
    .upsert(statsRows, { onConflict: 'alliance_id,player_id,recorded_date' });

  if (statsError) throw new Error(`Player stats upsert failed: ${statsError.message}`);

  // 5. Mark upload processed
  await supabase
    .from('at_screenshot_uploads')
    .update({ processing_status: 'processed', processed_at: new Date().toISOString() })
    .eq('id', uploadId);

  const lowConfidenceCount = uniqueMembers.filter((m) => m.confidence < 2 / 3).length;
  const rejectedRawTexts = skippedMembers
    .map((m) => m.raw_lines)
    .filter((t) => t.trim().length > 0);

  logger.info(
    {
      allianceId,
      recordedDate,
      memberCount: playerRows.length,
      skippedCount: skippedMembers.length,
      lowConfidenceCount,
    },
    'Player stats OCR result upserted',
  );

  return {
    status: 'processed',
    recordedDate,
    memberCount: playerRows.length,
    skippedCount: skippedMembers.length,
    lowConfidenceCount,
    rejectedRawTexts,
  };
}
