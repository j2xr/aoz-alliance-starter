// Fuzzy resolution of OCR name variants to an existing canonical player.
//
// The OCR pipeline doesn't guarantee a stable reading of a player's name
// from one screenshot to the next (stray glyph, non-deterministic LLM
// correction, etc.). Without reconciliation, every variant becomes a new
// `at_players` row — seen in prod: a single player split across 3 rows
// (`6ig§teelCurtain`/`Big§teelCurtain`/`Rig§teelCurtain`). This module does
// exactly one thing: decide, from an alliance's already-known roster,
// whether an OCR name is likely a variant of an existing player — without
// ever blindly merging (see `resolve`).

/**
 * Comparison key: NFKC + lowercase + anything that isn't a letter or digit
 * (Unicode) stripped. Keeps CJK/Cyrillic/etc. characters, strips separators
 * and OCR noise (`§ _ - . space ( ) | > ?`).
 *
 * `焼鳥_Yakitori` and `焼鳥-Yakitori` → same key; `6ig§teelCurtain` →
 * `6igsteelcurtain` (distance 1 from `bigsteelcurtain`).
 */
export function normalizeOcrName(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Classic Levenshtein distance (dynamic programming, one row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]!
          : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

// Below this length (normalized key), we don't attempt fuzzy matching: two
// distinct short names (e.g. JANI/DANI) are too often at distance 1 for
// that to be a reliable signal.
const MIN_KEY_LENGTH_FOR_FUZZY = 5;

export type RosterPlayer = { id: string; name: string };

export type FuzzyMatchResult =
  | { kind: 'match'; player: RosterPlayer }
  | { kind: 'ambiguous'; candidates: RosterPlayer[] }
  | { kind: 'none' };

/**
 * Looks, within an alliance's roster, for a player whose name is likely an
 * OCR variant of `rawName`. Never redirects blindly: only a single
 * candidate is a `match`; ≥2 candidates is `ambiguous` (let a new player be
 * created rather than guess).
 */
export function findFuzzyMatch(rawName: string, roster: RosterPlayer[]): FuzzyMatchResult {
  const key = normalizeOcrName(rawName);
  if (key.length < MIN_KEY_LENGTH_FOR_FUZZY) return { kind: 'none' };

  const candidates: RosterPlayer[] = [];
  const seenIds = new Set<string>();
  for (const player of roster) {
    if (player.name === rawName) continue; // exact match already handled elsewhere
    const otherKey = normalizeOcrName(player.name);
    if (otherKey.length < MIN_KEY_LENGTH_FOR_FUZZY) continue;

    // key.length and otherKey.length are both already >= MIN_KEY_LENGTH_FOR_FUZZY here.
    const isMatch = otherKey === key || levenshtein(key, otherKey) <= 1;
    if (isMatch && !seenIds.has(player.id)) {
      seenIds.add(player.id);
      candidates.push(player);
    }
  }

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'match', player: candidates[0]! };
  return { kind: 'ambiguous', candidates };
}
