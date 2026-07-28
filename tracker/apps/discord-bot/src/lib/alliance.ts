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
 * Shared guard for commands: resolves the interaction channel's alliance
 * and, failing that, replies with the standard message and returns null. All
 * commands have already called deferReply() by the time this is called —
 * usage: `const alliance = await requireAlliance(interaction); if (!alliance) return;`
 * (The guard used to be copy-pasted across ~12 handlers, with wording
 * variants; the behavior is now defined here once.)
 */
export async function requireAlliance(
  interaction: ChatInputCommandInteraction,
): Promise<AllianceRow | null> {
  const alliance = await resolveAlliance(interaction.channelId);
  if (!alliance) {
    await interaction.editReply('⚠️ This channel is not linked to an alliance.');
    return null;
  }
  return alliance;
}
