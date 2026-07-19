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
  .setName('merge')
  .setDescription('Fusionner un doublon OCR vers un joueur canonique et enregistrer son alias')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('alias')
      .setDescription('Nom du joueur doublon à supprimer (nom OCR erroné)')
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('into')
      .setDescription('Nom du joueur canonique (le "vrai" joueur)')
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const aliasName = interaction.options.getString('alias', true);
  const canonicalName = interaction.options.getString('into', true);

  if (aliasName.toLowerCase() === canonicalName.toLowerCase()) {
    await interaction.editReply('❌ Le nom alias et le nom canonique sont identiques.');
    return;
  }

  // Resolve both players in parallel (exact : l'ambiguïté bloque la fusion)
  const [aliasLookup, canonicalLookup] = await Promise.all([
    resolvePlayerByName(alliance.id, aliasName, { match: 'exact' }),
    resolvePlayerByName(alliance.id, canonicalName, { match: 'exact' }),
  ]);

  if (aliasLookup.status === 'none') {
    await interaction.editReply(
      `❌ Joueur alias \`${aliasName}\` introuvable dans l'alliance **${alliance.name}**.`,
    );
    return;
  }
  if (aliasLookup.status === 'ambiguous') {
    await interaction.editReply(
      `❌ Plusieurs joueurs correspondent à \`${aliasName}\`. Utilisez le nom exact.`,
    );
    return;
  }
  if (canonicalLookup.status === 'none') {
    await interaction.editReply(
      `❌ Joueur canonique \`${canonicalName}\` introuvable dans l'alliance **${alliance.name}**.`,
    );
    return;
  }
  if (canonicalLookup.status === 'ambiguous') {
    await interaction.editReply(
      `❌ Plusieurs joueurs correspondent à \`${canonicalName}\`. Utilisez le nom exact.`,
    );
    return;
  }

  const aliasPlayer = aliasLookup.player;
  const canonicalPlayer = canonicalLookup.player;

  if (aliasPlayer.id === canonicalPlayer.id) {
    await interaction.editReply('❌ Les deux noms pointent vers le même joueur.');
    return;
  }

  logger.info(
    {
      aliasPlayerId: aliasPlayer.id,
      aliasPlayerName: aliasPlayer.name,
      canonicalPlayerId: canonicalPlayer.id,
      canonicalPlayerName: canonicalPlayer.name,
      allianceId: alliance.id,
    },
    'Starting player merge',
  );

  // Fetch alias player's participations to detect conflicts with canonical player
  const { data: aliasParticipations, error: partFetchError } = await supabase
    .from('at_participations')
    .select('id, event_id')
    .eq('player_id', aliasPlayer.id);

  if (partFetchError) throw partFetchError;

  const { data: canonicalParticipations, error: canonPartFetchError } = await supabase
    .from('at_participations')
    .select('event_id')
    .eq('player_id', canonicalPlayer.id);

  if (canonPartFetchError) throw canonPartFetchError;

  const canonicalEventIds = new Set(
    ((canonicalParticipations ?? []) as { event_id: string }[]).map((p) => p.event_id),
  );
  const aliasPartRows = (aliasParticipations ?? []) as { id: string; event_id: string }[];

  // Split alias participations: reassignable vs conflicting (canonical already has a row)
  const reassignablePartIds = aliasPartRows
    .filter((p) => !canonicalEventIds.has(p.event_id))
    .map((p) => p.id);
  const conflictingPartIds = aliasPartRows
    .filter((p) => canonicalEventIds.has(p.event_id))
    .map((p) => p.id);

  // Reassign non-conflicting participations to canonical player
  if (reassignablePartIds.length > 0) {
    const { error } = await supabase
      .from('at_participations')
      .update({ player_id: canonicalPlayer.id })
      .in('id', reassignablePartIds);
    if (error) throw new Error(`Failed to reassign participations: ${error.message}`);
  }

  // Drop conflicting participations (canonical already has a record for those events)
  if (conflictingPartIds.length > 0) {
    const { error } = await supabase
      .from('at_participations')
      .delete()
      .in('id', conflictingPartIds);
    if (error) throw new Error(`Failed to delete conflicting participations: ${error.message}`);
    logger.warn(
      { count: conflictingPartIds.length, aliasPlayerId: aliasPlayer.id },
      'Dropped conflicting participations (canonical player already has a record for those events)',
    );
  }

  // Reassign memberships — drop conflicts where canonical already has an overlapping joined_at
  const { data: aliasMemberships, error: memFetchError } = await supabase
    .from('at_alliance_memberships')
    .select('id, joined_at')
    .eq('player_id', aliasPlayer.id);

  if (memFetchError) throw memFetchError;

  const { data: canonicalMemberships, error: canonMemFetchError } = await supabase
    .from('at_alliance_memberships')
    .select('joined_at')
    .eq('player_id', canonicalPlayer.id);

  if (canonMemFetchError) throw canonMemFetchError;

  const canonicalJoinedAts = new Set(
    ((canonicalMemberships ?? []) as { joined_at: string }[]).map((m) => m.joined_at),
  );
  const aliasMemRows = (aliasMemberships ?? []) as { id: string; joined_at: string }[];

  const reassignableMemIds = aliasMemRows
    .filter((m) => !canonicalJoinedAts.has(m.joined_at))
    .map((m) => m.id);
  const conflictingMemIds = aliasMemRows
    .filter((m) => canonicalJoinedAts.has(m.joined_at))
    .map((m) => m.id);

  if (reassignableMemIds.length > 0) {
    const { error } = await supabase
      .from('at_alliance_memberships')
      .update({ player_id: canonicalPlayer.id })
      .in('id', reassignableMemIds);
    if (error) throw new Error(`Failed to reassign memberships: ${error.message}`);
  }

  if (conflictingMemIds.length > 0) {
    const { error } = await supabase
      .from('at_alliance_memberships')
      .delete()
      .in('id', conflictingMemIds);
    if (error) throw new Error(`Failed to delete conflicting memberships: ${error.message}`);
  }

  // Register alias so future OCR hits on this name are redirected automatically
  const { error: aliasInsertError } = await supabase.from('at_player_aliases').upsert(
    {
      alliance_id: alliance.id,
      raw_name: aliasPlayer.name,
      player_id: canonicalPlayer.id,
      created_by: interaction.user.id,
    },
    { onConflict: 'alliance_id,raw_name' },
  );
  if (aliasInsertError) throw new Error(`Failed to insert alias: ${aliasInsertError.message}`);

  // Re-point the alias player's /correct audit history (at_corrections,
  // migration 0022/0023) to the canonical player before deleting it. Unlike
  // participations/memberships there's no unique-per-player constraint on
  // at_corrections to conflict with, so this is a plain unconditional
  // reassignment — without it, at_corrections.player_id's `on delete set
  // null` (0023) would silently orphan the alias's correction history the
  // moment the delete below runs.
  const { error: correctionsReassignError } = await supabase
    .from('at_corrections')
    .update({ player_id: canonicalPlayer.id })
    .eq('player_id', aliasPlayer.id);
  if (correctionsReassignError) {
    throw new Error(`Failed to reassign correction history: ${correctionsReassignError.message}`);
  }

  // Delete the duplicate player (cascade will clean up any remaining FK rows)
  const { error: deleteError } = await supabase
    .from('at_players')
    .delete()
    .eq('id', aliasPlayer.id);
  if (deleteError) throw new Error(`Failed to delete alias player: ${deleteError.message}`);

  logger.info(
    {
      aliasPlayerId: aliasPlayer.id,
      canonicalPlayerId: canonicalPlayer.id,
      reassignedParticipations: reassignablePartIds.length,
      droppedParticipations: conflictingPartIds.length,
    },
    'Player merge completed',
  );

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ Fusion effectuée')
    .setDescription(
      `**\`${aliasPlayer.name}\`** → **\`${canonicalPlayer.name}\`** dans l'alliance **${alliance.name}**`,
    )
    .addFields(
      {
        name: 'Participations réattribuées',
        value: String(reassignablePartIds.length),
        inline: true,
      },
      {
        name: 'Participations en conflit (supprimées)',
        value: String(conflictingPartIds.length),
        inline: true,
      },
      {
        name: 'Alias enregistré',
        value: `\`${aliasPlayer.name}\` sera automatiquement reconnu à la prochaine capture.`,
      },
    );

  await interaction.editReply({ embeds: [embed] });
}
