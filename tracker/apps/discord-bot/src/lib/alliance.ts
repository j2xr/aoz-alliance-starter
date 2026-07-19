import type { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from './supabase.js';

export type AllianceRow = {
  id: string;
  name: string;
  discord_channel_id: string;
};

// The channel->alliance mapping only changes via /setup-alliance (rare,
// admin-only), so a short TTL cache removes a redundant round-trip from
// every command invocation — and, more importantly, from /correct's
// per-keystroke autocomplete path, which shares a non-deferrable 3s Discord
// deadline with a second (player/event) query.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { row: AllianceRow | null; expiresAt: number }>();

export async function resolveAlliance(channelId: string): Promise<AllianceRow | null> {
  const cached = cache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  const { data, error } = await supabase
    .from('at_alliances')
    .select('id, name, discord_channel_id')
    .eq('discord_channel_id', channelId)
    .maybeSingle();

  if (error) throw new Error(`Alliance query failed: ${error.message} [${error.code}]`);
  const row = data as AllianceRow | null;
  cache.set(channelId, { row, expiresAt: Date.now() + CACHE_TTL_MS });
  return row;
}

/**
 * Drops the cached resolveAlliance result for a channel. Call after writing
 * at_alliances (currently only /setup-alliance's insert) so the freshly
 * linked channel resolves immediately instead of waiting out the TTL.
 */
export function invalidateAllianceCache(channelId: string): void {
  cache.delete(channelId);
}

/**
 * Garde commune des commandes : résout l'alliance du channel de l'interaction
 * et, à défaut, répond le message standard puis retourne null. Toutes les
 * commandes ont déjà deferReply() au moment de l'appel — usage :
 * `const alliance = await requireAlliance(interaction); if (!alliance) return;`
 * (Le guard était copié-collé dans ~12 handlers, avec des variantes de
 * wording ; le comportement est désormais défini ici une seule fois.)
 */
export async function requireAlliance(
  interaction: ChatInputCommandInteraction,
): Promise<AllianceRow | null> {
  const alliance = await resolveAlliance(interaction.channelId);
  if (!alliance) {
    await interaction.editReply("⚠️ Ce channel n'est pas associé à une alliance.");
    return null;
  }
  return alliance;
}
