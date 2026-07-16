import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance } from '../lib/alliance.js';
import { resolvePlayerByName } from '../lib/players.js';
import logger from '../logger.js';

export const data = new SlashCommandBuilder()
  .setName('membership')
  .setDescription("Gérer manuellement l'appartenance d'un joueur à l'alliance")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('player')
      .setDescription('Nom exact du joueur')
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('action')
      .setDescription('Action')
      .setRequired(true)
      .addChoices(
        { name: 'joined — enregistrer une arrivée', value: 'joined' },
        { name: 'left — enregistrer un départ', value: 'left' },
      ),
  )
  .addStringOption((opt) =>
    opt
      .setName('date')
      .setDescription(
        'Date ISO (ex: 2026-04-24 ou 2026-04-24T15:00:00). Défaut : maintenant.',
      )
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const playerName = interaction.options.getString('player', true);
  const action = interaction.options.getString('action', true) as 'joined' | 'left';
  const dateRaw = interaction.options.getString('date');

  // Parse and validate the date
  let dateTs: string;
  if (dateRaw) {
    const parsed = new Date(dateRaw);
    if (isNaN(parsed.getTime())) {
      await interaction.editReply(
        `❌ Date invalide : \`${dateRaw}\`. Utilisez le format ISO (ex: 2026-04-24 ou 2026-04-24T15:00:00).`,
      );
      return;
    }
    dateTs = parsed.toISOString();
  } else {
    dateTs = new Date().toISOString();
  }

  // Find the player (exact name, case-insensitive)
  const lookup = await resolvePlayerByName(alliance.id, playerName, { match: 'exact' });

  if (lookup.status === 'none') {
    await interaction.editReply(
      `❌ Joueur \`${playerName}\` introuvable dans l'alliance **${alliance.name}**.`,
    );
    return;
  }

  if (lookup.status === 'ambiguous') {
    await interaction.editReply(
      `❌ Plusieurs joueurs correspondent à \`${playerName}\`. Utilisez le nom exact.`,
    );
    return;
  }

  const player = lookup.player;

  const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Membership mis à jour');

  if (action === 'joined') {
    // Insert a new active membership
    const { error } = await supabase.from('at_alliance_memberships').upsert(
      {
        alliance_id: alliance.id,
        player_id: player.id,
        joined_at: dateTs,
        left_at: null,
      },
      { onConflict: 'alliance_id,player_id,joined_at' },
    );
    if (error) throw error;

    logger.info(
      { playerId: player.id, allianceId: alliance.id, joinedAt: dateTs },
      'Membership joined inserted',
    );
    embed.setDescription(
      `**${player.name}** a rejoint l'alliance **${alliance.name}**.\nDate d'arrivée : \`${dateTs}\``,
    );
  } else {
    // Find the active membership (left_at IS NULL) and set left_at
    const { data: activeMembership, error: findError } = await supabase
      .from('at_alliance_memberships')
      .select('id, joined_at')
      .eq('alliance_id', alliance.id)
      .eq('player_id', player.id)
      .is('left_at', null)
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) throw findError;

    if (!activeMembership) {
      await interaction.editReply(
        `❌ Aucune appartenance active trouvée pour **${player.name}** dans l'alliance **${alliance.name}**.`,
      );
      return;
    }

    const mem = activeMembership as { id: string; joined_at: string };

    const { error: updateError } = await supabase
      .from('at_alliance_memberships')
      .update({ left_at: dateTs })
      .eq('id', mem.id);

    if (updateError) throw updateError;

    logger.info(
      { playerId: player.id, allianceId: alliance.id, leftAt: dateTs },
      'Membership left_at updated',
    );
    embed.setDescription(
      `**${player.name}** a quitté l'alliance **${alliance.name}**.\nDate d'arrivée : \`${mem.joined_at}\`\nDate de départ : \`${dateTs}\``,
    );
  }

  await interaction.editReply({ embeds: [embed] });
}
