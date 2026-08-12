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
// Cap for the /event incomplete worklist. It's a to-do list, not an archive:
// a maintainer fixes the top offenders and re-runs it, so a fixed ceiling with
// an "N of M" hint beats paginating a list that should be shrinking.
const INCOMPLETE_LIMIT = 15;

export const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Event management')
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription("List the latest event occurrences for this channel's alliance")
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Type code (e.g. polar_invasion). Default: all types.')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('incomplete')
      .setDescription('Boards where fewer rows were imported than the game reported (missing pages)'),
  );

// Both subcommands read at_v_event_import_delta (migration 0025): it exposes the
// game-declared battler count (official_battlers) next to how many rows actually
// landed in at_participations (imported_players), so completeness is a property
// of the accumulated event — correct even across a multi-screenshot scroll.
type EventRow = {
  event_id: string;
  event_datetime: string;
  event_type_code: string | null;
  event_type: string | null;
  alliance_rank: number | null;
  official_battlers: number | null;
  imported_players: number;
  battlers_delta: number | null;
  battlers_coverage_pct: number | null;
  official_points: number | null;
};

type IncompleteRow = {
  event_id: string;
  event_datetime: string;
  event_type: string | null;
  official_battlers: number | null;
  imported_players: number;
  battlers_delta: number | null;
  battlers_coverage_pct: number | null;
  needs_review_rows: number;
};

type RenderResult =
  | { content: string; components: ActionRowBuilder<ButtonBuilder>[] }
  | { error: string };

function formatDt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
}

// battlers_delta = official - imported (0025 sign convention): positive means
// rows are missing. Flag those; show a plain count when the import is complete
// or the header battler count was unreadable (delta NULL → cannot judge).
function battlersLabel(e: EventRow): string {
  if (e.official_battlers == null) return '— battlers';
  if (e.battlers_delta != null && e.battlers_delta > 0) {
    const pct = e.battlers_coverage_pct != null ? ` (${e.battlers_coverage_pct}%)` : '';
    return `⚠️ ${e.imported_players}/${e.official_battlers} battlers${pct}`;
  }
  return `${e.official_battlers} battlers`;
}

export async function renderEventList(
  allianceId: string,
  page: number,
  etCode: string | null,
): Promise<RenderResult> {
  if (etCode) {
    // Validate the type code up front so a typo gets a clear error instead of
    // silently filtering to an empty list.
    const { data: et } = await supabase
      .from('at_event_types')
      .select('id')
      .eq('code', etCode)
      .maybeSingle();
    if (!et) return { error: `Unknown event type: \`${etCode}\`` };
  }

  let query = supabase
    .from('at_v_event_import_delta')
    .select(
      'event_id, event_datetime, event_type_code, event_type, alliance_rank, official_battlers, imported_players, battlers_delta, battlers_coverage_pct, official_points',
      { count: 'exact' },
    )
    .eq('alliance_id', allianceId)
    .order('event_datetime', { ascending: false })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

  if (etCode) query = query.eq('event_type_code', etCode);

  const { data: events, error, count } = await query;
  if (error) throw error;

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const rows = (events ?? []) as unknown as EventRow[];

  if (rows.length === 0) {
    return { content: '📭 No events found.', components: [] };
  }

  const lines = rows.map((e) => {
    const dt = formatDt(e.event_datetime);
    const typeName = e.event_type ?? '?';
    const rank = e.alliance_rank != null ? `#${e.alliance_rank}` : '—';
    const pts =
      e.official_points != null ? e.official_points.toLocaleString('en-GB') : '—';
    const shortId = e.event_id.slice(0, 8);
    return `**${typeName}** — ${dt}\n  Rank ${rank} · ${battlersLabel(e)} · ${pts} pts · \`${shortId}\``;
  });

  const etSafe = etCode ?? '-';
  const prevId = `el|${allianceId}|${page - 1}|${etSafe}`;
  const nextId = `el|${allianceId}|${page + 1}|${etSafe}`;

  const content = `**Events — Page ${page + 1}/${totalPages}**\n\n${lines.join('\n\n')}`;
  const components =
    totalPages > 1 ? [paginationRow(prevId, nextId, page, totalPages)] : [];

  return { content, components };
}

export async function renderIncompleteList(allianceId: string): Promise<RenderResult> {
  const {
    data,
    error,
    count,
  } = await supabase
    .from('at_v_event_import_delta')
    .select(
      'event_id, event_datetime, event_type, official_battlers, imported_players, battlers_delta, battlers_coverage_pct, needs_review_rows',
      { count: 'exact' },
    )
    .eq('alliance_id', allianceId)
    // delta NULL (unreadable header) is not > 0, so those are excluded: we only
    // flag boards we can actually judge as short.
    .gt('battlers_delta', 0)
    .order('event_datetime', { ascending: false })
    .range(0, INCOMPLETE_LIMIT - 1);

  if (error) throw error;

  const rows = (data ?? []) as unknown as IncompleteRow[];
  if (rows.length === 0) {
    return {
      content:
        '✅ No incomplete boards — every event imported as many rows as the game reported.',
      components: [],
    };
  }

  const lines = rows.map((e) => {
    const dt = formatDt(e.event_datetime);
    const typeName = e.event_type ?? '?';
    const pct = e.battlers_coverage_pct != null ? ` (${e.battlers_coverage_pct}%)` : '';
    const nr = e.needs_review_rows > 0 ? ` · ${e.needs_review_rows} low-conf` : '';
    const shortId = e.event_id.slice(0, 8);
    return `**${typeName}** — ${dt}\n  ⚠️ ${e.imported_players}/${e.official_battlers} battlers${pct} · missing ${e.battlers_delta}${nr} · \`${shortId}\``;
  });

  const total = count ?? rows.length;
  const heading =
    total > rows.length
      ? `**Incomplete boards — ${rows.length} of ${total}**`
      : `**Incomplete boards — ${total}**`;
  const tip =
    '\n\n_Missing rows = a page was never captured or a row was unreadable. Re-capture and `/upload`, or `/reprocess` the message to re-read._';

  return {
    content: `${heading} (imported rows < battlers the game reported)\n\n${lines.join('\n\n')}${tip}`,
    components: [],
  };
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'list' && sub !== 'incomplete') return;

  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  if (sub === 'incomplete') {
    const result = await renderIncompleteList(alliance.id);
    await interaction.editReply(
      'error' in result ? result.error : { content: result.content, components: result.components },
    );
    return;
  }

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
