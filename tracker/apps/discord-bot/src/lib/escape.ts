/**
 * Échappe les métacaractères LIKE/ILIKE PostgreSQL (`%`, `_`, `\`) d'une
 * entrée utilisateur pour qu'ils soient traités littéralement dans un
 * pattern. Sans cela, `/merge alias:a_b` matche « aXb » et
 * `/leaderboard event_id:%` matche n'importe quel événement.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
