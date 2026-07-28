import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { resolveAlliance, invalidateAllianceCache } from '../lib/alliance.js';
import { messages } from '../lib/messages.js';
import logger from '../logger.js';

export const data = new SlashCommandBuilder()
  .setName('setup-alliance')
  .setDescription('Create the alliance linked to this Discord channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Alliance name').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const name = interaction.options.getString('name', true).trim();
  const channelId = interaction.channelId;

  const existing = await resolveAlliance(channelId);
  if (existing) {
    await interaction.editReply(messages.allianceAlreadyLinked(existing.name));
    return;
  }

  const { data: nameConflict, error: nameCheckError } = await supabase
    .from('at_alliances')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  if (nameCheckError) throw nameCheckError;
  if (nameConflict) {
    await interaction.editReply(messages.allianceNameTaken(name));
    return;
  }

  const { error } = await supabase
    .from('at_alliances')
    .insert({ name, discord_channel_id: channelId });
  if (error) throw error;

  // The earlier `resolveAlliance(channelId)` call above cached a "no
  // alliance" miss for this channel (30s TTL) — drop it now so this new
  // alliance resolves immediately instead of waiting out the cache.
  invalidateAllianceCache(channelId);

  logger.info({ name, channelId }, 'Alliance created via /setup-alliance');

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ Alliance created')
    .setDescription(messages.allianceCreated(name));

  await interaction.editReply({ embeds: [embed] });
}
