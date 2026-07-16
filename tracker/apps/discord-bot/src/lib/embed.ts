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
  // event_datetime peut être null en théorie (en-tête illisible), mais
  // upsertEventResult refuse ces résultats avant qu'on n'arrive ici.
  const eventDate = ocr.event_datetime
    ? new Date(ocr.event_datetime).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Paris',
      })
    : 'date inconnue';

  const medals = ['🥇', '🥈', '🥉'];
  const top3Lines = [...ocr.members]
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, 3)
    .map((m, i) => `${medals[i] ?? ''} **${m.name}** (${m.rank}) — ${m.points != null ? m.points.toLocaleString('fr-FR') + ' pts' : '— pts'}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle(`${result.eventTypeDisplayName} — ${eventDate}`)
    .addFields(
      { name: 'Rang alliance', value: `#${ocr.alliance_rank}`, inline: true },
      { name: 'Participants', value: String(ocr.total_battlers), inline: true },
      { name: 'Points totaux', value: ocr.total_points != null ? ocr.total_points.toLocaleString('fr-FR') : '—', inline: true },
      { name: 'Top 3', value: top3Lines || '—' },
    )
    .setFooter({ text: filename });

  if (result.newMemberCount > 0) {
    embed.addFields({ name: '🆕 Nouveaux membres', value: `+${result.newMemberCount}`, inline: true });
  }

  return embed;
}

export function buildDonationEmbed(
  filename: string,
  ocr: OcrDonationResult,
  result: ProcessedDonationUpsertResult,
): EmbedBuilder {
  // periodStart est une date calendaire (YYYY-MM-DD) : ancrage et affichage en
  // UTC pour ne jamais glisser d'un jour, quel que soit l'offset (CET/CEST).
  const periodStartLabel = new Date(`${result.periodStart}T00:00:00Z`).toLocaleDateString(
    'fr-FR',
    { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' },
  );

  const medals = ['🥇', '🥈', '🥉'];
  const top3Lines = [...ocr.members]
    .sort((a, b) => b.alliance_honor - a.alliance_honor)
    .slice(0, 3)
    .map((m, i) => {
      const tag = m.alliance_tag ? `(${m.alliance_tag}) ` : '';
      const rank = m.rank ? ` ${m.rank}` : '';
      return `${medals[i] ?? ''} **${tag}${m.name}**${rank} — ${m.alliance_honor.toLocaleString('fr-FR')}`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xb59f3b)
    .setTitle(`🎁 Dons Alliance Honor — semaine du ${periodStartLabel}`)
    .addFields(
      { name: 'Membres extraits', value: String(result.memberCount), inline: true },
      { name: 'Top 3', value: top3Lines || '—' },
    )
    .setFooter({ text: filename });

  if (result.newMemberCount > 0) {
    embed.addFields({
      name: '🆕 Nouveaux membres',
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
  const dateLabel = new Date(`${result.recordedDate}T00:00:00Z`).toLocaleDateString('fr-FR', {
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
    .setTitle(`⚔️ Stats militaires — ${dateLabel}`)
    .addFields(
      { name: 'Joueurs extraits', value: String(result.memberCount), inline: true },
      { name: 'Top 5 Attaque', value: memberLines || '—' },
    )
    .setFooter({ text: filename });

  if (result.skippedCount > 0) {
    embed.addFields({
      name: '⚠️ Joueurs inconnus ignorés',
      value: `${result.skippedCount} (voir raw texts ci-dessous)`,
      inline: true,
    });
  }

  if (result.lowConfidenceCount > 0) {
    embed.addFields({
      name: '⚠️ Stats incomplètes',
      value: `${result.lowConfidenceCount} joueur(s) avec moins de 2 stats parsées`,
      inline: true,
    });
  }

  return embed;
}
