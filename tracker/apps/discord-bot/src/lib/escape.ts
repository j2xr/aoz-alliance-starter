/**
 * Escapes PostgreSQL LIKE/ILIKE metacharacters (`%`, `_`, `\`) in user
 * input so they're treated literally in a pattern. Without this,
 * `/merge alias:a_b` matches "aXb" and `/leaderboard event_id:%` matches
 * any event.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
