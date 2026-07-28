import { EmbedBuilder } from 'discord.js';
import type {
  OcrDonationResult,
  OcrEventResult,
  OcrPlayerStatsResult,
} from '@alliance-tracker/shared-types';
import type {
  ProcessedDonationUpsertResult,
  ProcessedPlayerStatsUpsertResult,
  ProcessedUpsertResult,
} from './upsert.js';

export function buildEventEmbed(
  filename: string,
  ocr: OcrEventResult,
  result: ProcessedUpsertResult,
): EmbedBuilder {
  // event_datetime can in theory be null (unreadable header), but
  // upsertEventResult rejects such results before we ever get here.
  const eventDate = ocr.event_datetime
    ? new Date(ocr.event_datetime).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Paris',
      })
    : 'unknown date';

  const medals = ['🥇', '🥈', '🥉'];
  const top3Lines = [...ocr.members]
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, 3)
    .map((m, i) => `${medals[i] ?? ''} **${m.name}** (${m.rank}) — ${m.points != null ? m.points.toLocaleString('en-GB') + ' pts' : '— pts'}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle(`${result.eventTypeDisplayName} — ${eventDate}`)
    .addFields(
      { name: 'Alliance rank', value: `#${ocr.alliance_rank}`, inline: true },
      { name: 'Participants', value: String(ocr.total_battlers), inline: true },
      { name: 'Total points', value: ocr.total_points != null ? ocr.total_points.toLocaleString('en-GB') : '—', inline: true },
      { name: 'Top 3', value: top3Lines || '—' },
    )
    .setFooter({ text: filename });

  if (result.newMemberCount > 0) {
    embed.addFields({ name: '🆕 New members', value: `+${result.newMemberCount}`, inline: true });
  }

  return embed;
}

export function buildDonationEmbed(
  filename: string,
  ocr: OcrDonationResult,
  result: ProcessedDonationUpsertResult,
): EmbedBuilder {
  // periodStart is a calendar date (YYYY-MM-DD): anchor and display in UTC
  // so it never slips by a day, regardless of offset (CET/CEST).
  const periodStartLabel = new Date(`${result.periodStart}T00:00:00Z`).toLocaleDateString(
    'en-GB',
    { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' },
  );

  const medals = ['🥇', '🥈', '🥉'];
  const top3Lines = [...ocr.members]
    .sort((a, b) => b.alliance_honor - a.alliance_honor)
    .slice(0, 3)
    .map((m, i) => {
      const tag = m.alliance_tag ? `(${m.alliance_tag}) ` : '';
      const rank = m.rank ? ` ${m.rank}` : '';
      return `${medals[i] ?? ''} **${tag}${m.name}**${rank} — ${m.alliance_honor.toLocaleString('en-GB')}`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xb59f3b)
    .setTitle(`🎁 Alliance Honor donations — week of ${periodStartLabel}`)
    .addFields(
      { name: 'Members extracted', value: String(result.memberCount), inline: true },
      { name: 'Top 3', value: top3Lines || '—' },
    )
    .setFooter({ text: filename });

  if (result.newMemberCount > 0) {
    embed.addFields({
      name: '🆕 New members',
      value: `+${result.newMemberCount}`,
      inline: true,
    });
  }

  return embed;
}

export function buildPlayerStatsEmbed(
  filename: string,
  ocr: OcrPlayerStatsResult,
  result: ProcessedPlayerStatsUpsertResult,
): EmbedBuilder {
  const dateLabel = new Date(`${result.recordedDate}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Paris',
  });

  const fmtPct = (v: number | null | undefined) => (v != null ? `${v.toFixed(1)}%` : '—');

  // Top 5 by attack %, then remaining with partial stats
  const sorted = [...ocr.members]
    .filter((m) => m.attack_pct != null || m.hp_pct != null || m.defense_pct != null)
    .sort((a, b) => (b.attack_pct ?? 0) - (a.attack_pct ?? 0))
    .slice(0, 5);

  const memberLines = sorted
    .map((m) => `**${m.name}** — Atk: ${fmtPct(m.attack_pct)} | HP: ${fmtPct(m.hp_pct)} | Def: ${fmtPct(m.defense_pct)}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x8b0000)
    .setTitle(`⚔️ Military stats — ${dateLabel}`)
    .addFields(
      { name: 'Players extracted', value: String(result.memberCount), inline: true },
      { name: 'Top 5 Attack', value: memberLines || '—' },
    )
    .setFooter({ text: filename });

  if (result.skippedCount > 0) {
    embed.addFields({
      name: '⚠️ Unknown players ignored',
      value: `${result.skippedCount} (see raw texts below)`,
      inline: true,
    });
  }

  if (result.lowConfidenceCount > 0) {
    embed.addFields({
      name: '⚠️ Incomplete stats',
      value: `${result.lowConfidenceCount} player(s) with fewer than 2 stats parsed`,
      inline: true,
    });
  }

  return embed;
}
