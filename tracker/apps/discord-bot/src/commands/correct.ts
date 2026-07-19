import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance, resolveAlliance, type AllianceRow } from '../lib/alliance.js';
import { isoWeekStartParis } from '../lib/period.js';
import { escapeLike } from '../lib/escape.js';
import logger from '../logger.js';

type Field = 'points' | 'power' | 'honor';
type PlayerRow = { id: string; name: string };

// Postgres "invalid input syntax" — thrown when a free-typed (non-autocomplete)
// value doesn't parse as a uuid. Treated the same as "not found" rather than a
// raw 500, since both `player` and `event_id` are free-text Discord options
// even though they're meant to be filled via autocomplete.
const INVALID_UUID_CODE = '22P02';

const WEEK_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a `week` option value and snaps it to its Paris ISO-week Monday.
 * Returns null on a malformed or calendar-invalid date — the regex alone
 * admits impossible dates like `2026-02-30` (JS Date rolls those over to
 * `2026-03-02` instead of rejecting them, so the round-trip through
 * toISOString() is what actually catches it). A valid but non-Monday date
 * (e.g. a Wednesday within a known week) used to produce a misleading "no
 * period found" reply since the period lookup is an exact match on
 * period_start; snapping here means it now resolves the right week instead.
 */
function parseWeekInput(input: string): string | null {
  if (!WEEK_FORMAT_RE.test(input)) return null;
  const parsed = new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) return null;
  return isoWeekStartParis(parsed);
}

export const data = new SlashCommandBuilder()
  .setName('correct')
  .setDescription("Corriger manuellement un score mal lu par l'OCR")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('player')
      .setDescription('Joueur à corriger')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('field')
      .setDescription('Champ à corriger')
      .setRequired(true)
      .addChoices(
        { name: 'points', value: 'points' },
        { name: 'power', value: 'power' },
        { name: 'honor', value: 'honor' },
      ),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('value')
      .setDescription('Nouvelle valeur')
      .setRequired(true)
      .setMinValue(0)
      // at_participations.points is a Postgres int4 (max 2147483647); power/honor are
      // bigint and would tolerate more, but a single shared cap keeps the option simple
      // and every legitimate score is far below this bound anyway.
      .setMaxValue(2_147_483_647),
  )
  .addStringOption((opt) =>
    opt
      .setName('event_id')
      .setDescription('Événement concerné (requis pour points/power)')
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('week')
      .setDescription(
        'Semaine concernée, lundi ISO (YYYY-MM-DD) — requis pour honor, défaut : semaine en cours',
      )
      .setRequired(false),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const alliance = await resolveAlliance(interaction.channelId);
  if (!alliance) {
    await interaction.respond([]);
    return;
  }

  if (focused.name === 'player') {
    await autocompletePlayer(interaction, alliance.id, focused.value);
    return;
  }
  if (focused.name === 'event_id') {
    await autocompleteEvent(interaction, alliance.id);
    return;
  }
  await interaction.respond([]);
}

async function autocompletePlayer(
  interaction: AutocompleteInteraction,
  allianceId: string,
  typed: string,
): Promise<void> {
  let query = supabase
    .from('at_players')
    .select('id, name')
    .eq('alliance_id', allianceId)
    .order('name')
    .limit(25);

  const trimmed = typed.trim();
  if (trimmed.length > 0) query = query.ilike('name', `%${escapeLike(trimmed)}%`);

  const { data, error } = await query;
  if (error) {
    logger.error({ err: String(error) }, 'player autocomplete query failed');
    await interaction.respond([]);
    return;
  }

  await interaction.respond(
    ((data ?? []) as PlayerRow[]).map((p) => ({ name: p.name, value: p.id })),
  );
}

type EventOption = {
  id: string;
  event_datetime: string;
  at_event_types: { display_name: string } | null;
};

async function autocompleteEvent(
  interaction: AutocompleteInteraction,
  allianceId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('at_events')
    .select('id, event_datetime, at_event_types(display_name)')
    .eq('alliance_id', allianceId)
    .order('event_datetime', { ascending: false })
    .limit(25);

  if (error) {
    logger.error({ err: String(error) }, 'event_id autocomplete query failed');
    await interaction.respond([]);
    return;
  }

  const rows = (data ?? []) as unknown as EventOption[];
  await interaction.respond(
    rows.map((e) => ({ name: formatEventOptionLabel(e), value: e.id })),
  );
}

function formatEventOptionLabel(e: EventOption): string {
  const dt = new Date(e.event_datetime).toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
  const typeName = e.at_event_types?.display_name ?? '?';
  return `${typeName} — ${dt}`.slice(0, 100);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const playerId = interaction.options.getString('player', true);
  const field = interaction.options.getString('field', true) as Field;
  const value = interaction.options.getInteger('value', true);
  const eventId = interaction.options.getString('event_id');
  const weekInput = interaction.options.getString('week');

  const player = await findPlayer(playerId, alliance.id);
  if (!player) {
    await interaction.editReply('❌ Joueur introuvable dans cette alliance. Utilisez les suggestions proposées.');
    return;
  }

  if (field === 'points' || field === 'power') {
    if (!eventId) {
      await interaction.editReply(
        '❌ `event_id` est requis pour corriger `points` ou `power`. Choisissez un événement dans les suggestions.',
      );
      return;
    }
    await correctParticipation(interaction, alliance, player, field, value, eventId);
    return;
  }

  let week: string;
  if (weekInput) {
    const snapped = parseWeekInput(weekInput);
    if (!snapped) {
      await interaction.editReply("❌ Format `week` attendu : `YYYY-MM-DD` (lundi de la semaine).");
      return;
    }
    week = snapped;
  } else {
    week = isoWeekStartParis(new Date());
  }
  await correctDonation(interaction, alliance, player, value, week);
}

async function findPlayer(playerId: string, allianceId: string): Promise<PlayerRow | null> {
  const { data, error } = await supabase
    .from('at_players')
    .select('id, name')
    .eq('id', playerId)
    .eq('alliance_id', allianceId)
    .maybeSingle();

  if (error) {
    if (error.code === INVALID_UUID_CODE) return null;
    throw error;
  }
  return data as PlayerRow | null;
}

async function correctParticipation(
  interaction: ChatInputCommandInteraction,
  alliance: AllianceRow,
  player: PlayerRow,
  field: 'points' | 'power',
  value: number,
  eventId: string,
): Promise<void> {
  const { data: eventRow, error: eventError } = await supabase
    .from('at_events')
    .select('id, event_datetime, at_event_types(display_name)')
    .eq('id', eventId)
    .eq('alliance_id', alliance.id)
    .maybeSingle();

  if (eventError) {
    if (eventError.code === INVALID_UUID_CODE) {
      await interaction.editReply('❌ Événement introuvable dans cette alliance. Utilisez les suggestions proposées.');
      return;
    }
    throw eventError;
  }
  if (!eventRow) {
    await interaction.editReply('❌ Événement introuvable dans cette alliance. Utilisez les suggestions proposées.');
    return;
  }
  const event = eventRow as unknown as EventOption;

  const { data: participationRow, error: partError } = await supabase
    .from('at_participations')
    .select('id')
    .eq('event_id', eventId)
    .eq('player_id', player.id)
    .maybeSingle();

  if (partError) throw partError;
  if (!participationRow) {
    await interaction.editReply(
      `❌ Aucune participation enregistrée pour **${player.name}** sur cet événement.`,
    );
    return;
  }
  const participation = participationRow as { id: string };

  const { oldValue, newValue } = await applyCorrection({
    targetTable: 'at_participations',
    targetId: participation.id,
    field,
    newValue: value,
    allianceId: alliance.id,
    playerId: player.id,
    correctedBy: interaction.user.id,
  });

  logger.info(
    { allianceId: alliance.id, playerId: player.id, eventId, field, oldValue, newValue },
    'Manual score correction applied (participation)',
  );

  await interaction.editReply({
    embeds: [
      buildCorrectionEmbed(
        player.name,
        field,
        oldValue,
        newValue,
        formatEventOptionLabel(event),
        interaction.user.id,
      ),
    ],
  });
}

async function correctDonation(
  interaction: ChatInputCommandInteraction,
  alliance: AllianceRow,
  player: PlayerRow,
  value: number,
  week: string,
): Promise<void> {
  const { data: periodRow, error: periodError } = await supabase
    .from('at_donation_periods')
    .select('id')
    .eq('alliance_id', alliance.id)
    .eq('period_type', 'weekly')
    .eq('period_start', week)
    .maybeSingle();

  if (periodError) throw periodError;
  if (!periodRow) {
    await interaction.editReply(`❌ Aucune période de dons \`${week}\` enregistrée pour cette alliance.`);
    return;
  }
  const period = periodRow as { id: string };

  const { data: donationRow, error: donationError } = await supabase
    .from('at_donations')
    .select('id')
    .eq('donation_period_id', period.id)
    .eq('player_id', player.id)
    .maybeSingle();

  if (donationError) throw donationError;
  if (!donationRow) {
    await interaction.editReply(
      `❌ Aucun don enregistré pour **${player.name}** sur la semaine \`${week}\`.`,
    );
    return;
  }
  const donation = donationRow as { id: string };

  const { oldValue, newValue } = await applyCorrection({
    targetTable: 'at_donations',
    targetId: donation.id,
    field: 'honor',
    newValue: value,
    allianceId: alliance.id,
    playerId: player.id,
    correctedBy: interaction.user.id,
  });

  logger.info(
    { allianceId: alliance.id, playerId: player.id, week, oldValue, newValue },
    'Manual score correction applied (donation)',
  );

  await interaction.editReply({
    embeds: [
      buildCorrectionEmbed(
        player.name,
        'honor',
        oldValue,
        newValue,
        `Semaine ${week}`,
        interaction.user.id,
      ),
    ],
  });
}

/**
 * Applies a correction via the `at_apply_correction` DB function (migration
 * 0023): reads the current value, writes the new one, and inserts the
 * at_corrections audit row, all inside one Postgres transaction. Replaces
 * what used to be a separate `.update()` + `.insert()` pair — that left a
 * window where the score changed but the audit insert could still fail,
 * leaving the correction applied-but-unaudited and poisoning old_value on
 * retry. The row-existence checks in correctParticipation/correctDonation
 * still run first so a genuinely missing target gets the friendly French
 * message instead of this function's generic "not found" error (P0002),
 * which is only reachable via a TOCTOU race (row deleted between that check
 * and this call) — rare enough not to special-case here.
 */
async function applyCorrection(params: {
  targetTable: 'at_participations' | 'at_donations';
  targetId: string;
  field: Field;
  newValue: number;
  allianceId: string;
  playerId: string;
  correctedBy: string;
}): Promise<{ oldValue: number | null; newValue: number }> {
  const { data, error } = await supabase
    .rpc('at_apply_correction', {
      p_target_table: params.targetTable,
      p_target_id: params.targetId,
      p_field: params.field,
      p_new_value: params.newValue,
      p_alliance_id: params.allianceId,
      p_player_id: params.playerId,
      p_corrected_by: params.correctedBy,
    })
    .single();

  if (error) throw new Error(`Failed to apply correction: ${error.message}`);
  const row = data as { old_value: number | null; new_value: number };
  return { oldValue: row.old_value, newValue: row.new_value };
}

function buildCorrectionEmbed(
  playerName: string,
  field: Field,
  oldValue: number | null,
  newValue: number,
  contextLabel: string,
  correctedByUserId: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('✏️ Correction appliquée')
    .setDescription(contextLabel)
    .addFields(
      { name: 'Joueur', value: playerName, inline: true },
      { name: 'Champ', value: field, inline: true },
      {
        name: 'Ancien → Nouveau',
        value: `${oldValue?.toLocaleString('fr-FR') ?? '—'} → **${newValue.toLocaleString('fr-FR')}**`,
      },
      { name: 'Par', value: `<@${correctedByUserId}>`, inline: true },
    )
    .setTimestamp();
}
