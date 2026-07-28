import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance } from '../lib/alliance.js';
import { resolvePlayerByName } from '../lib/players.js';

export const data = new SlashCommandBuilder()
  .setName('player')
  .setDescription("A player's profile: participation rate, power, history")
  .addStringOption((opt) =>
    opt
      .setName('name')
      .setDescription('Player name (partial accepted, case-insensitive)')
      .setRequired(true),
  );

type PlayerStatRow = {
  player_id: string;
  name: string;
  last_power: number | null;
  last_rank: string | null;
  eligible_events: number;
  events_participated: number;
  participation_rate_pct: number | null;
  total_points: number | null;
  avg_points_per_event: number | null;
  best_score: number | null;
  last_participation: string | null;
};

type RecentParticipation = {
  points: number;
  power: number | null;
  player_rank: string | null;
  at_events: {
    event_datetime: string;
    at_event_types: { display_name: string } | null;
  } | null;
};

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const name = interaction.options.getString('name', true);
  if (name.trim().length === 0 || name.length > 50) {
    await interaction.editReply('❌ The name must be between 1 and 50 characters.');
    return;
  }

  // Find players matching the name in this alliance
  const lookup = await resolvePlayerByName(alliance.id, name, { match: 'partial' });

  if (lookup.status === 'none') {
    await interaction.editReply(
      `❌ No player found for \`${name}\` in alliance **${alliance.name}**.`,
    );
    return;
  }

  if (lookup.status === 'ambiguous') {
    const list = lookup.candidates.map((p) => `• ${p.name}`).join('\n');
    await interaction.editReply(
      `Multiple players match \`${name}\`. Specify the name:\n${list}`,
    );
    return;
  }

  const player = lookup.player;

  // Fetch stats from the participation rate view
  const { data: stats, error: statsError } = await supabase
    .from('at_v_player_participation_rate')
    .select('*')
    .eq('player_id', player.id)
    .maybeSingle();

  if (statsError) throw statsError;

  // Fetch last 5 participations
  const { data: recent, error: recentError } = await supabase
    .from('at_participations')
    .select(
      'points, power, player_rank, at_events(event_datetime, at_event_types(display_name))',
    )
    .eq('player_id', player.id)
    .order('created_at', { ascending: false })
    .limit(5);

  if (recentError) throw recentError;

  const s = stats as PlayerStatRow | null;
  const recentRows = (recent ?? []) as unknown as RecentParticipation[];

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`👤 ${player.name}`)
    .setDescription(`Alliance: **${alliance.name}**`);

  if (s) {
    const rate =
      s.participation_rate_pct != null
        ? `${s.participation_rate_pct}%`
        : 'N/A';
    const power =
      s.last_power != null ? s.last_power.toLocaleString('en-GB') : '—';
    const totalPts =
      s.total_points != null ? s.total_points.toLocaleString('en-GB') : '—';
    const avgPts = s.avg_points_per_event != null ? String(s.avg_points_per_event) : '—';
    const best =
      s.best_score != null ? s.best_score.toLocaleString('en-GB') : '—';

    embed.addFields(
      { name: 'Participation rate', value: rate, inline: true },
      {
        name: 'Events',
        value: `${s.events_participated}/${s.eligible_events}`,
        inline: true,
      },
      { name: 'Rank', value: s.last_rank ?? '—', inline: true },
      { name: 'Power', value: power, inline: true },
      { name: 'Total points', value: totalPts, inline: true },
      { name: 'Avg. / event', value: avgPts, inline: true },
      { name: 'Best score', value: best, inline: true },
    );
  } else {
    embed.addFields({ name: 'Statistics', value: 'No data.' });
  }

  if (recentRows.length > 0) {
    const lines = recentRows.map((r) => {
      const dt = r.at_events
        ? new Date(r.at_events.event_datetime).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            timeZone: 'Europe/Paris',
          })
        : '?';
      const typeName = r.at_events?.at_event_types?.display_name ?? '?';
      const pts = r.points != null ? r.points.toLocaleString('en-GB') : '—';
      const pwr =
        r.power != null ? ` · ${r.power.toLocaleString('en-GB')}` : '';
      const rank = r.player_rank ? ` (${r.player_rank})` : '';
      return `${dt} — ${typeName}${rank}: **${pts} pts**${pwr}`;
    });
    embed.addFields({ name: '📅 Last 5 participations', value: lines.join('\n') });
  }

  await interaction.editReply({ embeds: [embed] });
}
