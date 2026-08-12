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
 * - match 'exact'   : case-insensitive ilike, then a case-SENSITIVE tie-break
 *   — for destructive commands (merge, membership). The ilike keeps the "type
 *   the name without worrying about case" convenience, but because
 *   at_players carries `unique (alliance_id, name)` (0001_at_init.sql), at
 *   most one row can match a given name byte-for-byte, so a case-exact input
 *   always resolves case duplicates (spyx/SpYX/SPyx) to a single player
 *   instead of dead-ending on 'ambiguous'. Only a genuinely ambiguous input
 *   (no exact-case match among several ilike hits) still blocks.
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
  // exact: fetch up to 5 so every case variant of a name is visible for the
  // case-sensitive tie-break below (2 was enough to detect ambiguity but not
  // to disambiguate it).
  const limit = opts.match === 'exact' ? 5 : 5;

  const { data, error } = await supabase
    .from('at_players')
    .select('id, name')
    .eq('alliance_id', allianceId)
    .ilike('name', pattern)
    .limit(limit);

  if (error) throw error;

  const players = (data ?? []) as PlayerRow[];
  if (players.length === 0) return { status: 'none' };
  if (players.length === 1) return { status: 'found', player: players[0]! };

  // Multiple case-insensitive hits. In exact mode, break the tie on an
  // exact-case match: the unique(alliance_id, name) constraint guarantees at
  // most one, so this turns "use the exact name" from an unsatisfiable error
  // into a working merge/membership target on case duplicates.
  if (opts.match === 'exact') {
    const caseExact = players.filter((p) => p.name === name);
    if (caseExact.length === 1) return { status: 'found', player: caseExact[0]! };
  }
  return { status: 'ambiguous', candidates: players };
}
