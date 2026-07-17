// ── Event domain (existing) ──────────────────────────────────────────────────

export type OcrMember = {
  name: string;
  rank: string;
  power: number;
  points: number | null; // null = non-participant (game shows "--"); 0 = participated, scored 0
  confidence: number;
};

export type OcrEventResult = {
  kind: 'event';
  event_type: string;
  event_datetime: string | null; // null = date/heure illisible sur la capture

  alliance_rank: number;
  total_battlers: number;
  total_points: number;
  members: OcrMember[];
};

// ── Donation domain (Alliance Honor / Contribution Ranking) ──────────────────

export type OcrDonationMember = {
  name: string;
  alliance_tag: string | null; // e.g. "SOD" stripped from "(SOD) jeinsolaya"
  rank: string;                // R1..R5 or "" for the highlighted viewer row
  alliance_honor: number;
  confidence: number;
  // On-screen leaderboard position (1-81), best-effort OCR. Informational
  // only — NOT an identity/dedup key (see ocr-service's DonationMember
  // docstring: digit misreads here can be confidently wrong). null/absent
  // when the OCR vote didn't reach a strong majority (the wire payload
  // always sends it, but optional here so existing object literals/fixtures
  // don't need updating for a purely informational addition).
  leaderboard_position?: number | null;
};

export type OcrDonationResult = {
  kind: 'donation';
  period_type: 'weekly' | 'daily' | 'history';
  members: OcrDonationMember[];
};

// ── Player stats chat domain ─────────────────────────────────────────────────

export type OcrPlayerStatsMember = {
  name: string;
  attack_pct: number | null;
  attack_kind: 'lra' | 'mra';
  hp_pct: number | null;
  defense_pct: number | null;
  confidence: number; // parsed_stat_count / 3
  raw_lines: string;  // raw OCR lines attributed to this player
};

export type OcrPlayerStatsResult = {
  kind: 'player_stats';
  members: OcrPlayerStatsMember[];
};

// ── Discriminated union ──────────────────────────────────────────────────────

export type OcrResult = OcrEventResult | OcrDonationResult | OcrPlayerStatsResult;

export type OcrError = {
  error: string;
  detail?: string;
};

export type OcrResponse = OcrResult | OcrError;

export function isOcrError(r: OcrResponse): r is OcrError {
  return 'error' in r;
}

export function isDonationResult(r: OcrResult): r is OcrDonationResult {
  return r.kind === 'donation';
}

export function isEventResult(r: OcrResult): r is OcrEventResult {
  return r.kind === 'event';
}

export function isPlayerStatsResult(r: OcrResult): r is OcrPlayerStatsResult {
  return r.kind === 'player_stats';
}
