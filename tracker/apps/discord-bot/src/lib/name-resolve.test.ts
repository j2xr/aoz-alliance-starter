import { describe, it, expect } from 'vitest';
import { normalizeOcrName, levenshtein, findFuzzyMatch, type RosterPlayer } from './name-resolve.js';

describe('normalizeOcrName', () => {
  it('collapses underscore vs hyphen variants to the same key', () => {
    expect(normalizeOcrName('焼鳥_Yakitori')).toBe(normalizeOcrName('焼鳥-Yakitori'));
  });

  it('strips OCR junk glyphs and lowercases', () => {
    // '§' replaces the 'S' entirely in these real captures — normalizing just
    // drops the junk glyph, it doesn't recover the letter it stood in for.
    expect(normalizeOcrName('6ig§teelCurtain')).toBe('6igteelcurtain');
    expect(normalizeOcrName('Big§teelCurtain')).toBe('bigteelcurtain');
  });

  it('strips separators (dot, space, underscore)', () => {
    expect(normalizeOcrName('Indira.IlsaLATAM')).toBe('indirailsalatam');
    expect(normalizeOcrName('Samwell Tarlv')).toBe('samwelltarlv');
    expect(normalizeOcrName('Samwell_Tarly')).toBe('samwelltarly');
  });
});

describe('levenshtein', () => {
  it('is 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts a single substitution as distance 1', () => {
    expect(levenshtein('bigteelcurtain', '6igteelcurtain')).toBe(1);
    expect(levenshtein('bigteelcurtain', 'rigteelcurtain')).toBe(1);
  });

  it('counts a single deletion as distance 1', () => {
    expect(levenshtein('indirilsalatam', 'indirisalatam')).toBe(1);
  });
});

describe('findFuzzyMatch', () => {
  // Real production data: 3 OCR captures of the same player, none of them
  // clean — '§' consistently stands in for the 'S' in "...Steel...". Only
  // the first letter (6/B/R, itself a misread of the same glyph) varies.
  const roster: RosterPlayer[] = [
    { id: 'p1', name: 'Big§teelCurtain' },
    { id: 'p2', name: 'Samwell_Tarly' },
    { id: 'p3', name: 'JANI' },
  ];

  it('matches a single OCR variant within edit distance 1', () => {
    expect(findFuzzyMatch('6ig§teelCurtain', roster)).toEqual({
      kind: 'match',
      player: { id: 'p1', name: 'Big§teelCurtain' },
    });
    expect(findFuzzyMatch('Rig§teelCurtain', roster)).toEqual({
      kind: 'match',
      player: { id: 'p1', name: 'Big§teelCurtain' },
    });
  });

  it('matches names differing only by separator characters', () => {
    expect(findFuzzyMatch('Samwell Tarlv', roster)).toEqual({
      kind: 'match',
      player: { id: 'p2', name: 'Samwell_Tarly' },
    });
  });

  it('returns none when no candidate is close enough', () => {
    expect(findFuzzyMatch('CompletelyDifferentName', roster)).toEqual({ kind: 'none' });
  });

  it('returns none for a name already present verbatim in the roster', () => {
    expect(findFuzzyMatch('Big§teelCurtain', roster)).toEqual({ kind: 'none' });
  });

  it('never matches short names, even at distance 1 (JANI vs DANI)', () => {
    expect(findFuzzyMatch('DANI', roster)).toEqual({ kind: 'none' });
  });

  it('returns ambiguous when two roster players are both close matches', () => {
    const ambiguousRoster: RosterPlayer[] = [
      { id: 'p1', name: 'Somethin_kool' },
      { id: 'p2', name: 'Somethin_kooi' }, // distance 1 from p1, distinct player
    ];
    // Distance 1 from *both* p1 and p2 by construction (last char '1' vs 'l'/'i').
    const rawName = 'Somethin-koo1';
    expect(findFuzzyMatch(rawName, ambiguousRoster)).toEqual(
      expect.objectContaining({ kind: 'ambiguous' }),
    );
  });
});
