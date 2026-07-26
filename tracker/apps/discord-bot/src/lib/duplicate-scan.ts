// Détection (jamais fusion automatique) de doublons de joueurs probables dans
// un contexte déjà en base (un événement ou une période de dons) — par
// opposition à name-resolve.ts, qui ne compare qu'un NOUVEAU nom OCR contre le
// roster existant, une seule fois, pour décider s'il faut créer une ligne
// at_players ou en réutiliser une. Les quatre doublons réels confirmés lors
// des audits du 2026-07-26 sont tous apparus ENTRE deux captures déjà
// upsertées (deux événements/périodes distincts), pas à l'intérieur d'une
// seule capture — ce module comble exactement ce trou, en lecture seule.
//
// Rien ici n'écrit jamais en base : voir commands/find-duplicates.ts, qui
// affiche les candidats et laisse un humain lancer /merge après vérification
// de la capture source.

import { normalizeOcrName, levenshtein } from './name-resolve.js';

// ── Clé de comparaison : pliage des homoglyphes ─────────────────────────────
//
// Un Levenshtein brut sur normalizeOcrName() échoue sur 3 des 4 doublons réels
// confirmés : ce sont des confusions Cyrillique/Latin (le pipeline OCR fait
// tourner à la fois une passe ASCII rapide et une passe multilingue complète —
// voir OCR_NAME_ASCII_FAST_PATH_ENABLED — qui peuvent lire le même glyphe
// physique comme deux points de code Unicode différents d'une capture à
// l'autre). Aucun seuil de distance sur les points de code bruts ne peut
// attraper ça ; un pliage des homoglyphes est indispensable.
//
// Table dérivée de AMBIGUOUS_CYRILLIC (ocr-service/app/parsers/name_ocr.py) :
// exactement les lettres cyrilliques dont le glyphe est identique à une
// latine à la résolution des captures. En minuscules car normalizeOcrName a
// déjà mis en minuscules.
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
 * NFD + suppression des marques combinantes (diacritiques) puis pliage des
 * homoglyphes cyrilliques ci-dessus. `Mjölnir` ≡ `Mjolnir`, `LEÓN` ≡ `LEON` —
 * deux dégradations OCR déjà observées en production — et `Аня` se rapproche
 * de `aha` plutôt que de rester à distance maximale de `AHA`.
 */
export function foldConfusables(key: string): string {
  const stripped = key.normalize('NFD').replace(/\p{Mn}/gu, '');
  return [...stripped].map((ch) => CONFUSABLE_FOLD[ch] ?? ch).join('');
}

/** normalizeOcrName (name-resolve.ts) puis foldConfusables — la clé utilisée
 * partout dans ce module. Ne remplace PAS normalizeOcrName : ce module a un
 * usage différent (comparer deux joueurs DÉJÀ existants, avec un seuil plus
 * large, jamais pour fusionner automatiquement) — voir le commentaire d'en-tête. */
export function duplicateKey(raw: string): string {
  return foldConfusables(normalizeOcrName(raw));
}

// ── Comparaison de deux noms ─────────────────────────────────────────────────

export const SIM_STRONG = 0.8;
export const SIM_WEAK = 0.6;
// Même raison que MIN_KEY_LENGTH_FOR_FUZZY dans name-resolve.ts : sous cette
// longueur, une distance de 1 est trop souvent un hasard (JANI/DANI) pour
// être un signal fiable au ratio — mais elle reste worth surfacing (tier
// 'weak'), car c'est exactement le cas Аня/AHA.
export const MIN_KEY_LEN_FOR_RATIO = 5;
export const SHORT_KEY_MAX_DISTANCE = 1;
// Longueur minimale de l'écart pour qu'un « nom contenu dans l'autre » soit
// traité comme une décoration (deux vrais joueurs), pas une variante OCR.
export const CONTAINMENT_MIN_LEN_DIFF = 2;

export type NameProximity = 'exact-key' | 'strong' | 'weak' | 'none';

export type NameComparison = {
  keyA: string;
  keyB: string;
  distance: number;
  similarity: number;
  containment: boolean;
  proximity: NameProximity;
  /** Libellé FR affiché au relecteur humain — explique POURQUOI la paire est
   * remontée, pas juste le score brut. */
  reason: string;
};

/**
 * Compare deux noms OCR pour un usage de SURFACE uniquement (jamais de
 * fusion automatique — voir findFuzzyMatch dans name-resolve.ts pour ce
 * cas-là, volontairement plus strict).
 *
 * Une paire "contenue" (le plus court est une sous-chaîne contiguë du plus
 * long, avec un écart de longueur suffisant) est délibérément DÉGRADÉE même à
 * similarité élevée : un nom décoré (`m| jasmin|o`) normalise vers le nom de
 * base PLUS des caractères aux extrémités, alors qu'un vrai misread OCR
 * substitue des caractères en place. C'est la règle qui sauve le faux positif
 * le plus dangereux confirmé (jasmin / m| jasmin|o, honor 530 identique,
 * deux joueurs bien réels) — voir duplicate-scan.test.ts pour la table de
 * validation complète contre les 4 vrais doublons + les faux positifs
 * confirmés des audits du 2026-07-26.
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
      reason: 'même clé normalisée (accents/casse/homoglyphes mis à part)',
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
          ? 'noms courts, distance 1 (signal faible mais réel — voir Аня/AHA)'
          : 'noms courts, aucune ressemblance',
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
          ? "un nom contient l'autre — souvent deux vrais joueurs aux pseudos décorés"
          : 'un nom contient l’autre, mais trop peu de ressemblance par ailleurs',
    };
  }

  if (similarity >= SIM_STRONG) {
    return { keyA, keyB, distance, similarity, containment, proximity: 'strong', reason: 'noms très proches' };
  }
  if (similarity >= SIM_WEAK) {
    return { keyA, keyB, distance, similarity, containment, proximity: 'weak', reason: 'noms assez proches' };
  }
  return { keyA, keyB, distance, similarity, containment, proximity: 'none', reason: 'noms sans rapport' };
}

// ── Regroupement par contexte (événement ou période de dons) ───────────────

export type ScanEntry = {
  playerId: string;
  playerName: string;
  value: number; // points (événement) ou alliance_honor (dons)
  confidence: number | null;
};

export type ScanContext = {
  kind: 'event' | 'donation_period';
  id: string;
  label: string; // ex. "Elite Wars — 2026-04-06 13:30" | "Semaine du 2026-05-04"
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
  /** Nombre d'autres contextes où cette même paire de joueurs apparaît
   * également — rempli par rankCandidates, pas par classifyPair. */
  alsoInContexts: number;
};

// Garde-fou : le plus grand contexte observé aujourd'hui compte ~106 membres
// (donation period), ce qui donne <=6k paires — trivial. 500 est de la marge,
// pas une vraie limite ; au-delà, on saute le contexte plutôt que de risquer
// de bloquer le budget de 3s de Discord sur un cas pathologique.
export const MAX_ENTRIES_PER_CONTEXT = 500;

function tierFor(proximity: NameProximity, sameValue: boolean): DuplicateTier | null {
  const strong = proximity === 'exact-key' || proximity === 'strong';
  const weak = proximity === 'weak';
  if (strong) return sameValue ? 'high' : 'medium';
  if (weak) return sameValue ? 'medium' : null;
  // proximity === 'none'
  return sameValue ? 'low' : null;
}

/** null = paire non pertinente (même joueur, ou ni valeur identique ni nom proche). */
export function classifyPair(a: ScanEntry, b: ScanEntry, context: ScanContext): DuplicateCandidate | null {
  if (a.playerId === b.playerId) return null;

  const sameValue = a.value === b.value;
  const name = compareNames(a.playerName, b.playerName);
  const tier = tierFor(name.proximity, sameValue);
  if (tier === null) return null;

  return { context, a, b, sameValue, name, tier, alsoInContexts: 0 };
}

/**
 * Toutes les paires pertinentes au sein d'un même contexte (O(n²), voir
 * MAX_ENTRIES_PER_CONTEXT). Les entrées au-delà de la limite sont ignorées
 * (avec un log côté appelant), pas silencieusement tronquées sans signal.
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
 * Trie par tier puis par similarité de nom décroissante, puis dédoublonne la
 * MÊME paire de joueurs apparue dans plusieurs contextes (garde l'occurrence
 * au tier le plus élevé, incrémente alsoInContexts) — sans ça, un vrai
 * doublon qui traîne sur plusieurs événements inonderait le rapport de la
 * même paire répétée.
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
