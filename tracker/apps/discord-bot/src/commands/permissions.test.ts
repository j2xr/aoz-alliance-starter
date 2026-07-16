import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { commands } from './index.js';

// These five commands can delete/alter alliance data (merge deletes a player,
// upload can delete at_screenshot_uploads rows, reprocess-channel re-runs OCR
// on an entire channel, membership/player-alias edit canonical player data)
// and previously had no permission restriction at all.
const SENSITIVE_COMMANDS = [
  'merge',
  'upload',
  'reprocess-channel',
  'membership',
  'player-alias',
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
