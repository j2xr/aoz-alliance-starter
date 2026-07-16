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
  .setDescription("Fiche d'un joueur : taux de participation, puissance, historique")
  .addStringOption((opt) =>
    opt
      .setName('name')
      .setDescription('Nom du joueur (partiel accepté, insensible à la casse)')
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
    await interaction.editReply('❌ Le nom doit faire entre 1 et 50 caractères.');
    return;
  }

  // Find players matching the name in this alliance
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
    .setDescription(`Alliance : **${alliance.name}**`);

  if (s) {
    const rate =
      s.participation_rate_pct != null
        ? `${s.participation_rate_pct}%`
        : 'N/A';
    const power =
      s.last_power != null ? s.last_power.toLocaleString('fr-FR') : '—';
    const totalPts =
      s.total_points != null ? s.total_points.toLocaleString('fr-FR') : '—';
    const avgPts = s.avg_points_per_event != null ? String(s.avg_points_per_event) : '—';
    const best =
      s.best_score != null ? s.best_score.toLocaleString('fr-FR') : '—';

    embed.addFields(
      { name: 'Taux de participation', value: rate, inline: true },
      {
        name: 'Événements',
        value: `${s.events_participated}/${s.eligible_events}`,
        inline: true,
      },
      { name: 'Rang', value: s.last_rank ?? '—', inline: true },
      { name: 'Puissance', value: power, inline: true },
      { name: 'Points totaux', value: totalPts, inline: true },
      { name: 'Moy. / événement', value: avgPts, inline: true },
      { name: 'Meilleur score', value: best, inline: true },
    );
  } else {
    embed.addFields({ name: 'Statistiques', value: 'Aucune donnée.' });
  }

  if (recentRows.length > 0) {
    const lines = recentRows.map((r) => {
      const dt = r.at_events
        ? new Date(r.at_events.event_datetime).toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            timeZone: 'Europe/Paris',
          })
        : '?';
      const typeName = r.at_events?.at_event_types?.display_name ?? '?';
      const pts = r.points != null ? r.points.toLocaleString('fr-FR') : '—';
      const pwr =
        r.power != null ? ` · ${r.power.toLocaleString('fr-FR')}` : '';
      const rank = r.player_rank ? ` (${r.player_rank})` : '';
      return `${dt} — ${typeName}${rank} : **${pts} pts**${pwr}`;
    });
    embed.addFields({ name: '📅 5 dernières participations', value: lines.join('\n') });
  }

  await interaction.editReply({ embeds: [embed] });
}
