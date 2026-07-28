// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCurrentParisIsoWeekMondayString } from './donationFormat';

// Vectors shared with the bot (tracker/.../lib/period.test.ts): the two
// ISO Monday Europe/Paris implementations must stay in agreement — the bot
// writes period_start, the frontend derives the current period's key.
const sharedVectors = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../..', 'shared-test-vectors/paris-iso-week.json'),
    'utf-8',
  ),
);

describe('getCurrentParisIsoWeekMondayString — shared vectors', () => {
  it.each(sharedVectors.vectors)('$label ($input → $expected)', ({ input, expected }) => {
    expect(getCurrentParisIsoWeekMondayString(new Date(input))).toBe(expected);
  });
});
