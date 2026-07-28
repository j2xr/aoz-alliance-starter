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
  .setDescription('Manage OCR name corrections → canonical player')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Link a misrecognized OCR name to an existing player')
      .addStringOption((opt) =>
        opt
          .setName('raw')
          .setDescription('Raw name as returned by OCR (to be corrected)')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('canonical')
          .setDescription('Exact player name in the database (use /player to find it)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a correction alias')
      .addStringOption((opt) =>
        opt
          .setName('raw')
          .setDescription('Raw name to unalias')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List all correction aliases for this alliance'),
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
        `❌ Player \`${canonicalName}\` not found in alliance **${alliance.name}**.\n` +
        `Use \`/player\` to find the exact name.`,
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
      `✅ Alias added: \`${rawName}\` → **${p.name}**\n` +
      `Future screenshots containing this name will be automatically corrected.`,
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
      await interaction.editReply(`❌ Alias \`${rawName}\` not found.`);
      return;
    }

    logger.info({ rawName, allianceId: alliance.id }, 'Player alias removed');
    await interaction.editReply(`✅ Alias \`${rawName}\` removed.`);
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
      `No correction alias defined for alliance **${alliance.name}**.`,
    );
    return;
  }

  const lines = rows.map((r) => `\`${r.raw_name}\` → **${r.at_players?.name ?? '?'}**`);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🔤 OCR aliases — ${alliance.name}`)
    .setDescription(lines.join('\n'));

  await interaction.editReply({ embeds: [embed] });
}
