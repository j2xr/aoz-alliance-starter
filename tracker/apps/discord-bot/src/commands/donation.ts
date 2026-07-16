import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ActionRowBuilder,
  type ButtonBuilder,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance } from '../lib/alliance.js';
import { resolvePlayerByName } from '../lib/players.js';
import { paginationRow } from '../lib/paginate.js';
import { isoWeekStartParis } from '../lib/period.js';
import logger from '../logger.js';

const PAGE_SIZE = 10;

export const data = new SlashCommandBuilder()
  .setName('donation')
  .setDescription("Suivi des dons hebdomadaires (Alliance Honor)")
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('Classement des dons pour une semaine')
      .addStringOption((opt) =>
        opt
          .setName('period_start')
          .setDescription('Lundi de la semaine (YYYY-MM-DD). Défaut : semaine en cours.')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('player')
      .setDescription('Historique de dons d\'un joueur')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Nom du joueur (partiel accepté, insensible à la casse)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Liste des semaines connues pour cette alliance')
      .addIntegerOption((opt) =>
        opt
          .setName('limit')
          .setDescription('Nombre de semaines à afficher (défaut : 5, max 20)')
          .setMinValue(1)
          .setMaxValue(20)
          .setRequired(false),
      ),
  );

type LeaderboardRow = {
  player_name: string;
  player_rank: string | null;
  alliance_honor: number;
  position: number;
  updated_at: string;
};

type PeriodRow = {
  id: string;
  period_start: string;
  period_end: string;
};

const PERIOD_DATE_LABEL: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
};

function formatPeriodLabel(start: string, end: string): string {
  // Dates are stored as YYYY-MM-DD (timestamptz-free); anchor AND format in
  // UTC so the label never shifts by a day, whatever the host timezone or the
  // season (a fixed +02:00 anchor rendered in Europe/Paris showed the previous
  // day in winter, when Paris is +01:00).
  const startLabel = new Date(`${start}T00:00:00Z`).toLocaleDateString('fr-FR', PERIOD_DATE_LABEL);
  const endLabel = new Date(`${end}T00:00:00Z`).toLocaleDateString('fr-FR', PERIOD_DATE_LABEL);
  return `du ${startLabel} au ${endLabel}`;
}

async function resolvePeriodId(
  allianceId: string,
  periodStart: string | null,
): Promise<PeriodRow | null> {
  if (periodStart) {
    const { data } = await supabase
      .from('at_donation_periods')
      .select('id, period_start, period_end')
      .eq('alliance_id', allianceId)
      .eq('period_type', 'weekly')
      .eq('period_start', periodStart)
      .maybeSingle();
    return data ? (data as PeriodRow) : null;
  }

  const currentStart = isoWeekStartParis(new Date());
  const { data: current } = await supabase
    .from('at_donation_periods')
    .select('id, period_start, period_end')
    .eq('alliance_id', allianceId)
    .eq('period_type', 'weekly')
    .eq('period_start', currentStart)
    .maybeSingle();
  if (current) return current as PeriodRow;

  // Fall back to the most recent known period if the current week has no data yet.
  const { data: latest } = await supabase
    .from('at_donation_periods')
    .select('id, period_start, period_end')
    .eq('alliance_id', allianceId)
    .eq('period_type', 'weekly')
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle();
  return latest ? (latest as PeriodRow) : null;
}

type RenderResult =
  | { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }
  | { error: string };

async function renderLeaderboard(period: PeriodRow, page: number): Promise<RenderResult> {
  const { data: rows, error: lbErr, count } = await supabase
    .from('at_v_donation_leaderboard')
    .select('player_name, player_rank, alliance_honor, position, updated_at', {
      count: 'exact',
    })
    .eq('donation_period_id', period.id)
    .order('position', { ascending: true })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

  if (lbErr) throw lbErr;

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const lbRows = (rows ?? []) as LeaderboardRow[];

  const medals = ['🥇', '🥈', '🥉'];
  const lines = lbRows.map((r) => {
    const pos = r.position;
    const prefix = pos <= 3 ? (medals[pos - 1] ?? `**${pos}.**`) : `**${pos}.**`;
    const rank = r.player_rank ? ` (${r.player_rank})` : '';
    return `${prefix} ${r.player_name}${rank} — ${r.alliance_honor.toLocaleString('fr-FR')}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xb59f3b)
    .setTitle(`🎁 Dons Alliance Honor — ${formatPeriodLabel(period.period_start, period.period_end)}`)
    .setDescription(lines.join('\n') || '—')
    .setFooter({ text: `Page ${page + 1}/${totalPages} · Semaine ${period.period_start}` });

  const prevId = `dlb|${period.id}|${page - 1}`;
  const nextId = `dlb|${period.id}|${page + 1}`;
  const components =
    totalPages > 1 ? [paginationRow(prevId, nextId, page, totalPages)] : [];

  return { embeds: [embed], components };
}

async function executeLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const periodStart = interaction.options.getString('period_start');
  if (periodStart && !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
    await interaction.editReply("❌ Format `period_start` attendu : `YYYY-MM-DD` (lundi de la semaine).");
    return;
  }

  const period = await resolvePeriodId(alliance.id, periodStart);
  if (!period) {
    await interaction.editReply(
      periodStart
        ? `❌ Aucune période \`${periodStart}\` enregistrée pour cette alliance.`
        : "❌ Aucune période de don enregistrée pour cette alliance.",
    );
    return;
  }

  const result = await renderLeaderboard(period, 0);
  if ('error' in result) {
    await interaction.editReply(result.error);
    return;
  }
  await interaction.editReply(result);
}

type DonationPlayerStat = {
  player_id: string;
  name: string;
  periods_contributed: number;
  total_alliance_honor: number;
  best_period_honor: number | null;
  avg_per_period: number;
  last_period_start: string | null;
};

type RecentDonation = {
  alliance_honor: number;
  player_rank: string | null;
  updated_at: string;
  at_donation_periods: { period_start: string; period_end: string } | null;
};

async function executePlayer(interaction: ChatInputCommandInteraction): Promise<void> {
  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const name = interaction.options.getString('name', true);
  if (name.trim().length === 0 || name.length > 50) {
    await interaction.editReply('❌ Le nom doit faire entre 1 et 50 caractères.');
    return;
  }
  const lookup = await resolvePlayerByName(alliance.id, name, { match: 'partial' });

  if (lookup.status === 'none') {
    await interaction.editReply(
      `❌ Aucun joueur trouvé pour \`${name}\` dans l'alliance **${alliance.name}**.`,
    );
    return;
  }

  if (lookup.status === 'ambiguous') {
    const list = lookup.candidates.map((p) => `• ${p.name}`).join('\n');
    await interaction.editReply(
      `Plusieurs joueurs correspondent à \`${name}\`. Précisez le nom :\n${list}`,
    );
    return;
  }
  const player = lookup.player;

  const { data: stats, error: statsError } = await supabase
    .from('at_v_donation_player_totals')
    .select('*')
    .eq('player_id', player.id)
    .maybeSingle();

  if (statsError) throw statsError;

  const { data: recent, error: recentError } = await supabase
    .from('at_donations')
    .select(
      'alliance_honor, player_rank, updated_at, at_donation_periods(period_start, period_end)',
    )
    .eq('player_id', player.id)
    .order('updated_at', { ascending: false })
    .limit(5);

  if (recentError) throw recentError;

  const s = stats as DonationPlayerStat | null;
  const recentRows = (recent ?? []) as unknown as RecentDonation[];

  const embed = new EmbedBuilder()
    .setColor(0xb59f3b)
    .setTitle(`🎁 ${player.name} — Dons`)
    .setDescription(`Alliance : **${alliance.name}**`);

  if (s && s.periods_contributed > 0) {
    embed.addFields(
      { name: 'Semaines contribuées', value: String(s.periods_contributed), inline: true },
      {
        name: 'Honor cumulé',
        value: s.total_alliance_honor.toLocaleString('fr-FR'),
        inline: true,
      },
      {
        name: 'Meilleure semaine',
        value: s.best_period_honor != null ? s.best_period_honor.toLocaleString('fr-FR') : '—',
        inline: true,
      },
      {
        name: 'Moyenne / semaine',
        value: s.avg_per_period.toLocaleString('fr-FR'),
        inline: true,
      },
    );
  } else {
    embed.addFields({ name: 'Statistiques', value: 'Aucune donation enregistrée.' });
  }

  if (recentRows.length > 0) {
    const lines = recentRows.map((r) => {
      const period = r.at_donation_periods;
      const label = period
        ? formatPeriodLabel(period.period_start, period.period_end)
        : '?';
      const rank = r.player_rank ? ` (${r.player_rank})` : '';
      return `${label}${rank} — **${r.alliance_honor.toLocaleString('fr-FR')}**`;
    });
    embed.addFields({ name: '📅 5 dernières semaines', value: lines.join('\n') });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function executeList(interaction: ChatInputCommandInteraction): Promise<void> {
  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const limit = interaction.options.getInteger('limit') ?? 5;

  const { data: rows, error } = await supabase
    .from('at_donation_periods')
    .select('id, period_start, period_end')
    .eq('alliance_id', alliance.id)
    .eq('period_type', 'weekly')
    .order('period_start', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const periods = (rows ?? []) as PeriodRow[];
  if (periods.length === 0) {
    await interaction.editReply("❌ Aucune période de don enregistrée pour cette alliance.");
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xb59f3b)
    .setTitle(`📅 Périodes de dons — ${alliance.name}`)
    .setDescription(
      periods
        .map((p) => `• ${formatPeriodLabel(p.period_start, p.period_end)}  \`${p.period_start}\``)
        .join('\n'),
    );

  await interaction.editReply({ embeds: [embed] });
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();
  if (sub === 'leaderboard') return executeLeaderboard(interaction);
  if (sub === 'player') return executePlayer(interaction);
  if (sub === 'list') return executeList(interaction);
  await interaction.editReply(`❌ Sous-commande inconnue : \`${sub}\`.`);
}

// customId format: dlb|<periodId>|<page>
export async function handleButton(
  interaction: ButtonInteraction,
  parts: string[],
): Promise<void> {
  const periodId = parts[1];
  const page = parseInt(parts[2] ?? '0', 10);

  if (!periodId) {
    logger.warn({ parts }, 'donation button: missing periodId');
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();

  const { data: periodRow, error } = await supabase
    .from('at_donation_periods')
    .select('id, period_start, period_end')
    .eq('id', periodId)
    .maybeSingle();

  if (error || !periodRow) {
    await interaction.editReply({ content: '❌ Période introuvable.', components: [] });
    return;
  }

  const result = await renderLeaderboard(periodRow as PeriodRow, page);
  if ('error' in result) {
    await interaction.editReply({ content: result.error, components: [] });
    return;
  }
  await interaction.editReply(result);
}
