// Résolution floue des variantes de nom OCR vers un joueur canonique existant.
//
// Le pipeline OCR ne garantit pas une lecture stable du nom d'un joueur d'une
// capture à l'autre (glyphe parasite, correction LLM non déterministe, etc.).
// Sans réconciliation, chaque variante devient un nouveau `at_players` — vu en
// prod : un même joueur scindé en 3 lignes (`6ig§teelCurtain`/`Big§teelCurtain`/
// `Rig§teelCurtain`). Ce module ne fait qu'une chose : décider, à partir du
// roster déjà connu d'une alliance, si un nom OCR est probablement une variante
// d'un joueur existant — sans jamais fusionner à l'aveugle (voir `resolve`).

/**
 * Clé de comparaison : NFKC + minuscules + tout ce qui n'est ni lettre ni
 * chiffre (Unicode) supprimé. Conserve les caractères CJC/cyrilliques/etc.,
 * supprime les séparateurs et le bruit OCR (`§ _ - . espace ( ) | > ?`).
 *
 * `焼鳥_Yakitori` et `焼鳥-Yakitori` → même clé ; `6ig§teelCurtain` →
 * `6igsteelcurtain` (distance 1 de `bigsteelcurtain`).
 */
export function normalizeOcrName(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Distance de Levenshtein classique (programmation dynamique, une ligne). */
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

// Sous cette longueur (clé normalisée), on n'essaie pas le fuzzy-match : deux
// noms courts distincts (ex. JANI/DANI) sont trop souvent à distance 1 pour
// que ce soit un signal fiable.
const MIN_KEY_LENGTH_FOR_FUZZY = 5;

export type RosterPlayer = { id: string; name: string };

export type FuzzyMatchResult =
  | { kind: 'match'; player: RosterPlayer }
  | { kind: 'ambiguous'; candidates: RosterPlayer[] }
  | { kind: 'none' };

/**
 * Cherche, dans le roster d'une alliance, un joueur dont le nom est
 * probablement une variante OCR de `rawName`. Ne redirige jamais à l'aveugle :
 * seul un candidat unique est un `match` ; ≥2 candidats est `ambiguous`
 * (laisser créer un nouveau joueur plutôt que deviner).
 */
export function findFuzzyMatch(rawName: string, roster: RosterPlayer[]): FuzzyMatchResult {
  const key = normalizeOcrName(rawName);
  if (key.length < MIN_KEY_LENGTH_FOR_FUZZY) return { kind: 'none' };

  const candidates: RosterPlayer[] = [];
  const seenIds = new Set<string>();
  for (const player of roster) {
    if (player.name === rawName) continue; // match exact déjà géré ailleurs
    const otherKey = normalizeOcrName(player.name);
    if (otherKey.length < MIN_KEY_LENGTH_FOR_FUZZY) continue;

    // key.length et otherKey.length sont déjà tous les deux >= MIN_KEY_LENGTH_FOR_FUZZY ici.
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
