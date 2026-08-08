// Detection (never automatic merging) of likely duplicate players within a
// context that's already in the database (an event or a donation period) —
// as opposed to name-resolve.ts, which only compares a NEW OCR name against
// the existing roster, once, to decide whether to create an at_players row
// or reuse one. The four real duplicates confirmed during the 2026-07-26
// audits all showed up BETWEEN two already-upserted screenshots (two
// distinct events/periods), not within a single screenshot — this module
// fills exactly that gap, read-only.
//
// Nothing here ever writes to the database: see commands/find-duplicates.ts,
// which displays the candidates and lets a human trigger /merge after
// checking the source screenshot.

import { normalizeOcrName, levenshtein, type RosterPlayer } from './name-resolve.js';

// ── Comparison key: homoglyph folding ───────────────────────────────────────
//
// A raw Levenshtein on normalizeOcrName() fails on 3 of the 4 confirmed real
// duplicates: these are Cyrillic/Latin confusions (the OCR pipeline runs both
// a fast ASCII pass and a full multilingual pass — see
// OCR_NAME_ASCII_FAST_PATH_ENABLED — which can read the same physical glyph
// as two different Unicode code points from one screenshot to the next). No
// distance threshold on the raw code points can catch that; homoglyph folding
// is required.
//
// Table derived from AMBIGUOUS_CYRILLIC (ocr-service/app/parsers/name_ocr.py):
// exactly the Cyrillic letters whose glyph is identical to a Latin one at
// screenshot resolution. Lowercase, since normalizeOcrName has already
// lowercased.
const CONFUSABLE_FOLD: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  х: 'x',
  у: 'y',
};

/**
 * NFD + stripping combining marks (diacritics), then folding the Cyrillic
 * homoglyphs above. `Mjölnir` ≡ `Mjolnir`, `LEÓN` ≡ `LEON` — two OCR
 * degradations already observed in production — and `Аня` ends up close to
 * `aha` instead of staying at maximum distance from `AHA`.
 */
export function foldConfusables(key: string): string {
  const stripped = key.normalize('NFD').replace(/\p{Mn}/gu, '');
  return [...stripped].map((ch) => CONFUSABLE_FOLD[ch] ?? ch).join('');
}

/** normalizeOcrName (name-resolve.ts) then foldConfusables — the key used
 * everywhere in this module. Does NOT replace normalizeOcrName: this module
 * has a different use case (comparing two ALREADY existing players, with a
 * wider threshold, never to auto-merge) — see the header comment. */
export function duplicateKey(raw: string): string {
  return foldConfusables(normalizeOcrName(raw));
}

// ── Comparing two names ──────────────────────────────────────────────────────

export const SIM_STRONG = 0.8;
export const SIM_WEAK = 0.6;
// Same reason as MIN_KEY_LENGTH_FOR_FUZZY in name-resolve.ts: below this
// length, a distance of 1 is too often a coincidence (JANI/DANI) to be a
// reliable ratio signal — but it's still worth surfacing (tier 'weak'),
// since that's exactly the Аня/AHA case.
export const MIN_KEY_LEN_FOR_RATIO = 5;
export const SHORT_KEY_MAX_DISTANCE = 1;
// Minimum length of the gap for a "name contained in the other" to be
// treated as decoration (two real players), not an OCR variant.
export const CONTAINMENT_MIN_LEN_DIFF = 2;

export type NameProximity = 'exact-key' | 'strong' | 'weak' | 'none';

export type NameComparison = {
  keyA: string;
  keyB: string;
  distance: number;
  similarity: number;
  containment: boolean;
  proximity: NameProximity;
  /** Label shown to the human reviewer — explains WHY the pair surfaced,
   * not just the raw score. */
  reason: string;
};

/**
 * Compares two OCR names for SURFACING purposes only (never automatic
 * merging — see findFuzzyMatch in name-resolve.ts for that case, which is
 * deliberately stricter).
 *
 * A "contained" pair (the shorter one is a contiguous substring of the
 * longer one, with a sufficient length gap) is deliberately DOWNGRADED even
 * at high similarity: a decorated name (`m| jasmin|o`) normalizes to the
 * base name PLUS characters at the ends, whereas a real OCR misread
 * substitutes characters in place. This is the rule that saves the most
 * dangerous confirmed false positive (jasmin / m| jasmin|o, identical honor
 * 530, two very real players) — see duplicate-scan.test.ts for the full
 * validation table against the 4 real duplicates plus the confirmed false
 * positives from the 2026-07-26 audits.
 */
export function compareNames(rawA: string, rawB: string): NameComparison {
  const keyA = duplicateKey(rawA);
  const keyB = duplicateKey(rawB);
  const distance = levenshtein(keyA, keyB);
  const maxLen = Math.max(keyA.length, keyB.length) || 1;
  const similarity = 1 - distance / maxLen;

  const [shorter, longer] = keyA.length <= keyB.length ? [keyA, keyB] : [keyB, keyA];
  const lenDiff = longer.length - shorter.length;
  const containment =
    shorter.length > 0 && lenDiff >= CONTAINMENT_MIN_LEN_DIFF && longer.includes(shorter);

  if (keyA === keyB) {
    return {
      keyA,
      keyB,
      distance,
      similarity,
      containment: false,
      proximity: 'exact-key',
      reason: 'same normalized key (aside from accents/case/homoglyphs)',
    };
  }

  const minLen = Math.min(keyA.length, keyB.length);
  if (minLen < MIN_KEY_LEN_FOR_RATIO) {
    const proximity: NameProximity = distance <= SHORT_KEY_MAX_DISTANCE ? 'weak' : 'none';
    return {
      keyA,
      keyB,
      distance,
      similarity,
      containment,
      proximity,
      reason:
        proximity === 'weak'
          ? 'short names, distance 1 (weak but real signal — see Аня/AHA)'
          : 'short names, no resemblance',
    };
  }

  if (containment) {
    const proximity: NameProximity = similarity >= SIM_WEAK ? 'weak' : 'none';
    return {
      keyA,
      keyB,
      distance,
      similarity,
      containment,
      proximity,
      reason:
        proximity === 'weak'
          ? 'one name contains the other — often two real players with decorated handles'
          : 'one name contains the other, but too little resemblance otherwise',
    };
  }

  if (similarity >= SIM_STRONG) {
    return { keyA, keyB, distance, similarity, containment, proximity: 'strong', reason: 'very close names' };
  }
  if (similarity >= SIM_WEAK) {
    return { keyA, keyB, distance, similarity, containment, proximity: 'weak', reason: 'fairly close names' };
  }
  return { keyA, keyB, distance, similarity, containment, proximity: 'none', reason: 'unrelated names' };
}

// ── Collisions against the roster at credit time ─────────────────────────────
//
// Conceptually a name-resolve.ts concern (a NEW OCR name vs the roster), but it
// needs compareNames' homoglyph fold, and name-resolve.ts is imported *by* this
// module — so it lives here, next to compareNames, to avoid the import cycle.
//
// Proximities that make a credit ambiguous. Same set upsert.ts already treats
// as a near-duplicate (exact-key catches homoglyph/accent twins LEÓN≡LEON,
// Satana≡Sa†ana; weak catches short-name distance-1 pairs VV/VVV, jc0n/jcOn).
export const COLLISION_PROXIMITIES: ReadonlySet<NameProximity> = new Set([
  'exact-key',
  'strong',
  'weak',
]);

export type RosterCollision = { player: RosterPlayer; comparison: NameComparison };

/**
 * Roster players — other than the one we are about to credit (`creditedId`) —
 * whose name closely resembles `rawName`.
 *
 * A non-empty result means crediting `rawName` is a silent-misattribution risk:
 * the screenshot could have been one of these other players, misread into the
 * credited name. This is the case an exact string match hides — `LEON` matches
 * the `LEON` row exactly, so nothing looks wrong, yet a `LEÓN` player sits one
 * accent away. Detection only; the caller decides what to do (today: warn, and
 * still credit the exact/fuzzy match — never drops or reroutes data here).
 *
 * Deliberately reuses compareNames' full signal (incl. the short-name `weak`
 * tier): unlike findFuzzyMatch, which suppresses short names to avoid *merging*
 * JANI/DANI, surfacing a short-name collision for human review is exactly the
 * point (`VV`/`VVV` is a real example). The cost is expected warnings on rosters
 * that genuinely contain a near-identical pair.
 */
export function findRosterCollisions(
  rawName: string,
  creditedId: string,
  roster: RosterPlayer[],
): RosterCollision[] {
  const collisions: RosterCollision[] = [];
  for (const player of roster) {
    if (player.id === creditedId) continue;
    const comparison = compareNames(rawName, player.name);
    if (COLLISION_PROXIMITIES.has(comparison.proximity)) {
      collisions.push({ player, comparison });
    }
  }
  return collisions;
}

// ── Grouping by context (event or donation period) ──────────────────────────

export type ScanEntry = {
  playerId: string;
  playerName: string;
  value: number; // points (event) or alliance_honor (donations)
  confidence: number | null;
};

export type ScanContext = {
  kind: 'event' | 'donation_period';
  id: string;
  label: string; // e.g. "Elite Wars — 2026-04-06 13:30" | "Week of 2026-05-04"
  valueLabel: 'points' | 'honor';
};

export type DuplicateTier = 'high' | 'medium' | 'low';

export type DuplicateCandidate = {
  context: ScanContext;
  a: ScanEntry;
  b: ScanEntry;
  sameValue: boolean;
  name: NameComparison;
  tier: DuplicateTier;
  /** Number of other contexts where this same pair of players also appears —
   * filled in by rankCandidates, not by classifyPair. */
  alsoInContexts: number;
};

// Safety valve: the largest context observed today has ~106 members
// (donation period), giving <=6k pairs — trivial. 500 is headroom, not a
// real limit; beyond that, skip the context rather than risk blowing
// Discord's 3s budget on a pathological case.
export const MAX_ENTRIES_PER_CONTEXT = 500;

function tierFor(proximity: NameProximity, sameValue: boolean): DuplicateTier | null {
  const strong = proximity === 'exact-key' || proximity === 'strong';
  const weak = proximity === 'weak';
  if (strong) return sameValue ? 'high' : 'medium';
  if (weak) return sameValue ? 'medium' : null;
  // proximity === 'none'
  return sameValue ? 'low' : null;
}

/** null = irrelevant pair (same player, or neither identical value nor close name). */
export function classifyPair(a: ScanEntry, b: ScanEntry, context: ScanContext): DuplicateCandidate | null {
  if (a.playerId === b.playerId) return null;

  const sameValue = a.value === b.value;
  const name = compareNames(a.playerName, b.playerName);
  const tier = tierFor(name.proximity, sameValue);
  if (tier === null) return null;

  return { context, a, b, sameValue, name, tier, alsoInContexts: 0 };
}

/**
 * All relevant pairs within a single context (O(n²), see
 * MAX_ENTRIES_PER_CONTEXT). Entries beyond the limit are skipped (with a log
 * on the caller side), not silently truncated without any signal.
 */
export function scanContext(entries: ScanEntry[], context: ScanContext): DuplicateCandidate[] {
  if (entries.length > MAX_ENTRIES_PER_CONTEXT) return [];

  const candidates: DuplicateCandidate[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const candidate = classifyPair(entries[i]!, entries[j]!, context);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

const TIER_ORDER: Record<DuplicateTier, number> = { high: 0, medium: 1, low: 2 };

/**
 * Sorts by tier then by decreasing name similarity, then deduplicates the
 * SAME pair of players appearing across multiple contexts (keeps the
 * occurrence at the highest tier, increments alsoInContexts) — without this,
 * a real duplicate lingering across several events would flood the report
 * with the same pair repeated.
 */
export function rankCandidates(candidates: DuplicateCandidate[]): DuplicateCandidate[] {
  const byPair = new Map<string, DuplicateCandidate>();
  const contextsSeen = new Map<string, Set<string>>();

  for (const c of candidates) {
    const pairKey = [c.a.playerId, c.b.playerId].sort().join('|');
    const contexts = contextsSeen.get(pairKey) ?? new Set<string>();
    contexts.add(c.context.id);
    contextsSeen.set(pairKey, contexts);

    const existing = byPair.get(pairKey);
    if (
      !existing ||
      TIER_ORDER[c.tier] < TIER_ORDER[existing.tier] ||
      (TIER_ORDER[c.tier] === TIER_ORDER[existing.tier] && c.name.similarity > existing.name.similarity)
    ) {
      byPair.set(pairKey, c);
    }
  }

  const deduped = [...byPair.entries()].map(([pairKey, c]) => ({
    ...c,
    alsoInContexts: (contextsSeen.get(pairKey)?.size ?? 1) - 1,
  }));

  return deduped.sort((x, y) => {
    const tierDiff = TIER_ORDER[x.tier] - TIER_ORDER[y.tier];
    if (tierDiff !== 0) return tierDiff;
    const simDiff = y.name.similarity - x.name.similarity;
    if (simDiff !== 0) return simDiff;
    return x.context.label.localeCompare(y.context.label);
  });
}
