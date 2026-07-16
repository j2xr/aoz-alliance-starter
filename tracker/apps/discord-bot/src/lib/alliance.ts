import type { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from './supabase.js';

export type AllianceRow = {
  id: string;
  name: string;
  discord_channel_id: string;
};

export async function resolveAlliance(channelId: string): Promise<AllianceRow | null> {
  const { data, error } = await supabase
    .from('at_alliances')
    .select('id, name, discord_channel_id')
    .eq('discord_channel_id', channelId)
    .maybeSingle();

  if (error) throw new Error(`Alliance query failed: ${error.message} [${error.code}]`);
  return data as AllianceRow | null;
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
