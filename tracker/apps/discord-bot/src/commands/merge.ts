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
  .setDescription('Merge an OCR duplicate into a canonical player and record its alias')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('alias')
      .setDescription('Name of the duplicate player to remove (incorrect OCR name)')
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('into')
      .setDescription('Name of the canonical player (the "real" player)')
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const aliasName = interaction.options.getString('alias', true);
  const canonicalName = interaction.options.getString('into', true);

  if (aliasName.toLowerCase() === canonicalName.toLowerCase()) {
    await interaction.editReply('❌ The alias name and the canonical name are identical.');
    return;
  }

  // Resolve both players in parallel (exact match: ambiguity blocks the merge)
  const [aliasLookup, canonicalLookup] = await Promise.all([
    resolvePlayerByName(alliance.id, aliasName, { match: 'exact' }),
    resolvePlayerByName(alliance.id, canonicalName, { match: 'exact' }),
  ]);

  if (aliasLookup.status === 'none') {
    await interaction.editReply(
      `❌ Alias player \`${aliasName}\` not found in alliance **${alliance.name}**.`,
    );
    return;
  }
  if (aliasLookup.status === 'ambiguous') {
    const list = aliasLookup.candidates.map((p) => `• \`${p.name}\``).join('\n');
    await interaction.editReply(
      `❌ Multiple players match \`${aliasName}\`. Retype it with the exact case:\n${list}`,
    );
    return;
  }
  if (canonicalLookup.status === 'none') {
    await interaction.editReply(
      `❌ Canonical player \`${canonicalName}\` not found in alliance **${alliance.name}**.`,
    );
    return;
  }
  if (canonicalLookup.status === 'ambiguous') {
    const list = canonicalLookup.candidates.map((p) => `• \`${p.name}\``).join('\n');
    await interaction.editReply(
      `❌ Multiple players match \`${canonicalName}\`. Retype it with the exact case:\n${list}`,
    );
    return;
  }

  const aliasPlayer = aliasLookup.player;
  const canonicalPlayer = canonicalLookup.player;

  if (aliasPlayer.id === canonicalPlayer.id) {
    await interaction.editReply('❌ Both names point to the same player.');
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

  // Reassign donations — at_donations.player_id is `on delete cascade`
  // (0011_at_donations.sql), so without this the alias's donations are
  // silently destroyed by the delete below (the spyx incident: the merged
  // player held the only donation of the group). Same split as participations:
  // reassign where the canonical has no row for that period, drop the rest
  // (unique (donation_period_id, player_id), 0011).
  const { data: aliasDonations, error: donFetchError } = await supabase
    .from('at_donations')
    .select('id, donation_period_id')
    .eq('player_id', aliasPlayer.id);

  if (donFetchError) throw donFetchError;

  const { data: canonicalDonations, error: canonDonFetchError } = await supabase
    .from('at_donations')
    .select('donation_period_id')
    .eq('player_id', canonicalPlayer.id);

  if (canonDonFetchError) throw canonDonFetchError;

  const canonicalDonationPeriodIds = new Set(
    ((canonicalDonations ?? []) as { donation_period_id: string }[]).map(
      (d) => d.donation_period_id,
    ),
  );
  const aliasDonRows = (aliasDonations ?? []) as { id: string; donation_period_id: string }[];

  const reassignableDonIds = aliasDonRows
    .filter((d) => !canonicalDonationPeriodIds.has(d.donation_period_id))
    .map((d) => d.id);
  const conflictingDonIds = aliasDonRows
    .filter((d) => canonicalDonationPeriodIds.has(d.donation_period_id))
    .map((d) => d.id);

  if (reassignableDonIds.length > 0) {
    const { error } = await supabase
      .from('at_donations')
      .update({ player_id: canonicalPlayer.id })
      .in('id', reassignableDonIds);
    if (error) throw new Error(`Failed to reassign donations: ${error.message}`);
  }

  if (conflictingDonIds.length > 0) {
    const { error } = await supabase.from('at_donations').delete().in('id', conflictingDonIds);
    if (error) throw new Error(`Failed to delete conflicting donations: ${error.message}`);
    logger.warn(
      { count: conflictingDonIds.length, aliasPlayerId: aliasPlayer.id },
      'Dropped conflicting donations (canonical player already has a record for those periods)',
    );
  }

  // Reassign combat stats — at_player_stats.player_id is `on delete cascade`
  // (0015_at_player_stats.sql), same silent-loss trap as donations above.
  // Conflict key: unique (alliance_id, player_id, recorded_date) (0015).
  const { data: aliasStats, error: statsFetchError } = await supabase
    .from('at_player_stats')
    .select('id, recorded_date')
    .eq('player_id', aliasPlayer.id);

  if (statsFetchError) throw statsFetchError;

  const { data: canonicalStats, error: canonStatsFetchError } = await supabase
    .from('at_player_stats')
    .select('recorded_date')
    .eq('player_id', canonicalPlayer.id);

  if (canonStatsFetchError) throw canonStatsFetchError;

  const canonicalStatDates = new Set(
    ((canonicalStats ?? []) as { recorded_date: string }[]).map((s) => s.recorded_date),
  );
  const aliasStatRows = (aliasStats ?? []) as { id: string; recorded_date: string }[];

  const reassignableStatIds = aliasStatRows
    .filter((s) => !canonicalStatDates.has(s.recorded_date))
    .map((s) => s.id);
  const conflictingStatIds = aliasStatRows
    .filter((s) => canonicalStatDates.has(s.recorded_date))
    .map((s) => s.id);

  if (reassignableStatIds.length > 0) {
    const { error } = await supabase
      .from('at_player_stats')
      .update({ player_id: canonicalPlayer.id })
      .in('id', reassignableStatIds);
    if (error) throw new Error(`Failed to reassign player stats: ${error.message}`);
  }

  if (conflictingStatIds.length > 0) {
    const { error } = await supabase.from('at_player_stats').delete().in('id', conflictingStatIds);
    if (error) throw new Error(`Failed to delete conflicting player stats: ${error.message}`);
    logger.warn(
      { count: conflictingStatIds.length, aliasPlayerId: aliasPlayer.id },
      'Dropped conflicting player stats (canonical player already has a record for those dates)',
    );
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

  // Delete the duplicate player. Any table with a data-bearing `on delete
  // cascade` on player_id (at_participations, at_donations, at_player_stats)
  // MUST be reassigned above first — the cascade is a safety net only for
  // rows we don't care about keeping, never a substitute for reassignment.
  // (Relying on it here is exactly what silently destroyed donations before.)
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
      reassignedDonations: reassignableDonIds.length,
      droppedDonations: conflictingDonIds.length,
      reassignedPlayerStats: reassignableStatIds.length,
      droppedPlayerStats: conflictingStatIds.length,
    },
    'Player merge completed',
  );

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ Merge completed')
    .setDescription(
      `**\`${aliasPlayer.name}\`** → **\`${canonicalPlayer.name}\`** in alliance **${alliance.name}**`,
    )
    .addFields(
      {
        name: 'Participations reassigned',
        value: String(reassignablePartIds.length),
        inline: true,
      },
      {
        name: 'Conflicting participations (deleted)',
        value: String(conflictingPartIds.length),
        inline: true,
      },
      {
        name: 'Donations reassigned',
        value: String(reassignableDonIds.length),
        inline: true,
      },
      {
        name: 'Player stats reassigned',
        value: String(reassignableStatIds.length),
        inline: true,
      },
      {
        name: 'Alias recorded',
        value: `\`${aliasPlayer.name}\` will be automatically recognized on the next screenshot.`,
      },
    );

  await interaction.editReply({ embeds: [embed] });
}
