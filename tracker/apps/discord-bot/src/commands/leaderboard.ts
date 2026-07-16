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
import { escapeLike } from '../lib/escape.js';
import { paginationRow } from '../lib/paginate.js';
import logger from '../logger.js';

const PAGE_SIZE = 10;

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription("Classement d'un événement")
  .addStringOption((opt) =>
    opt
      .setName('event_id')
      .setDescription(
        "ID de l'événement (8 premiers chars suffisent, affiché par /event list). Défaut : plus récent.",
      )
      .setRequired(false),
  );

type LeaderboardRow = {
  player_name: string;
  player_rank: string | null;
  power: number | null;
  points: number;
  position: number;
};

type EventMeta = {
  id: string;
  event_datetime: string;
  alliance_rank: number | null;
  total_battlers: number | null;
  total_points: number | null;
  at_event_types: { display_name: string } | null;
};

type RenderResult =
  | { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }
  | { error: string };

async function resolveEventId(
  allianceId: string,
  rawId: string | null,
): Promise<string | null> {
  if (!rawId) {
    // Most recent event for this alliance
    const { data } = await supabase
      .from('at_events')
      .select('id')
      .eq('alliance_id', allianceId)
      .order('event_datetime', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ? (data as { id: string }).id : null;
  }

  // Accept prefix: LIKE 'prefix%'
  const { data } = await supabase
    .from('at_events')
    .select('id')
    .eq('alliance_id', allianceId)
    .like('id', `${escapeLike(rawId)}%`)
    .limit(1)
    .maybeSingle();
  return data ? (data as { id: string }).id : null;
}

export async function renderLeaderboard(
  eventId: string,
  page: number,
): Promise<RenderResult> {
  // Fetch event metadata
  const { data: eventData, error: evErr } = await supabase
    .from('at_events')
    .select('id, event_datetime, alliance_rank, total_battlers, total_points, at_event_types(display_name)')
    .eq('id', eventId)
    .maybeSingle();

  if (evErr) throw evErr;
  if (!eventData) return { error: `Événement introuvable.` };

  const ev = eventData as unknown as EventMeta;

  // Fetch leaderboard rows paginated
  const { data: rows, error: lbErr, count } = await supabase
    .from('at_v_event_leaderboard')
    .select('player_name, player_rank, power, points, position', {
      count: 'exact',
    })
    .eq('event_id', eventId)
    .order('position', { ascending: true })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

  if (lbErr) throw lbErr;

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const lbRows = (rows ?? []) as LeaderboardRow[];

  const dt = new Date(ev.event_datetime).toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
  const typeName = ev.at_event_types?.display_name ?? '?';

  const medals = ['🥇', '🥈', '🥉'];
  const lines = lbRows.map((r) => {
    const pos = r.position;
    const prefix = pos <= 3 ? (medals[pos - 1] ?? `**${pos}.**`) : `**${pos}.**`;
    const pts = r.points != null ? r.points.toLocaleString('fr-FR') : '—';
    const pwr = r.power != null ? ` · ${r.power.toLocaleString('fr-FR')}` : '';
    const rank = r.player_rank ? ` (${r.player_rank})` : '';
    return `${prefix} ${r.player_name}${rank} — ${pts} pts${pwr}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏆 ${typeName} — ${dt}`)
    .addFields(
      { name: 'Rang alliance', value: ev.alliance_rank != null ? `#${ev.alliance_rank}` : '—', inline: true },
      { name: 'Battlers', value: String(ev.total_battlers ?? '—'), inline: true },
      { name: 'Points totaux', value: ev.total_points != null ? ev.total_points.toLocaleString('fr-FR') : '—', inline: true },
    )
    .setDescription(lines.join('\n') || '—')
    .setFooter({ text: `Page ${page + 1}/${totalPages} · ID ${eventId.slice(0, 8)}` });

  const prevId = `lb|${eventId}|${page - 1}`;
  const nextId = `lb|${eventId}|${page + 1}`;
  const components =
    totalPages > 1 ? [paginationRow(prevId, nextId, page, totalPages)] : [];

  return { embeds: [embed], components };
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const rawId = interaction.options.getString('event_id');
  const eventId = await resolveEventId(alliance.id, rawId);

  if (!eventId) {
    await interaction.editReply(
      rawId
        ? `❌ Aucun événement trouvé avec l'ID \`${rawId}\`.`
        : "❌ Aucun événement disponible pour cette alliance.",
    );
    return;
  }

  const result = await renderLeaderboard(eventId, 0);
  if ('error' in result) {
    await interaction.editReply(result.error);
    return;
  }
  await interaction.editReply(result);
}

// customId format: lb|<eventId>|<page>
export async function handleButton(
  interaction: ButtonInteraction,
  parts: string[],
): Promise<void> {
  const eventId = parts[1];
  const page = parseInt(parts[2] ?? '0', 10);

  if (!eventId) {
    logger.warn({ parts }, 'leaderboard button: missing eventId');
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();
  const result = await renderLeaderboard(eventId, page);
  if ('error' in result) {
    await interaction.editReply({ content: result.error, components: [] });
    return;
  }
  await interaction.editReply(result);
}
