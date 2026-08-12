import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Message } from 'discord.js';
import {
  isEventResult,
  isOcrError,
  isPlayerStatsResult,
  type OcrDonationMember,
  type OcrMember,
} from '@alliance-tracker/shared-types';
import { requireAlliance, resolveAlliance, type AllianceRow } from '../lib/alliance.js';
import { imageAttachmentsOf } from '../lib/attachment.js';
import { imageChoicesForMessageUrl, MESSAGE_URL_RE } from '../lib/image-autocomplete.js';
import { processImageAttachment } from '../lib/ingestion.js';
import { resolvePlayerByName } from '../lib/players.js';
import { applyCorrection, type CorrectionField } from '../lib/corrections.js';
import { isoWeekStartParis } from '../lib/period.js';
import { supabase } from '../lib/supabase.js';
import logger from '../logger.js';

export const data = new SlashCommandBuilder()
  .setName('reprocess-line')
  .setDescription('Re-read one row with the LLM and fix its score — see /reprocess for the whole image')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('message_url')
      .setDescription('URL of the Discord message containing the screenshot')
      .setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('rank')
      .setDescription('On-screen row to re-read, counting from the top (1 = first row)')
      .setRequired(true)
      .setMinValue(1),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('image')
      .setDescription('Which image, if the message has several (1-based)')
      .setRequired(false)
      .setMinValue(1)
      .setAutocomplete(true),
  )
  .addBooleanOption((opt) =>
    opt
      .setName('force_llm')
      .setDescription('Re-read with the vision model (default: on — that is the point of this command)')
      .setRequired(false),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await interaction.respond(await imageChoicesForMessageUrl(interaction));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const messageUrl = interaction.options.getString('message_url', true);
  const rank = interaction.options.getInteger('rank', true);
  const imageIndex = interaction.options.getInteger('image') ?? undefined;
  const forceLlm = interaction.options.getBoolean('force_llm') ?? true;

  const match = MESSAGE_URL_RE.exec(messageUrl);
  if (!match) {
    await interaction.editReply(
      '❌ Invalid message URL. Expected format: `https://discord.com/channels/<guild>/<channel>/<message>`',
    );
    return;
  }
  const channelId = match[1]!;
  const messageId = match[2]!;

  const invokingAlliance = await requireAlliance(interaction);
  if (!invokingAlliance) return;

  // Alliance of the TARGET channel must match the invoking channel's — same
  // guard as /reprocess, so a member can't reprocess (and read back) another
  // alliance's screenshots by pasting a message URL the bot can see.
  const alliance = await resolveAlliance(channelId);
  if (!alliance) {
    await interaction.editReply('⚠️ This channel is not linked to an alliance.');
    return;
  }
  if (alliance.id !== invokingAlliance.id) {
    await interaction.editReply(
      '❌ That message is not in an alliance channel you can reprocess from.',
    );
    return;
  }

  let message: Message<boolean>;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      await interaction.editReply('❌ Channel not found or inaccessible.');
      return;
    }
    message = await channel.messages.fetch(messageId);
  } catch (err) {
    logger.error({ channelId, messageId, err: String(err) }, 'Failed to fetch original message');
    await interaction.editReply('❌ Message not found. The bot must have access to the channel.');
    return;
  }

  const images = imageAttachmentsOf(message);
  if (images.length === 0) {
    await interaction.editReply('❌ No image found in this message.');
    return;
  }
  if (imageIndex === undefined && images.length > 1) {
    const list = images.map((att, i) => `#${i + 1} — ${att.name}`).join('\n');
    await interaction.editReply(
      `❌ This message has ${images.length} images — specify which with \`image\`:\n${list}`,
    );
    return;
  }
  if (imageIndex !== undefined && imageIndex > images.length) {
    const list = images.map((att, i) => `#${i + 1} — ${att.name}`).join('\n');
    await interaction.editReply(
      `❌ Image ${imageIndex} is out of range — this message has ${images.length} image(s):\n${list}`,
    );
    return;
  }
  const att = images[(imageIndex ?? 1) - 1]!;

  await interaction.editReply(
    `⏳ Re-reading row ${rank} of **${att.name}**${forceLlm ? ' with the vision model' : ''}. This can take a minute…`,
  );

  const result = await processImageAttachment(messageId, att.url, att.name, undefined, forceLlm);
  if (!result.ok) {
    await interaction.editReply(`❌ **${result.filename}** — ${result.error}`);
    return;
  }
  const ocr = result.ocr;
  if (isOcrError(ocr)) {
    await interaction.editReply(`❌ OCR failed on **${att.name}** (${ocr.error}).`);
    return;
  }
  if (isPlayerStatsResult(ocr)) {
    await interaction.editReply(
      '❌ `/reprocess-line` targets event and donation boards; player-stats screens have no per-row score to correct.',
    );
    return;
  }

  const members = ocr.members;
  if (rank > members.length) {
    await interaction.editReply(
      `❌ Row ${rank} is out of range — this board has ${members.length} readable row(s).`,
    );
    return;
  }
  const member = members[rank - 1]!;

  // The re-read name locates the stored line. When it resolves to exactly one
  // player we can safely correct that player's numbers; when it doesn't, the
  // line is most likely a *name* misread (a different player is stored under
  // the wrong name) — a merge job, not a numeric fix — so we only suggest.
  const lookup = await resolvePlayerByName(alliance.id, member.name, { match: 'exact' });
  if (lookup.status !== 'found') {
    await interaction.editReply({ embeds: [buildNameSuggestionEmbed(rank, member, ocr.kind)] });
    return;
  }
  const player = lookup.player;

  const applied = isEventResult(ocr)
    ? await correctEventRow(alliance, player.id, member as OcrMember, ocr.event_type, ocr.event_datetime, interaction.user.id)
    : await correctDonationRow(alliance, player.id, member as OcrDonationMember, message.createdAt, interaction.user.id);

  await interaction.editReply({ embeds: [buildResultEmbed(rank, player.name, applied)] });
}

type AppliedResult =
  | { kind: 'no_row' }
  | { kind: 'applied'; changes: { field: CorrectionField; oldValue: number | null; newValue: number }[] };

async function correctEventRow(
  alliance: AllianceRow,
  playerId: string,
  member: OcrMember,
  eventTypeCode: string,
  eventDatetime: string | null,
  correctedBy: string,
): Promise<AppliedResult> {
  if (!eventDatetime) return { kind: 'no_row' };

  const { data: et } = await supabase
    .from('at_event_types')
    .select('id')
    .eq('code', eventTypeCode)
    .maybeSingle();
  if (!et) return { kind: 'no_row' };

  const { data: eventRow } = await supabase
    .from('at_events')
    .select('id')
    .eq('alliance_id', alliance.id)
    .eq('event_type_id', (et as { id: string }).id)
    .eq('event_datetime', eventDatetime)
    .maybeSingle();
  if (!eventRow) return { kind: 'no_row' };

  const { data: partRow } = await supabase
    .from('at_participations')
    .select('id, points, power')
    .eq('event_id', (eventRow as { id: string }).id)
    .eq('player_id', playerId)
    .maybeSingle();
  if (!partRow) return { kind: 'no_row' };

  const stored = partRow as { id: string; points: number | null; power: number | null };
  const targets: { field: CorrectionField; stored: number | null; reread: number | null }[] = [
    { field: 'points', stored: stored.points, reread: member.points },
    { field: 'power', stored: stored.power, reread: member.power },
  ];
  return applyDiffs('at_participations', stored.id, targets, alliance.id, playerId, correctedBy);
}

async function correctDonationRow(
  alliance: AllianceRow,
  playerId: string,
  member: OcrDonationMember,
  messageCreatedAt: Date,
  correctedBy: string,
): Promise<AppliedResult> {
  const periodStart = isoWeekStartParis(messageCreatedAt);
  const { data: periodRow } = await supabase
    .from('at_donation_periods')
    .select('id')
    .eq('alliance_id', alliance.id)
    .eq('period_type', 'weekly')
    .eq('period_start', periodStart)
    .maybeSingle();
  if (!periodRow) return { kind: 'no_row' };

  const { data: donationRow } = await supabase
    .from('at_donations')
    .select('id, alliance_honor')
    .eq('donation_period_id', (periodRow as { id: string }).id)
    .eq('player_id', playerId)
    .maybeSingle();
  if (!donationRow) return { kind: 'no_row' };

  const stored = donationRow as { id: string; alliance_honor: number | null };
  const targets = [{ field: 'honor' as const, stored: stored.alliance_honor, reread: member.alliance_honor }];
  return applyDiffs('at_donations', stored.id, targets, alliance.id, playerId, correctedBy);
}

async function applyDiffs(
  targetTable: 'at_participations' | 'at_donations',
  targetId: string,
  targets: { field: CorrectionField; stored: number | null; reread: number | null }[],
  allianceId: string,
  playerId: string,
  correctedBy: string,
): Promise<AppliedResult> {
  const changes: { field: CorrectionField; oldValue: number | null; newValue: number }[] = [];
  for (const t of targets) {
    if (t.reread === null || t.reread === t.stored) continue;
    const { oldValue, newValue } = await applyCorrection({
      targetTable,
      targetId,
      field: t.field,
      newValue: t.reread,
      allianceId,
      playerId,
      correctedBy,
    });
    changes.push({ field: t.field, oldValue, newValue });
  }
  return { kind: 'applied', changes };
}

function buildNameSuggestionEmbed(
  rank: number,
  member: OcrMember | OcrDonationMember,
  kind: 'event' | 'donation',
): EmbedBuilder {
  const value =
    kind === 'donation'
      ? `honor ${(member as OcrDonationMember).alliance_honor.toLocaleString('en-GB')}`
      : `points ${(member as OcrMember).points?.toLocaleString('en-GB') ?? '—'}`;
  return new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('🔎 Re-read — name not on the roster')
    .setDescription(
      `Row ${rank} reads **\`${member.name}\`** (${value}), but no player by that exact name is recorded.\n` +
        'This is usually a **name** misread: a different player is stored under the wrong name. ' +
        `Fix it with \`/merge alias:<the misread name> into:${member.name}\` — this command only auto-applies numeric fixes.`,
    );
}

function buildResultEmbed(rank: number, playerName: string, applied: AppliedResult): EmbedBuilder {
  if (applied.kind === 'no_row') {
    return new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle('🔎 Re-read — no stored line to correct')
      .setDescription(
        `Row ${rank} resolves to **${playerName}**, but no stored score was found for them on this board. ` +
          'If the line is under a different (misread) name, use `/merge` to reconcile it first.',
      );
  }
  if (applied.changes.length === 0) {
    return new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Re-read — already correct')
      .setDescription(`Row ${rank} (**${playerName}**) already matches the re-read. Nothing to change.`);
  }
  const lines = applied.changes.map(
    (c) =>
      `**${c.field}**: ${c.oldValue?.toLocaleString('en-GB') ?? '—'} → **${c.newValue.toLocaleString('en-GB')}**`,
  );
  return new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('✏️ Re-read — correction applied')
    .setDescription(`Row ${rank} — **${playerName}**\n${lines.join('\n')}`)
    .setTimestamp();
}
