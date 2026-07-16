// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCurrentParisIsoWeekMondayString } from './donationFormat';

// Vecteurs partagés avec le bot (tracker/.../lib/period.test.ts) : les deux
// implémentations du lundi ISO Europe/Paris doivent rester d'accord — le bot
// écrit period_start, le frontend dérive la clé de la période courante.
const sharedVectors = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../..', 'shared-test-vectors/paris-iso-week.json'),
    'utf-8',
  ),
);

describe('getCurrentParisIsoWeekMondayString — vecteurs partagés', () => {
  it.each(sharedVectors.vectors)('$label ($input → $expected)', ({ input, expected }) => {
    expect(getCurrentParisIsoWeekMondayString(new Date(input))).toBe(expected);
  });
});
