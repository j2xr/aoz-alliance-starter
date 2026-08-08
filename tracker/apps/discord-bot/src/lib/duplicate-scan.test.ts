import { describe, it, expect } from 'vitest';
import { findFuzzyMatch } from './name-resolve.js';
import {
  compareNames,
  classifyPair,
  scanContext,
  rankCandidates,
  foldConfusables,
  duplicateKey,
  findRosterCollisions,
  MAX_ENTRIES_PER_CONTEXT,
  type ScanEntry,
  type ScanContext,
  type DuplicateTier,
  type NameProximity,
} from './duplicate-scan.js';
import type { RosterPlayer } from './name-resolve.js';

// ── Validation table: the 4 confirmed real duplicates + the confirmed
// distinct false positives, all drawn from the 3 audits of 2026-07-26
// (docs/maintenance/2026-07-26-reprocess-channel-*.md). Each row cites its
// source so a future reader can re-check against the original audit. ──

const CONFIRMED_PAIRS: {
  label: string;
  a: string;
  b: string;
  sameValue: boolean;
  proximity: NameProximity;
  tier: DuplicateTier | null;
}[] = [
  // True positives — duplicates confirmed by screenshot.
  {
    label: 'TP1 donation Big§teel/RigSteel (Test Alliance report, honor 6095)',
    a: 'Big§teelCurtain',
    b: 'RigSteelCurtain',
    sameValue: true,
    proximity: 'strong',
    tier: 'high',
  },
  {
    label: 'TP2 elite_wars MARKHOR (SOD report finding 2, points 1555956)',
    a: 'ГАШВУХMARKHOR',
    b: 'ZAIBYXMARKHOR',
    sameValue: true,
    proximity: 'strong',
    tier: 'high',
  },
  {
    label: 'TP3 elite_wars Аня/AHA (SOD report finding 2, points 768152)',
    a: 'Аня',
    b: 'AHA',
    sameValue: true,
    proximity: 'weak',
    tier: 'medium',
  },
  {
    label: 'TP4 wasteland_showdown зрух/SPyx (LOL report, points 2556130)',
    a: 'зрух',
    b: 'SPyx',
    sameValue: true,
    proximity: 'weak',
    tier: 'medium',
  },
  // False positives — confirmed DISTINCT via screenshot (same value, coincidence).
  {
    label: 'FP1 decorated jasmin (Test Alliance report, honor 530) — the dangerous case',
    a: 'jasmin',
    b: 'm| jasmin|o',
    sameValue: true,
    proximity: 'weak',
    tier: 'medium', // not eliminated: see compareNames' comment — stays
    // below the two real HIGH-tier duplicates once ranked (see below).
  },
  {
    label: 'FP2 kotarou/Moud (SOD/Test Alliance reports, honor 600)',
    a: 'kotarou',
    b: 'Moud',
    sameValue: true,
    proximity: 'none',
    tier: 'low',
  },
  {
    label: 'FP3 kotarou/Pluto (SOD report, honor 120)',
    a: 'kotarou',
    b: 'Pluto',
    sameValue: true,
    proximity: 'none',
    tier: 'low',
  },
  {
    label: 'FP4a Blake/moco (SOD report, honor 360)',
    a: 'Blake',
    b: 'moco',
    sameValue: true,
    proximity: 'none',
    tier: 'low',
  },
  {
    label: 'FP4b Blake/Moud (SOD report, honor 360)',
    a: 'Blake',
    b: 'Moud',
    sameValue: true,
    proximity: 'none',
    tier: 'low',
  },
  {
    label: 'FP4c moco/Moud (SOD report, honor 360)',
    a: 'moco',
    b: 'Moud',
    sameValue: true,
    proximity: 'none',
    tier: 'low',
  },
];

describe('compareNames — validated against every known real example', () => {
  it.each(CONFIRMED_PAIRS)('$label', ({ a, b, proximity }) => {
    const result = compareNames(a, b);
    expect(result.proximity).toBe(proximity);
  });

  it('is symmetric: compareNames(a,b) has the same proximity/similarity as compareNames(b,a)', () => {
    for (const { a, b } of CONFIRMED_PAIRS) {
      const ab = compareNames(a, b);
      const ba = compareNames(b, a);
      expect(ba.proximity).toBe(ab.proximity);
      expect(ba.similarity).toBeCloseTo(ab.similarity, 10);
    }
  });

  it('the confusable fold is load-bearing: without it, TP2/TP3/TP4 would score >= 3 edit distance', () => {
    // Proves the fold isn't decorative — delete it and this assertion fails,
    // which is exactly the class of bug that made findFuzzyMatch's plain
    // Levenshtein miss these three real duplicates in the first place.
    const noFold = (raw: string) => raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const distanceWithoutFold = (a: string, b: string) => {
      // Same DP as levenshtein() in name-resolve.ts, inlined so this test
      // doesn't depend on foldConfusables being bypassable.
      const ka = noFold(a);
      const kb = noFold(b);
      const prev = Array.from({ length: kb.length + 1 }, (_, j) => j);
      let row = prev;
      for (let i = 1; i <= ka.length; i++) {
        const curr = [i];
        for (let j = 1; j <= kb.length; j++) {
          curr[j] =
            ka[i - 1] === kb[j - 1] ? row[j - 1]! : 1 + Math.min(row[j]!, curr[j - 1]!, row[j - 1]!);
        }
        row = curr;
      }
      return row[kb.length]!;
    };
    expect(distanceWithoutFold('ГАШВУХMARKHOR', 'ZAIBYXMARKHOR')).toBeGreaterThanOrEqual(3);
    expect(distanceWithoutFold('Аня', 'AHA')).toBeGreaterThanOrEqual(3);
    expect(distanceWithoutFold('зрух', 'SPyx')).toBeGreaterThanOrEqual(3);
  });

  it('the containment demotion is load-bearing for the dangerous false positive', () => {
    const result = compareNames('jasmin', 'm| jasmin|o');
    expect(result.containment).toBe(true);
    expect(result.reason).toContain('one name contains the other');
  });

  it('a different-value weak-proximity pair is NOT reported (documented boundary)', () => {
    // Big§teelCurtain/SteelCurtain: sim 0.786, just under SIM_STRONG (0.80),
    // and the audit itself calls this pair unconfirmed. Deliberately not
    // tuned in — see duplicate-scan.ts's SIM_STRONG comment.
    const entryA: ScanEntry = { playerId: 'p1', playerName: 'Big§teelCurtain', value: 9590, confidence: 0.8 };
    const entryB: ScanEntry = { playerId: 'p2', playerName: 'SteelCurtain', value: 8161, confidence: 0.8 };
    const ctx: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };
    expect(classifyPair(entryA, entryB, ctx)).toBeNull();
  });

  it('an exact-key match with different values is still MEDIUM (diacritic fold)', () => {
    const entryA: ScanEntry = { playerId: 'p1', playerName: 'Mjölnir', value: 100, confidence: 0.9 };
    const entryB: ScanEntry = { playerId: 'p2', playerName: 'Mjolnir', value: 200, confidence: 0.9 };
    const ctx: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };
    const candidate = classifyPair(entryA, entryB, ctx);
    expect(candidate?.tier).toBe('medium');
    expect(candidate?.name.proximity).toBe('exact-key');
  });

  it('a short-name pair (JANI/DANI) with equal values is MEDIUM, never HIGH', () => {
    const entryA: ScanEntry = { playerId: 'p1', playerName: 'JANI', value: 500, confidence: 0.9 };
    const entryB: ScanEntry = { playerId: 'p2', playerName: 'DANI', value: 500, confidence: 0.9 };
    const ctx: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };
    const candidate = classifyPair(entryA, entryB, ctx);
    expect(candidate?.tier).toBe('medium');
  });
});

describe('true positives never fall below, and false positives never reach, HIGH/LOW respectively', () => {
  it('no false positive reaches HIGH tier, and no true positive falls to LOW tier', () => {
    // NOT "every TP outranks every FP": FP1 (jasmin/mjasmino) is MEDIUM,
    // tied with TP3/TP4 — the plan's own validation table documents this as
    // the one false positive no pure name+value signal can fully separate
    // from a genuine variant (its similarity, 0.750, matches TP4's exactly).
    // That's why this feature surfaces candidates for a human to check
    // against the source screenshot rather than ranking alone deciding
    // anything. What DOES hold, and must keep holding across future
    // threshold retuning: no false positive is ever confident enough to
    // reach HIGH, and no true positive ever degrades all the way to LOW.
    const ctx: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };
    let idCounter = 0;
    const labelByPairKey = new Map<string, string>();
    const candidateList = CONFIRMED_PAIRS.map(({ a, b, sameValue, label }) => {
      const value = 1000;
      const entryA: ScanEntry = { playerId: `p${idCounter++}`, playerName: a, value, confidence: 0.8 };
      const entryB: ScanEntry = {
        playerId: `p${idCounter++}`,
        playerName: b,
        value: sameValue ? value : value + 1,
        confidence: 0.8,
      };
      labelByPairKey.set([entryA.playerId, entryB.playerId].sort().join('|'), label);
      return classifyPair(entryA, entryB, ctx);
    }).filter((c): c is NonNullable<typeof c> => c !== null);

    const ranked = rankCandidates(candidateList);
    for (const c of ranked) {
      const label = labelByPairKey.get([c.a.playerId, c.b.playerId].sort().join('|'))!;
      if (label.startsWith('TP')) expect(c.tier).not.toBe('low');
      if (label.startsWith('FP')) expect(c.tier).not.toBe('high');
    }
  });
});

describe('classifyPair', () => {
  it('returns null for a self-pair (same playerId)', () => {
    const ctx: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };
    const entry: ScanEntry = { playerId: 'p1', playerName: 'Alpha', value: 100, confidence: 0.9 };
    expect(classifyPair(entry, entry, ctx)).toBeNull();
  });

  it('is symmetric', () => {
    const ctx: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };
    const entryA: ScanEntry = { playerId: 'p1', playerName: 'Big§teelCurtain', value: 6095, confidence: 0.7 };
    const entryB: ScanEntry = { playerId: 'p2', playerName: 'RigSteelCurtain', value: 6095, confidence: 0.7 };
    expect(classifyPair(entryA, entryB, ctx)?.tier).toBe(classifyPair(entryB, entryA, ctx)?.tier);
  });
});

describe('scanContext', () => {
  const ctx: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };

  it('yields no duplicate unordered pairs for a small context', () => {
    const entries: ScanEntry[] = [
      { playerId: 'p1', playerName: 'ГАШВУХMARKHOR', value: 1555956, confidence: 0.69 },
      { playerId: 'p2', playerName: 'ZAIBYXMARKHOR', value: 1555956, confidence: 0.72 },
      { playerId: 'p3', playerName: 'Unrelated', value: 200, confidence: 0.9 },
    ];
    const candidates = scanContext(entries, ctx);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.tier).toBe('high');
  });

  it('skips (returns empty) above MAX_ENTRIES_PER_CONTEXT', () => {
    const entries: ScanEntry[] = Array.from({ length: MAX_ENTRIES_PER_CONTEXT + 1 }, (_, i) => ({
      playerId: `p${i}`,
      playerName: `Player${i}`,
      value: i,
      confidence: 0.9,
    }));
    expect(scanContext(entries, ctx)).toEqual([]);
  });
});

describe('rankCandidates', () => {
  it('collapses the same player pair appearing in two contexts, keeping the higher tier', () => {
    const ctxA: ScanContext = { kind: 'event', id: 'ev1', label: 'Event 1', valueLabel: 'points' };
    const ctxB: ScanContext = { kind: 'event', id: 'ev2', label: 'Event 2', valueLabel: 'points' };
    const entryA1: ScanEntry = { playerId: 'p1', playerName: 'Big§teelCurtain', value: 6095, confidence: 0.7 };
    const entryB1: ScanEntry = { playerId: 'p2', playerName: 'RigSteelCurtain', value: 6095, confidence: 0.7 };
    // Second context: same pair, different (non-matching) values -> still 'strong' proximity, medium tier.
    const entryA2: ScanEntry = { playerId: 'p1', playerName: 'Big§teelCurtain', value: 100, confidence: 0.7 };
    const entryB2: ScanEntry = { playerId: 'p2', playerName: 'RigSteelCurtain', value: 200, confidence: 0.7 };

    const high = classifyPair(entryA1, entryB1, ctxA)!;
    const medium = classifyPair(entryA2, entryB2, ctxB)!;
    const ranked = rankCandidates([medium, high]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.tier).toBe('high');
    expect(ranked[0]?.alsoInContexts).toBe(1);
  });
});

describe('duplicateKey / foldConfusables', () => {
  it('folds known Cyrillic confusables to their Latin lookalike', () => {
    expect(foldConfusables('а')).toBe('a');
    expect(foldConfusables('н')).toBe('h');
    expect(foldConfusables('у')).toBe('y');
    // г and ш are NOT in the fold table (no clean Latin lookalike) — stay untouched.
    expect(foldConfusables('гaшbyxmarkhor')).toBe('гaшbyxmarkhor');
  });

  it('strips diacritics via NFD', () => {
    expect(duplicateKey('Mjölnir')).toBe(duplicateKey('Mjolnir'));
    expect(duplicateKey('LEÓN')).toBe(duplicateKey('LEON'));
  });
});

describe('the loose scorer never leaks into the automatic auto-alias path', () => {
  it('findFuzzyMatch still rejects the homoglyph pairs this module surfaces', () => {
    // These are exactly the pairs duplicate-scan.ts is designed to catch —
    // proving findFuzzyMatch (name-resolve.ts), which auto-creates aliases
    // with no human in the loop, is untouched and stays tight.
    expect(findFuzzyMatch('AHA', [{ id: 'p1', name: 'Аня' }])).toEqual({ kind: 'none' });
    expect(findFuzzyMatch('RigSteelCurtain', [{ id: 'p1', name: 'Big§teelCurtain' }])).toEqual({
      kind: 'none',
    });
  });
});

// ── findRosterCollisions ─────────────────────────────────────────────────────
//
// The wrong-player-attribution guard: a name credited to one roster player that
// also resembles a DIFFERENT one. Covers the exact-match blind spot (an exact
// string match to `LEON` while `LEÓN` sits in the same roster).
describe('findRosterCollisions', () => {
  const roster = (...names: string[]): RosterPlayer[] =>
    names.map((name, i) => ({ id: `p${i}`, name }));

  it('flags a homoglyph/accent twin of the credited exact match', () => {
    // OCR read "LEON", credited to the p0 "LEON" row; "LEÓN" (p1) is one accent
    // away — the screenshot could have been that player.
    const r = roster('LEON', 'LEÓN');
    const hits = findRosterCollisions('LEON', 'p0', r);
    expect(hits.map((h) => h.player.name)).toEqual(['LEÓN']);
    expect(hits[0]!.comparison.proximity).toBe('exact-key');
  });

  it('flags a short-name distance-1 twin (VV / VVV, jc0n / jcOn)', () => {
    expect(findRosterCollisions('VVV', 'p0', roster('VVV', 'VV')).map((h) => h.player.name)).toEqual(
      ['VV'],
    );
    expect(
      findRosterCollisions('jc0n', 'p0', roster('jc0n', 'jcOn')).map((h) => h.player.name),
    ).toEqual(['jcOn']);
  });

  it('flags a dagger-decoration twin (Satana / Sa†ana)', () => {
    // The dagger is stripped (not folded), so "sa†ana" → "saana": one delete
    // from "satana" → proximity 'strong' rather than an exact-key twin. Still a
    // collision — 'strong' is in COLLISION_PROXIMITIES.
    const hits = findRosterCollisions('Satana', 'p0', roster('Satana', 'Sa†ana'));
    expect(hits.map((h) => h.player.name)).toEqual(['Sa†ana']);
    expect(hits[0]!.comparison.proximity).toBe('strong');
  });

  it('excludes the credited player itself', () => {
    // Only the credited "LEON" is present — no OTHER player to collide with.
    expect(findRosterCollisions('LEON', 'p0', roster('LEON'))).toEqual([]);
  });

  it('returns nothing when no other roster name resembles the credit', () => {
    expect(findRosterCollisions('Zephyrion', 'p0', roster('Zephyrion', 'CompletelyUnrelated'))).toEqual(
      [],
    );
  });

  it('reports every colliding player, not just the closest', () => {
    const hits = findRosterCollisions('LEON', 'p0', roster('LEON', 'LEÓN', 'LEoN'));
    expect(hits.map((h) => h.player.name).sort()).toEqual(['LEoN', 'LEÓN']);
  });
});
