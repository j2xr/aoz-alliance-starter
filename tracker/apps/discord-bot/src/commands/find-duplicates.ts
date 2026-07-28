// /find-duplicates — surfaces (never merges) player pairs likely duplicated
// by an OCR misread between two screenshots already in the database (the
// same event or the same donation period). Read-only end to end: see
// lib/duplicate-scan.ts for the algorithm and its validation against the 4
// real duplicates + confirmed false positives from the 2026-07-26 audits.
// `/merge` and `/player-alias` remain the only tools that write to the
// database, after a human checks the source screenshot.

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
  scanContext,
  rankCandidates,
  MAX_ENTRIES_PER_CONTEXT,
  type ScanEntry,
  type ScanContext,
  type DuplicateCandidate,
  type DuplicateTier,
} from '../lib/duplicate-scan.js';
import { formatPeriodLabel } from './donation.js';
import logger from '../logger.js';

const PAGE_SIZE = 8;
// The largest context observed to date is ~106 members (donation period) —
// that's headroom, not a real limit. Bounds the scan to stay under Discord's
// response budget (3s for a deferReply, but we also want to bound the
// number of PostgREST rows returned, ~1000 per query).
const MAX_EVENTS_SCANNED = 40;
const MAX_DONATION_PERIODS_SCANNED = 6;

const TIER_RANK: Record<DuplicateTier, number> = { high: 0, medium: 1, low: 2 };
const TIER_EMOJI: Record<DuplicateTier, string> = { high: '🔴', medium: '🟠', low: '🟡' };
const TIER_HEADING: Record<DuplicateTier, string> = {
  high: 'Likely',
  medium: 'Worth checking',
  low: 'Same value, unrelated names (often a coincidence)',
};

const HEADER =
  'Read-only analysis — no merge is performed. Check the source screenshot before any `/merge`.';

export const data = new SlashCommandBuilder()
  .setName('find-duplicates')
  .setDescription('List likely duplicate players (read-only, no merging)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // same guard as /merge
  .addStringOption((opt) =>
    opt
      .setName('min_tier')
      .setDescription('Minimum confidence threshold (default: worth checking)')
      .addChoices(
        { name: 'Likely', value: 'high' },
        { name: 'Worth checking', value: 'medium' },
        { name: 'All', value: 'low' },
      ),
  );

// ── Contexts: events + donation periods ─────────────────────────────────────

type EventRow = {
  id: string;
  event_datetime: string;
  at_event_types: { display_name: string } | { display_name: string }[] | null;
};

type ParticipationRow = {
  event_id: string;
  player_id: string;
  points: number;
  ocr_confidence: number | null;
  at_players: { name: string } | { name: string }[] | null;
};

type DonationPeriodRow = { id: string; period_start: string; period_end: string };

type DonationRow = {
  donation_period_id: string;
  player_id: string;
  alliance_honor: number;
  ocr_confidence: number | null;
  at_players: { name: string } | { name: string }[] | null;
};

function embeddedName(rel: { name: string } | { name: string }[] | null): string | null {
  const single = Array.isArray(rel) ? rel[0] : rel;
  return single?.name ?? null;
}

function formatEventLabel(row: EventRow): string {
  const typeRel = Array.isArray(row.at_event_types) ? row.at_event_types[0] : row.at_event_types;
  const typeName = typeRel?.display_name ?? '?';
  const dt = new Date(row.event_datetime).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  });
  return `${typeName} — ${dt}`;
}

type ContextEntries = { context: ScanContext; entries: ScanEntry[] };

async function fetchEventContexts(allianceId: string): Promise<ContextEntries[]> {
  const { data: events, error } = await supabase
    .from('at_events')
    .select('id, event_datetime, at_event_types(display_name)')
    .eq('alliance_id', allianceId)
    .order('event_datetime', { ascending: false })
    .limit(MAX_EVENTS_SCANNED);
  if (error) throw new Error(`Events query failed: ${error.message}`);

  const eventRows = (events ?? []) as unknown as EventRow[];
  if (eventRows.length === 0) return [];

  const eventIds = eventRows.map((e) => e.id);
  const { data: participations, error: partError } = await supabase
    .from('at_participations')
    .select('event_id, player_id, points, ocr_confidence, at_players(name)')
    .in('event_id', eventIds);
  if (partError) throw new Error(`Participations query failed: ${partError.message}`);

  const byEvent = new Map<string, ScanEntry[]>();
  for (const row of (participations ?? []) as unknown as ParticipationRow[]) {
    const playerName = embeddedName(row.at_players);
    if (!playerName) continue;
    const list = byEvent.get(row.event_id) ?? [];
    list.push({
      playerId: row.player_id,
      playerName,
      value: row.points,
      confidence: row.ocr_confidence,
    });
    byEvent.set(row.event_id, list);
  }

  return eventRows.map((row) => ({
    context: {
      kind: 'event',
      id: row.id,
      label: formatEventLabel(row),
      valueLabel: 'points',
    },
    entries: byEvent.get(row.id) ?? [],
  }));
}

async function fetchDonationContexts(allianceId: string): Promise<ContextEntries[]> {
  const { data: periods, error } = await supabase
    .from('at_donation_periods')
    .select('id, period_start, period_end')
    .eq('alliance_id', allianceId)
    .order('period_start', { ascending: false })
    .limit(MAX_DONATION_PERIODS_SCANNED);
  if (error) throw new Error(`Donation periods query failed: ${error.message}`);

  const periodRows = (periods ?? []) as DonationPeriodRow[];
  if (periodRows.length === 0) return [];

  const periodIds = periodRows.map((p) => p.id);
  const { data: donations, error: donationError } = await supabase
    .from('at_donations')
    .select('donation_period_id, player_id, alliance_honor, ocr_confidence, at_players(name)')
    .in('donation_period_id', periodIds);
  if (donationError) throw new Error(`Donations query failed: ${donationError.message}`);

  const byPeriod = new Map<string, ScanEntry[]>();
  for (const row of (donations ?? []) as unknown as DonationRow[]) {
    const playerName = embeddedName(row.at_players);
    if (!playerName) continue;
    const list = byPeriod.get(row.donation_period_id) ?? [];
    list.push({
      playerId: row.player_id,
      playerName,
      value: row.alliance_honor,
      confidence: row.ocr_confidence,
    });
    byPeriod.set(row.donation_period_id, list);
  }

  return periodRows.map((row) => ({
    context: {
      kind: 'donation_period',
      id: row.id,
      label: `Week ${formatPeriodLabel(row.period_start, row.period_end)}`,
      valueLabel: 'honor',
    },
    entries: byPeriod.get(row.id) ?? [],
  }));
}

async function scanAllContexts(
  allianceId: string,
): Promise<{ candidates: DuplicateCandidate[]; scannedEvents: number; scannedPeriods: number }> {
  // Sequential, not Promise.all: four total queries on an admin, non-hot-path
  // command — the few extra ms don't matter, and a deterministic call order
  // is simpler to reason about (and to test) than parallel interleaving.
  const eventContexts = await fetchEventContexts(allianceId);
  const donationContexts = await fetchDonationContexts(allianceId);

  const allCandidates: DuplicateCandidate[] = [];
  for (const { context, entries } of [...eventContexts, ...donationContexts]) {
    if (entries.length > MAX_ENTRIES_PER_CONTEXT) {
      logger.warn(
        { context: context.label, count: entries.length },
        'Skipping oversized context in duplicate scan',
      );
      continue;
    }
    allCandidates.push(...scanContext(entries, context));
  }

  return {
    candidates: rankCandidates(allCandidates),
    scannedEvents: eventContexts.length,
    scannedPeriods: donationContexts.length,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderCandidateLine(c: DuplicateCandidate): string {
  const valueWord = c.context.valueLabel === 'honor' ? 'honor' : 'points';
  const valueNote = c.sameValue
    ? `identical ${valueWord} ${c.a.value}`
    : `different ${valueWord} (${c.a.value} vs ${c.b.value})`;
  const alsoNote =
    c.alsoInContexts > 0 ? ` (+${c.alsoInContexts} other context${c.alsoInContexts > 1 ? 's' : ''})` : '';

  return (
    `\`${c.a.playerName}\` ↔ \`${c.b.playerName}\` — ${valueNote} · similarity ${c.name.similarity.toFixed(2)}\n` +
    `   ${c.name.reason} · ${c.context.label}${alsoNote}`
  );
}

function renderCandidatePage(candidates: DuplicateCandidate[], page: number): string {
  const start = page * PAGE_SIZE;
  const pageItems = candidates.slice(start, start + PAGE_SIZE);

  const lines: string[] = [];
  let currentTier: DuplicateTier | null = null;
  for (const c of pageItems) {
    if (c.tier !== currentTier) {
      currentTier = c.tier;
      lines.push(`\n**${TIER_EMOJI[c.tier]} ${TIER_HEADING[c.tier]}**`);
    }
    lines.push(`• ${renderCandidateLine(c)}`);
  }
  return lines.join('\n');
}

type RenderResult = { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] };

export async function renderFindDuplicates(
  allianceId: string,
  minTier: DuplicateTier,
  page: number,
): Promise<RenderResult> {
  const { candidates, scannedEvents, scannedPeriods } = await scanAllContexts(allianceId);
  const filtered = candidates.filter((c) => TIER_RANK[c.tier] <= TIER_RANK[minTier]);

  const scanNote = `${scannedEvents} event${scannedEvents > 1 ? 's' : ''}, ${scannedPeriods} period${scannedPeriods > 1 ? 's' : ''} scanned`;

  if (filtered.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('🔍 Likely duplicate players')
      .setDescription(`${HEADER}\n\nNo likely duplicate detected (${scanNote}).`);
    return { embeds: [embed], components: [] };
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);

  const description = capDiscordContent(
    `${HEADER}\n${renderCandidatePage(filtered, clampedPage)}`,
    4000,
  );

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🔍 Likely duplicate players')
    .setDescription(description)
    .setFooter({ text: `Page ${clampedPage + 1}/${totalPages} · ${scanNote}` });

  const prevId = `dup|${minTier}|${clampedPage - 1}`;
  const nextId = `dup|${minTier}|${clampedPage + 1}`;
  const components =
    totalPages > 1 ? [paginationRow(prevId, nextId, clampedPage, totalPages)] : [];

  return { embeds: [embed], components };
}

// ── Discord glue ─────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const minTier = (interaction.options.getString('min_tier') ?? 'medium') as DuplicateTier;

  const result = await renderFindDuplicates(alliance.id, minTier, 0);
  await interaction.editReply(result);
}

// customId format: dup|<minTier>|<page>
export async function handleButton(
  interaction: ButtonInteraction,
  parts: string[],
): Promise<void> {
  const minTier = (parts[1] ?? 'medium') as DuplicateTier;
  const page = parseInt(parts[2] ?? '0', 10);

  await interaction.deferUpdate();

  // requireAlliance() replies via editReply on the not-found path, which
  // needs deferUpdate()/deferReply() to have already happened — hence
  // resolveAlliance() (no reply side effect) here instead, unlike execute().
  const alliance = await resolveAlliance(interaction.channelId);
  if (!alliance) {
    await interaction.editReply({
      content: '⚠️ This channel is no longer linked to an alliance.',
      components: [],
    });
    return;
  }

  const result = await renderFindDuplicates(alliance.id, minTier, page);
  await interaction.editReply(result);
}
