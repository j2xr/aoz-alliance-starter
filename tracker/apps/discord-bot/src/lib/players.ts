import { escapeLike } from './escape.js';
import { supabase } from './supabase.js';

export type PlayerRow = { id: string; name: string };

export type PlayerLookup =
  | { status: 'found'; player: PlayerRow }
  | { status: 'ambiguous'; candidates: PlayerRow[] }
  | { status: 'none' };

/**
 * Looks up a player by name within an alliance — logic shared across
 * commands (it used to be re-implemented in merge/membership/player/donation
 * with unintentional variants).
 *
 * - match 'exact'   : strict ilike (case-insensitive), limit 2 — for
 *   destructive commands (merge, membership) where ambiguity must block.
 * - match 'partial' : %name%, limit 5 — for lookup commands (player,
 *   donation) that list candidates when ambiguous.
 *
 * LIKE metacharacters in user input are escaped; reply wording stays in
 * each command.
 */
export async function resolvePlayerByName(
  allianceId: string,
  name: string,
  opts: { match: 'exact' | 'partial' },
): Promise<PlayerLookup> {
  const pattern = opts.match === 'exact' ? escapeLike(name) : `%${escapeLike(name)}%`;
  const limit = opts.match === 'exact' ? 2 : 5;

  const { data, error } = await supabase
    .from('at_players')
    .select('id, name')
    .eq('alliance_id', allianceId)
    .ilike('name', pattern)
    .limit(limit);

  if (error) throw error;

  const players = (data ?? []) as PlayerRow[];
  if (players.length === 0) return { status: 'none' };
  if (players.length > 1) return { status: 'ambiguous', candidates: players };
  return { status: 'found', player: players[0]! };
}
