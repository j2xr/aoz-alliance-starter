import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ActionRowBuilder,
  type ButtonBuilder,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance } from '../lib/alliance.js';
import { paginationRow } from '../lib/paginate.js';
import logger from '../logger.js';

const PAGE_SIZE = 8;

export const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Gestion des événements')
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription("Liste des dernières occurrences d'événements pour l'alliance de ce channel")
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Code du type (ex: polar_invasion). Défaut: tous les types.')
          .setRequired(false),
      ),
  );

type EventRow = {
  id: string;
  event_datetime: string;
  alliance_rank: number | null;
  total_battlers: number | null;
  total_points: number | null;
  at_event_types: { code: string; display_name: string } | null;
};

type RenderResult =
  | { content: string; components: ActionRowBuilder<ButtonBuilder>[] }
  | { error: string };

export async function renderEventList(
  allianceId: string,
  page: number,
  etCode: string | null,
): Promise<RenderResult> {
  let etId: string | null = null;
  if (etCode) {
    const { data: et } = await supabase
      .from('at_event_types')
      .select('id')
      .eq('code', etCode)
      .maybeSingle();
    if (!et) return { error: `Type d'événement inconnu : \`${etCode}\`` };
    etId = (et as { id: string }).id;
  }

  let query = supabase
    .from('at_events')
    .select(
      'id, event_datetime, alliance_rank, total_battlers, total_points, at_event_types(code, display_name)',
      { count: 'exact' },
    )
    .eq('alliance_id', allianceId)
    .order('event_datetime', { ascending: false })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

  if (etId) query = query.eq('event_type_id', etId);

  const { data: events, error, count } = await query;
  if (error) throw error;

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const rows = (events ?? []) as unknown as EventRow[];

  if (rows.length === 0) {
    return { content: '📭 Aucun événement trouvé.', components: [] };
  }

  const lines = rows.map((e) => {
    const dt = new Date(e.event_datetime).toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    });
    const typeName = e.at_event_types?.display_name ?? '?';
    const rank = e.alliance_rank != null ? `#${e.alliance_rank}` : '—';
    const battlers = e.total_battlers ?? '—';
    const pts =
      e.total_points != null ? e.total_points.toLocaleString('fr-FR') : '—';
    const shortId = e.id.slice(0, 8);
    return `**${typeName}** — ${dt}\n  Rang ${rank} · ${battlers} battlers · ${pts} pts · \`${shortId}\``;
  });

  const etSafe = etCode ?? '-';
  const prevId = `el|${allianceId}|${page - 1}|${etSafe}`;
  const nextId = `el|${allianceId}|${page + 1}|${etSafe}`;

  const content = `**Événements — Page ${page + 1}/${totalPages}**\n\n${lines.join('\n\n')}`;
  const components =
    totalPages > 1 ? [paginationRow(prevId, nextId, page, totalPages)] : [];

  return { content, components };
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.options.getSubcommand() !== 'list') return;

  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const etCode = interaction.options.getString('type');
  const result = await renderEventList(alliance.id, 0, etCode);
  if ('error' in result) {
    await interaction.editReply(result.error);
    return;
  }
  await interaction.editReply({
    content: result.content,
    components: result.components,
  });
}

// customId format: el|<allianceId>|<page>|<etCode|->
export async function handleButton(
  interaction: ButtonInteraction,
  parts: string[],
): Promise<void> {
  const allianceId = parts[1];
  const page = parseInt(parts[2] ?? '0', 10);
  const etCode = parts[3] === '-' ? null : (parts[3] ?? null);

  if (!allianceId) {
    logger.warn({ parts }, 'event button: missing allianceId');
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();
  const result = await renderEventList(allianceId, page, etCode);
  if ('error' in result) {
    await interaction.editReply({ content: result.error, components: [] });
    return;
  }
  await interaction.editReply({
    content: result.content,
    components: result.components,
  });
}
