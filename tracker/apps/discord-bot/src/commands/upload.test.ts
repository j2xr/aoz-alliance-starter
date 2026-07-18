import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AutocompleteInteraction } from 'discord.js';
import { supabase } from '../lib/supabase.js';

// Every command module pulls in ../lib/supabase.js -> ../config.js, whose
// requireEnv() throws at import time without a real DISCORD_BOT_TOKEN etc.
// (same workaround as permissions.test.ts).
vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));

import { autocomplete } from './upload.js';

const EVENT_TYPES = [
  { code: 'polar_invasion', display_name: 'Polar Invasion' },
  { code: 'elite_wars', display_name: 'Elite Wars' },
  { code: 'void_war', display_name: 'Void War' },
];

type SupabaseFrom = typeof supabase.from;

/** Queues a `.from('at_event_types').select(...).order(...)` chain resolving to { data, error }. */
function queueEventTypes(data: unknown, error: unknown = null) {
  vi.mocked(supabase.from).mockReturnValueOnce({
    select: vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data, error }),
    }),
  } as unknown as ReturnType<SupabaseFrom>);
}

function fakeInteraction(focused: string): AutocompleteInteraction {
  return {
    options: { getFocused: () => focused },
    respond: vi.fn(),
  } as unknown as AutocompleteInteraction;
}

describe('upload autocomplete (event_type)', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
  });

  it('lists all event types from the table when nothing typed yet', async () => {
    queueEventTypes(EVENT_TYPES);

    const interaction = fakeInteraction('');
    await autocomplete(interaction);

    expect(supabase.from).toHaveBeenCalledWith('at_event_types');
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Polar Invasion (polar_invasion)', value: 'polar_invasion' },
      { name: 'Elite Wars (elite_wars)', value: 'elite_wars' },
      { name: 'Void War (void_war)', value: 'void_war' },
    ]);
  });

  it('filters by code or display name, case-insensitively', async () => {
    queueEventTypes(EVENT_TYPES);

    const interaction = fakeInteraction('WAR');
    await autocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Elite Wars (elite_wars)', value: 'elite_wars' },
      { name: 'Void War (void_war)', value: 'void_war' },
    ]);
  });

  it('caps results at 25 (Discord autocomplete limit)', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      code: `type_${i}`,
      display_name: `Type ${i}`,
    }));
    queueEventTypes(many);

    const interaction = fakeInteraction('');
    await autocomplete(interaction);

    const respondArg = vi.mocked(interaction.respond).mock.calls[0]![0];
    expect(respondArg).toHaveLength(25);
  });

  it('responds with an empty list on query error instead of throwing', async () => {
    queueEventTypes(null, { message: 'boom' });

    const interaction = fakeInteraction('war');
    await autocomplete(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});
