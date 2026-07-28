import { describe, expect, it } from 'vitest';
import { capDiscordContent } from './discord-limits.js';

describe('capDiscordContent', () => {
  it('returns short content unchanged', () => {
    expect(capDiscordContent('hello')).toBe('hello');
  });

  it('truncates content past the margin, staying under Discord\'s 2000-char hard limit', () => {
    const content = 'x'.repeat(3000);

    const result = capDiscordContent(content);

    expect(result.length).toBeLessThan(2000);
    expect(result).toBe('x'.repeat(1900));
  });

  it('a real-shaped batch of truncation warnings (the reproduced finding) gets capped', () => {
    // ~193 chars each, 11 attachments → 2130+ raw, over the 2000-char hard
    // limit that would otherwise throw DiscordAPIError[50035].
    const warning =
      '⚠️ **weekly_screenshot_alliance_honor_2026-05-21.png** — reading stopped before the list possibly ended ' +
      '(several unreadable lines in a row). Some players may be missing: ' +
      'check the full ranking.';
    const lines = Array.from({ length: 11 }, () => warning);
    const content = lines.join('\n');
    expect(content.length).toBeGreaterThan(2000);

    const result = capDiscordContent(content);

    expect(result.length).toBeLessThanOrEqual(1900);
  });
});
