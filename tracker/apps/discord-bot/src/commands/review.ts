// /review — the human-in-the-loop surface for the OCR quality flag.
//
// needs_review (migration 0021) has been written by the pipeline for a long
// time — low OCR confidence, and since Q3 also a NEW name that closely
// resembles an ESTABLISHED roster player (a likely misread the confidence gate
// misses). Migration 0026 unified both tables into at_v_needs_review, but until
// now NOTHING read that view and NOTHING ever cleared the flag: flagged rows
// just accumulated, invisible. This closes that loop —
//   • /review list   — the full worklist (paginated), each row annotated with
//                       the action that fixes it;
//   • /review names   — the Q3/Q4 slice: rows whose name resembles an
//                       established player, with the /merge that reconciles it;
//   • /review resolve — mark one row reviewed (clear the flag) so the list can
//                       actually shrink. This is the "confirm it's fine as-is"
//                       action; a genuine misread is fixed with /merge instead.
//
// Read-mostly and never rewrites an identity itself: it *suggests* /merge and
// /correct (the only tools that write player data, after a human looks at the
// screenshot). resolve only flips the boolean.

import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ActionRowBuilder,
  type ButtonBuilder,
} from 'discord.js';
import { supabase } from '../lib/supabase.js';
import { requireAlliance, resolveAlliance } from '../lib/alliance.js';
import { paginationRow } from '../lib/paginate.js';
import { capDiscordContent } from '../lib/discord-limits.js';
import {
  findRosterCollisions,
  ESTABLISHED_CAPTURE_COUNT,
  type NameComparison,
} from '../lib/duplicate-scan.js';
import type { RosterPlayer } from '../lib/name-resolve.js';
import logger from '../logger.js';

const PAGE_SIZE = 8;
// /review names is a shrinking to-do list, not an archive (same rationale as
// /event incomplete): show the most recent offenders, cap the display, and
// scan only a bounded recent window so the client-side resemblance check stays
// cheap on an alliance with a large flagged backlog.
const NAMES_LIMIT = 15;
const NAMES_SCAN_WINDOW = 300;
// A row_id prefix must be at least this long to resolve, so a short typo can't
// accidentally match (and clear) an unintended row.
const MIN_ID_PREFIX = 6;

type ReviewKind = 'participation' | 'donation';

type ReviewRow = {
  kind: ReviewKind;
  row_id: string;
  player_id: string;
  player_name: string;
  ocr_confidence: number | null;
  occurred_at: string;
  context_label: string;
  value: number | null;
  value_label: string;
};

const VIEW_COLUMNS =
  'kind, row_id, player_id, player_name, ocr_confidence, occurred_at, context_label, value, value_label';

export const data = new SlashCommandBuilder()
  .setName('review')
  .setDescription('Work through rows the OCR flagged for review')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // same guard as /correct, /merge
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('All rows flagged needs_review (most recent first)'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('names')
      .setDescription('Flagged rows whose name resembles an established player — likely misreads to merge'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('resolve')
      .setDescription('Mark one flagged row as reviewed (clears its needs_review flag)')
      .addStringOption((opt) =>
        opt
          .setName('id')
          .setDescription('Row id (or a unique leading part of it) shown in /review')
          .setRequired(true),
      ),
  );

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatValue(row: ReviewRow): string {
  const v = row.value == null ? '—' : row.value.toLocaleString('en-GB');
  return `${v} ${row.value_label}`;
}

// The flag has more than one meaning; say which so the reviewer picks the right
// fix. The sentinels mirror upsert.ts / the ocr-service: -1 = an accepted LLM
// name correction (only flagged when REVIEW_LLM_CORRECTIONS is on), 0 = a
// rejected LLM read / notification-banner row, [0,0.5) = genuinely low OCR
// confidence. A high confidence here means Q3 flagged it as a suspected misread
// of an established player despite a confident read.
function confidenceLabel(c: number | null): string {
  if (c == null) return 'flagged';
  if (c === -1) return 'LLM-corrected name';
  if (c === 0) return 'rejected/banner read';
  if (c < 0.5) return `low confidence ${c.toFixed(2)}`;
  return `confident read ${c.toFixed(2)} — suspected misread`;
}

// A flagged player whose name closely resembles a DIFFERENT, established roster
// player (seen >= ESTABLISHED_CAPTURE_COUNT captures). That established spelling
// is the likely-correct canonical to merge this row into — the exact case Q3
// flags and the reason /review names exists.
type EstablishedMatch = { name: string; occurrences: number; comparison: NameComparison };

function establishedNearMatch(
  row: ReviewRow,
  roster: RosterPlayer[],
  freqById: Map<string, number>,
): EstablishedMatch | null {
  const collisions = findRosterCollisions(row.player_name, row.player_id, roster);
  let best: EstablishedMatch | null = null;
  for (const c of collisions) {
    const occurrences = freqById.get(c.player.id) ?? 0;
    if (occurrences < ESTABLISHED_CAPTURE_COUNT) continue;
    // Prefer the most-seen spelling; on a tie, the closer name.
    if (
      !best ||
      occurrences > best.occurrences ||
      (occurrences === best.occurrences && c.comparison.similarity > best.comparison.similarity)
    ) {
      best = { name: c.player.name, occurrences, comparison: c.comparison };
    }
  }
  return best;
}

// One fix hint per row: a name resembling an established player is a merge job
// (identity), everything else is a value fix (/correct, or /reprocess-line to
// re-read the row with the LLM).
function actionHint(match: EstablishedMatch | null, playerName: string): string {
  if (match) {
    return `↔ likely misread of \`${match.name}\` (seen ${match.occurrences}×) — \`/merge alias:${playerName} into:${match.name}\``;
  }
  return '→ fix with `/correct`, or re-read with `/reprocess-line`';
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function fetchRosterWithFrequency(
  allianceId: string,
): Promise<{ roster: RosterPlayer[]; freqById: Map<string, number> }> {
  const { data, error } = await supabase
    .from('at_v_player_frequency')
    .select('player_id, name, occurrences')
    .eq('alliance_id', allianceId);
  if (error) throw new Error(`Roster frequency query failed: ${error.message}`);
  const rows = (data ?? []) as { player_id: string; name: string; occurrences: number | null }[];
  return {
    roster: rows.map((r) => ({ id: r.player_id, name: r.name })),
    freqById: new Map(rows.map((r) => [r.player_id, r.occurrences ?? 0])),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

type RenderResult =
  | { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }
  | { content: string; components: ActionRowBuilder<ButtonBuilder>[] };

export async function renderReviewList(allianceId: string, page: number): Promise<RenderResult> {
  const { data, error, count } = await supabase
    .from('at_v_needs_review')
    .select(VIEW_COLUMNS, { count: 'exact' })
    .eq('alliance_id', allianceId)
    .order('occurred_at', { ascending: false })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as ReviewRow[];
  if (rows.length === 0) {
    return { content: '✅ Nothing flagged for review.', components: [] };
  }

  // One roster read annotates every row on the page with a merge suggestion
  // when the name resembles an established player.
  const { roster, freqById } = await fetchRosterWithFrequency(allianceId);
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  const lines = rows.map((r) => {
    const match = establishedNearMatch(r, roster, freqById);
    return (
      `\`${r.player_name}\` — ${formatValue(r)} · ${r.context_label} · _${confidenceLabel(r.ocr_confidence)}_\n` +
      `   ${actionHint(match, r.player_name)} · \`${r.row_id.slice(0, 8)}\``
    );
  });

  const description = capDiscordContent(lines.join('\n\n'), 4000);
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🩹 Rows to review')
    .setDescription(description)
    .setFooter({ text: `Page ${page + 1}/${totalPages} · ${count ?? rows.length} flagged · resolve with /review resolve` });

  const prevId = `rv|${allianceId}|${page - 1}`;
  const nextId = `rv|${allianceId}|${page + 1}`;
  const components = totalPages > 1 ? [paginationRow(prevId, nextId, page, totalPages)] : [];
  return { embeds: [embed], components };
}

export async function renderReviewNames(allianceId: string): Promise<RenderResult> {
  // Bounded recent window: the resemblance check is client-side, so scanning
  // every historical flag would be unbounded work. Recent flags are the
  // actionable ones anyway.
  const { data, error } = await supabase
    .from('at_v_needs_review')
    .select(VIEW_COLUMNS)
    .eq('alliance_id', allianceId)
    .order('occurred_at', { ascending: false })
    .range(0, NAMES_SCAN_WINDOW - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as ReviewRow[];
  if (rows.length === 0) {
    return { content: '✅ Nothing flagged for review.', components: [] };
  }

  const { roster, freqById } = await fetchRosterWithFrequency(allianceId);
  const matched = rows
    .map((r) => ({ row: r, match: establishedNearMatch(r, roster, freqById) }))
    .filter((x): x is { row: ReviewRow; match: EstablishedMatch } => x.match !== null);

  if (matched.length === 0) {
    return {
      content:
        '✅ No flagged row resembles an established player. `/review list` shows the rest of the worklist.',
      components: [],
    };
  }

  const shown = matched.slice(0, NAMES_LIMIT);
  const lines = shown.map(
    ({ row, match }) =>
      `\`${row.player_name}\` — ${formatValue(row)} · ${row.context_label}\n` +
      `   ${actionHint(match, row.player_name)} · \`${row.row_id.slice(0, 8)}\``,
  );

  const heading =
    matched.length > shown.length
      ? `**Names to reconcile — ${shown.length} of ${matched.length}** (recent ${NAMES_SCAN_WINDOW} flags)`
      : `**Names to reconcile — ${matched.length}**`;
  const tip =
    '\n\n_A real misread → `/merge` into the established name. A genuinely new player → `/review resolve` to stop flagging it._';

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🩹 Flagged names resembling an established player')
    .setDescription(capDiscordContent(`${heading}\n\n${lines.join('\n\n')}${tip}`, 4000));
  return { embeds: [embed], components: [] };
}

// ── resolve (the only write) ─────────────────────────────────────────────────

type ResolveOutcome =
  | { status: 'cleared'; row: ReviewRow }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number }
  | { status: 'too_short' };

export async function resolveFlag(allianceId: string, idPrefix: string): Promise<ResolveOutcome> {
  const prefix = idPrefix.trim().toLowerCase();
  if (prefix.length < MIN_ID_PREFIX) return { status: 'too_short' };

  // Scope by the view (alliance-filtered) before touching a base table: the bot
  // uses the service-role key, which bypasses RLS, so the alliance check must be
  // explicit here. Matching client-side keeps it a uuid-prefix match without a
  // cast in PostgREST.
  const { data, error } = await supabase
    .from('at_v_needs_review')
    .select(VIEW_COLUMNS)
    .eq('alliance_id', allianceId)
    // Recent-first so the rows /review actually displays are matched even if the
    // flagged backlog exceeds PostgREST's default row cap.
    .order('occurred_at', { ascending: false });
  if (error) throw error;

  const matches = ((data ?? []) as unknown as ReviewRow[]).filter((r) =>
    r.row_id.toLowerCase().startsWith(prefix),
  );
  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous', count: matches.length };

  const row = matches[0]!;
  const table = row.kind === 'donation' ? 'at_donations' : 'at_participations';
  const { error: updateError } = await supabase
    .from(table)
    .update({ needs_review: false })
    .eq('id', row.row_id);
  if (updateError) throw new Error(`Failed to clear needs_review: ${updateError.message}`);

  logger.info({ allianceId, kind: row.kind, rowId: row.row_id }, 'Cleared needs_review flag');
  return { status: 'cleared', row };
}

function resolveReply(outcome: ResolveOutcome): string {
  switch (outcome.status) {
    case 'too_short':
      return `❌ Provide at least ${MIN_ID_PREFIX} characters of the row id.`;
    case 'not_found':
      return '❌ No flagged row matches that id (already resolved?). Check `/review list`.';
    case 'ambiguous':
      return `❌ ${outcome.count} flagged rows start with that id — paste more characters.`;
    case 'cleared':
      return `✅ Marked reviewed: \`${outcome.row.player_name}\` (${formatValue(outcome.row)} · ${outcome.row.context_label}). It won't show in /review anymore.`;
  }
}

// ── Discord glue ─────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  if (sub === 'resolve') {
    const id = interaction.options.getString('id', true);
    const outcome = await resolveFlag(alliance.id, id);
    await interaction.editReply(resolveReply(outcome));
    return;
  }

  const result = sub === 'names' ? await renderReviewNames(alliance.id) : await renderReviewList(alliance.id, 0);
  await interaction.editReply(result);
}

// customId format: rv|<allianceId>|<page>  (list pagination only)
export async function handleButton(interaction: ButtonInteraction, parts: string[]): Promise<void> {
  const allianceId = parts[1];
  const page = parseInt(parts[2] ?? '0', 10);
  await interaction.deferUpdate();

  if (!allianceId) {
    logger.warn({ parts }, 'review button: missing allianceId');
    return;
  }
  // resolveAlliance (no reply side effect) — deferUpdate already happened.
  const alliance = await resolveAlliance(interaction.channelId);
  if (!alliance || alliance.id !== allianceId) {
    await interaction.editReply({
      content: '⚠️ This channel is no longer linked to that alliance.',
      components: [],
    });
    return;
  }
  const result = await renderReviewList(allianceId, Math.max(0, page));
  await interaction.editReply(result);
}
