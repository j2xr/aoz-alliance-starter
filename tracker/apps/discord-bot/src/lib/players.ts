import { escapeLike } from './escape.js';
import { supabase } from './supabase.js';

export type PlayerRow = { id: string; name: string };

export type PlayerLookup =
  | { status: 'found'; player: PlayerRow }
  | { status: 'ambiguous'; candidates: PlayerRow[] }
  | { status: 'none' };

/**
 * Recherche un joueur par nom dans une alliance — logique commune aux
 * commandes (elle était re-implémentée dans merge/membership/player/donation
 * avec des variantes involontaires).
 *
 * - match 'exact'   : ilike strict (casse ignorée), limite 2 — pour les
 *   commandes destructives (merge, membership) où l'ambiguïté doit bloquer.
 * - match 'partial' : %nom%, limite 5 — pour les commandes de consultation
 *   (player, donation) qui listent les candidats en cas d'ambiguïté.
 *
 * Les métacaractères LIKE de l'entrée utilisateur sont échappés ; les
 * libellés de réponse restent dans chaque commande.
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
