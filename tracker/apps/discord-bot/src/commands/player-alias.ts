import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance } from '../lib/alliance.js';
import logger from '../logger.js';

export const data = new SlashCommandBuilder()
  .setName('player-alias')
  .setDescription("Gestion des corrections de noms OCR → joueur canonique")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Associer un nom OCR mal reconnu à un joueur existant')
      .addStringOption((opt) =>
        opt
          .setName('raw')
          .setDescription('Nom brut tel que renvoyé par l\'OCR (à corriger)')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('canonical')
          .setDescription('Nom exact du joueur dans la base (utilisez /player pour le trouver)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Supprimer un alias de correction')
      .addStringOption((opt) =>
        opt
          .setName('raw')
          .setDescription('Nom brut à désaliaser')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Lister tous les aliases de correction de cette alliance'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const rawName = interaction.options.getString('raw', true).trim();
    const canonicalName = interaction.options.getString('canonical', true).trim();

    const { data: player, error: playerError } = await supabase
      .from('at_players')
      .select('id, name')
      .eq('alliance_id', alliance.id)
      .eq('name', canonicalName)
      .maybeSingle();

    if (playerError) throw playerError;

    if (!player) {
      await interaction.editReply(
        `❌ Joueur \`${canonicalName}\` introuvable dans l'alliance **${alliance.name}**.\n` +
        `Utilisez \`/player\` pour trouver le nom exact.`,
      );
      return;
    }

    const p = player as { id: string; name: string };

    const { error: upsertError } = await supabase
      .from('at_player_aliases')
      .upsert(
        {
          alliance_id: alliance.id,
          raw_name: rawName,
          player_id: p.id,
          created_by: interaction.user.id,
        },
        { onConflict: 'alliance_id,raw_name' },
      );

    if (upsertError) throw upsertError;

    logger.info({ rawName, canonicalName, allianceId: alliance.id }, 'Player alias added');

    await interaction.editReply(
      `✅ Alias ajouté : \`${rawName}\` → **${p.name}**\n` +
      `Les prochaines captures contenant ce nom seront automatiquement corrigées.`,
    );
    return;
  }

  if (sub === 'remove') {
    const rawName = interaction.options.getString('raw', true).trim();

    const { error, count } = await supabase
      .from('at_player_aliases')
      .delete({ count: 'exact' })
      .eq('alliance_id', alliance.id)
      .eq('raw_name', rawName);

    if (error) throw error;

    if (!count || count === 0) {
      await interaction.editReply(`❌ Alias \`${rawName}\` introuvable.`);
      return;
    }

    logger.info({ rawName, allianceId: alliance.id }, 'Player alias removed');
    await interaction.editReply(`✅ Alias \`${rawName}\` supprimé.`);
    return;
  }

  // sub === 'list'
  const { data: aliases, error: listError } = await supabase
    .from('at_player_aliases')
    .select('raw_name, at_players(name)')
    .eq('alliance_id', alliance.id)
    .order('raw_name');

  if (listError) throw listError;

  type AliasListRow = { raw_name: string; at_players: { name: string } | null };
  const rows = (aliases ?? []) as unknown as AliasListRow[];

  if (rows.length === 0) {
    await interaction.editReply(
      `Aucun alias de correction défini pour l'alliance **${alliance.name}**.`,
    );
    return;
  }

  const lines = rows.map((r) => `\`${r.raw_name}\` → **${r.at_players?.name ?? '?'}**`);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🔤 Aliases OCR — ${alliance.name}`)
    .setDescription(lines.join('\n'));

  await interaction.editReply({ embeds: [embed] });
}
