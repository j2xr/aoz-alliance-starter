import { describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { commands } from './index.js';

// Every command module pulls in ../lib/supabase.js -> ../config.js, whose
// requireEnv() throws at import time without a real DISCORD_BOT_TOKEN etc.
// This test only inspects each command's `data` builder, never `execute`, so
// mock both out rather than requiring real secrets in the test environment.
// vi.mock calls are hoisted above imports, so this still takes effect for
// the `commands` import above.
vi.mock('../config.js', () => ({
  config: {
    allowedChannelIds: new Set(['allowed-channel']),
    reprocessConcurrency: 3,
    logLevel: 'info',
  },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: {} }));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// These commands can delete/alter alliance data (merge deletes a player,
// upload can delete at_screenshot_uploads rows, reprocess-channel re-runs OCR
// on an entire channel, membership/player-alias edit canonical player data,
// setup-alliance creates a new at_alliances row, correct overwrites a
// participation/donation score) and previously had no permission restriction
// at all.
const SENSITIVE_COMMANDS = [
  'merge',
  'upload',
  'reprocess-channel',
  'membership',
  'player-alias',
  'setup-alliance',
  'correct',
];

describe('sensitive command permissions', () => {
  it.each(SENSITIVE_COMMANDS)('%s requires ManageGuild', (name) => {
    const command = commands.get(name);
    expect(command, `command ${name} not registered`).toBeDefined();
    const json = command!.data.toJSON();
    expect(json.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });

  it('leaves non-sensitive commands unrestricted', () => {
    for (const [name, command] of commands) {
      if (SENSITIVE_COMMANDS.includes(name)) continue;
      const json = command.data.toJSON();
      expect(json.default_member_permissions, `${name} unexpectedly restricted`).toBeFalsy();
    }
  });
});
