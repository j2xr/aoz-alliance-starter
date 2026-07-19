import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { resolvePlayerByName } from '../lib/players.js';
import { invalidateAllianceCache } from '../lib/alliance.js';

// Same workaround as correct.test.ts / setup-alliance.test.ts (config.ts's
// requireEnv() throws at import time without real env vars).
vi.mock('../config.js', () => ({
  config: { allowedChannelIds: new Set(['allowed-channel']), reprocessConcurrency: 3, logLevel: 'info' },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }));
// resolvePlayerByName has its own dedicated tests (lib/players.test.ts) —
// mocked wholesale here, same as messageCreate.test.ts mocks resolveAlliance.
vi.mock('../lib/players.js', () => ({ resolvePlayerByName: vi.fn() }));

import { execute } from './merge.js';

type SupabaseFrom = typeof supabase.from;

const ALLIANCE = { id: 'alliance-1', name: 'Test Alliance', discord_channel_id: 'channel-1' };
const ALIAS_PLAYER = { id: 'alias-1', name: 'BadName' };
const CANONICAL_PLAYER = { id: 'canon-1', name: 'GoodName' };

/**
 * Minimal chainable Supabase-style mock resolving to `{ data, error }` —
 * same shape as lib/upsert.test.ts's mkChain. Chainable methods return the
 * same object; `single`/`maybeSingle` and plain `await` both resolve it.
 */
function mkChain(data: unknown, error: unknown = null) {
  const resolved = { data, error };
  const terminal = Promise.resolve(resolved);
  const c: Record<string, unknown> = {
    then: terminal.then.bind(terminal),
    catch: terminal.catch.bind(terminal),
    finally: terminal.finally.bind(terminal),
    single: vi.fn().mockResolvedValue(resolved),
    maybeSingle: vi.fn().mockResolvedValue(resolved),
  };
  for (const m of ['select', 'eq', 'in', 'update', 'delete', 'upsert']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  return c;
}

function queueFrom(data: unknown, error: unknown = null) {
  vi.mocked(supabase.from).mockReturnValueOnce(
    mkChain(data, error) as unknown as ReturnType<SupabaseFrom>,
  );
}

function fakeInteraction(
  alias: string,
  into: string,
  channelId = 'channel-1',
  userId = 'user-1',
): ChatInputCommandInteraction {
  return {
    channelId,
    user: { id: userId },
    options: {
      getString: (name: string) => (name === 'alias' ? alias : name === 'into' ? into : null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

describe('/merge execute', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
    vi.mocked(resolvePlayerByName).mockReset();
    // requireAlliance -> resolveAlliance caches per channelId (lib/alliance.ts,
    // 30s TTL) — every test below reuses 'channel-1'.
    invalidateAllianceCache('channel-1');
  });

  it("re-points the alias player's correction history to the canonical player before deleting it", async () => {
    queueFrom(ALLIANCE); // requireAlliance
    vi.mocked(resolvePlayerByName)
      .mockResolvedValueOnce({ status: 'found', player: ALIAS_PLAYER }) // alias lookup
      .mockResolvedValueOnce({ status: 'found', player: CANONICAL_PLAYER }); // canonical lookup
    queueFrom([]); // at_participations select (alias): none
    queueFrom([]); // at_participations select (canonical): none
    queueFrom([]); // at_alliance_memberships select (alias): none
    queueFrom([]); // at_alliance_memberships select (canonical): none
    queueFrom(null); // at_player_aliases upsert
    const correctionsChain = mkChain(null); // at_corrections update — captured for inspection
    vi.mocked(supabase.from).mockReturnValueOnce(
      correctionsChain as unknown as ReturnType<SupabaseFrom>,
    );
    queueFrom(null); // at_players delete

    const interaction = fakeInteraction('BadName', 'GoodName');
    await execute(interaction);

    // The at_corrections update must run BEFORE the at_players delete —
    // 0023's `on delete set null` FK means doing this after the delete
    // would silently orphan the alias's correction history instead of
    // reassigning it.
    const tableCallOrder = vi.mocked(supabase.from).mock.calls.map(([table]) => table);
    expect(tableCallOrder.indexOf('at_corrections')).toBeLessThan(tableCallOrder.lastIndexOf('at_players'));

    expect(correctionsChain['update']).toHaveBeenCalledWith({ player_id: CANONICAL_PLAYER.id });
    expect(correctionsChain['eq']).toHaveBeenCalledWith('player_id', ALIAS_PLAYER.id);

    const reply = vi.mocked(interaction.editReply).mock.calls[0]![0] as { embeds: unknown[] };
    expect(reply.embeds).toHaveLength(1);
  });

  it('propagates a database error from the correction-history reassignment instead of swallowing it', async () => {
    queueFrom(ALLIANCE);
    vi.mocked(resolvePlayerByName)
      .mockResolvedValueOnce({ status: 'found', player: ALIAS_PLAYER })
      .mockResolvedValueOnce({ status: 'found', player: CANONICAL_PLAYER });
    queueFrom([]);
    queueFrom([]);
    queueFrom([]);
    queueFrom([]);
    queueFrom(null); // at_player_aliases upsert
    queueFrom(null, 'constraint violation'); // at_corrections update fails

    const interaction = fakeInteraction('BadName', 'GoodName');

    await expect(execute(interaction)).rejects.toThrow('Failed to reassign correction history');
  });
});
