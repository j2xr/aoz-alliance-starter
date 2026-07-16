import type { Attachment, Message, EmbedBuilder, TextChannel } from 'discord.js';
import { isOcrError, isPlayerStatsResult } from '@alliance-tracker/shared-types';
import { config } from '../config.js';
import logger from '../logger.js';
import { ensureKind, processImageAttachment } from '../lib/ingestion.js';
import { resolveAlliance } from '../lib/alliance.js';
import type { AllianceRow } from '../lib/alliance.js';
import {
  recordUploadError,
  upsertDonationResult,
  upsertEventResult,
  upsertPlayerStatsResult,
} from '../lib/upsert.js';
import { buildDonationEmbed, buildEventEmbed, buildPlayerStatsEmbed } from '../lib/embed.js';
import { isImageAttachment } from '../lib/attachment.js';
import { safeProgressEdit } from '../lib/progress-reply.js';

export async function handleMessageCreate(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!config.allowedChannelIds.has(message.channelId)) return;

  const images = message.attachments.filter((att) => isImageAttachment(att.contentType, att.name));
  if (images.size === 0) return;

  logger.info(
    { messageId: message.id, channelId: message.channelId, count: images.size },
    'Processing message',
  );

  const plural = images.size > 1 ? 's' : '';
  const ackReply = await message.reply(
    `⏳ Processing ${images.size} screenshot${plural}. This can take several minutes — **please do not upload again**.`,
  );

  let alliance: AllianceRow | null;
  try {
    alliance = await resolveAlliance(message.channelId);
  } catch (err) {
    logger.error({ channelId: message.channelId, err: String(err) }, 'Failed to resolve alliance');
    await ackReply.edit('⚠️ Erreur lors de la résolution de l\'alliance. Veuillez réessayer plus tard.');
    return;
  }

  if (!alliance) {
    logger.warn({ channelId: message.channelId }, 'No alliance mapped to this channel');
    await ackReply.edit('⚠️ Ce channel n\'est pas associé à une alliance. Configurez `discord_channel_id` dans `at_alliances`.');
    return;
  }
  // Rebind as a const: `alliance` is narrowed to non-null here, but a `let`
  // doesn't keep that narrowing when captured by the nested function below.
  const resolvedAlliance = alliance;

  const lines: string[] = [];
  const embeds: EmbedBuilder[] = [];
  const allRejectedRawTexts: string[] = [];

  // Extracted so progress can be reported after every attachment regardless
  // of which branch below returns early (a `continue` in a for..of loop
  // would otherwise skip that reporting call for every non-final branch).
  async function processOneAttachment(att: Attachment): Promise<void> {
    let result;
    try {
      result = await processImageAttachment(message.id, att.url, att.name);
    } catch (err) {
      logger.error(
        { messageId: message.id, filename: att.name, err: String(err) },
        'Attachment processing failed',
      );
      lines.push(`❌ **${att.name}** — erreur inattendue : ${String(err)}`);
      return;
    }

    if (!result.ok) {
      lines.push(`❌ **${result.filename}** — ${result.error}`);
      return;
    }

    const { filename, fileHash, filePath, ocr } = result;

    if (isOcrError(ocr)) {
      logger.warn({ messageId: message.id, filename, error: ocr.error }, 'OCR returned error');
      const uploadStatus = ocr.error === 'unknown_event' ? 'unknown_event' as const : 'failed' as const;
      try {
        await recordUploadError({
          messageId: message.id,
          userId: message.author.id,
          allianceId: resolvedAlliance.id,
          fileHash,
          filePath,
          status: uploadStatus,
          errorMessage: ocr.error + (ocr.detail ? `: ${ocr.detail}` : ''),
        });
      } catch (err) {
        logger.error({ err: String(err) }, 'Failed to record upload error');
      }
      if (uploadStatus === 'unknown_event') {
        lines.push(
          `⚠️ **${filename}** — type d'écran non reconnu : \`${ocr.detail ?? ocr.error}\`. Utilisez \`/upload event:<type>\` ou \`/upload kind:donation\`.`,
        );
      } else {
        lines.push(`⚠️ **${filename}** — OCR : ${ocr.error}${ocr.detail ? ` (${ocr.detail})` : ''}`);
      }
      return;
    }

    const typedOcr = ensureKind(ocr);

    if (isPlayerStatsResult(typedOcr)) {
      let statsResult;
      try {
        statsResult = await upsertPlayerStatsResult({
          messageId: message.id,
          userId: message.author.id,
          allianceId: resolvedAlliance.id,
          fileHash,
          filePath,
          messageCreatedAt: message.createdAt,
          ocr: typedOcr,
        });
      } catch (err) {
        logger.error(
          { messageId: message.id, filename, err: String(err) },
          'Player stats upsert failed',
        );
        lines.push(`❌ **${filename}** — erreur base de données : ${String(err)}`);
        return;
      }

      if (statsResult.status === 'duplicate') {
        lines.push(`🔁 **${filename}** — capture déjà traitée (doublon).`);
        return;
      }

      if (statsResult.status === 'no_members') {
        lines.push(`⚠️ **${filename}** — aucun joueur extrait de la capture stats.`);
        return;
      }

      logger.info(
        { messageId: message.id, filename, memberCount: statsResult.memberCount, skippedCount: statsResult.skippedCount },
        'Player stats upsert successful',
      );
      embeds.push(buildPlayerStatsEmbed(filename, typedOcr, statsResult));
      if (statsResult.rejectedRawTexts.length > 0) {
        allRejectedRawTexts.push(...statsResult.rejectedRawTexts);
      }
      return;
    }

    if (typedOcr.kind === 'donation') {
      let donationResult;
      try {
        donationResult = await upsertDonationResult({
          messageId: message.id,
          userId: message.author.id,
          allianceId: resolvedAlliance.id,
          fileHash,
          filePath,
          messageCreatedAt: message.createdAt,
          ocr: typedOcr,
        });
      } catch (err) {
        logger.error(
          { messageId: message.id, filename, err: String(err) },
          'Donation upsert failed',
        );
        lines.push(`❌ **${filename}** — erreur base de données : ${String(err)}`);
        return;
      }

      if (donationResult.status === 'duplicate') {
        lines.push(`🔁 **${filename}** — capture déjà traitée (doublon).`);
        return;
      }

      if (donationResult.status === 'unsupported_period_type') {
        lines.push(
          `⚠️ **${filename}** — onglet \`${donationResult.periodType}\` non géré (V1 = Weekly uniquement).`,
        );
        return;
      }

      logger.info(
        { messageId: message.id, filename, periodId: donationResult.periodId },
        'Donation upsert successful',
      );
      embeds.push(buildDonationEmbed(filename, typedOcr, donationResult));
      return;
    }

    // kind === 'event'
    let upsertResult;
    try {
      upsertResult = await upsertEventResult({
        messageId: message.id,
        userId: message.author.id,
        allianceId: resolvedAlliance.id,
        fileHash,
        filePath,
        ocr: typedOcr,
      });
    } catch (err) {
      logger.error(
        { messageId: message.id, filename, err: String(err) },
        'Upsert failed',
      );
      lines.push(`❌ **${filename}** — erreur base de données : ${String(err)}`);
      return;
    }

    if (upsertResult.status === 'duplicate') {
      lines.push(`🔁 **${filename}** — capture déjà traitée (doublon).`);
      return;
    }

    if (upsertResult.status === 'unknown_event') {
      lines.push(
        `⚠️ **${filename}** — type d'événement inconnu : \`${upsertResult.eventType}\`. Utilisez \`/upload event:<type>\`.`,
      );
      return;
    }

    if (upsertResult.status === 'missing_datetime') {
      lines.push(
        `⚠️ **${filename}** — date/heure de l'événement illisible sur la capture. Recadrez l'écran (en-tête visible) et renvoyez-la.`,
      );
      return;
    }

    logger.info(
      { messageId: message.id, filename, eventId: upsertResult.eventId },
      'Upsert successful',
    );
    embeds.push(buildEventEmbed(filename, typedOcr, upsertResult));
  }

  const channel = message.channel as TextChannel;
  const total = images.size;
  let processed = 0;
  for (const [, att] of images) {
    await processOneAttachment(att);
    processed += 1;
    // Skip the report after the last image: the summary edit right below
    // immediately supersedes it, so it'd only add a redundant edit call.
    if (processed < total) {
      const successCount = embeds.length;
      const warnCount = lines.filter((l) => l.startsWith('⚠️') || l.startsWith('🔁')).length;
      const errCount = lines.filter((l) => l.startsWith('❌')).length;
      await safeProgressEdit(
        ackReply,
        channel,
        `🔄 Image ${processed}/${total}... (${successCount} ✅, ${warnCount} ⚠️, ${errCount} ❌)`,
      );
    }
  }

  if (lines.length === 0 && embeds.length === 0) {
    await ackReply.edit('✅ Done.');
  } else if (embeds.length > 0) {
    await ackReply.edit({
      content: lines.length > 0 ? lines.join('\n') : '',
      embeds,
    });
  } else {
    await ackReply.edit(lines.join('\n'));
  }

  // Send raw texts of rejected members (unknown players skipped during stats upsert).
  // Each entry is wrapped in a code block. Chunks are kept under Discord's 2000-char limit.
  if (allRejectedRawTexts.length > 0) {
    const header = `📋 **Raw texts rejetés (${allRejectedRawTexts.length} joueur(s) inconnu(s)) :**`;
    const chunks = _buildRejectedRawChunks(header, allRejectedRawTexts);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }
}

const _DISCORD_MAX_LEN = 1990; // leave margin below Discord's 2000-char limit

function _buildRejectedRawChunks(header: string, rawTexts: string[]): string[] {
  const chunks: string[] = [];
  let current = header;

  for (const raw of rawTexts) {
    const block = `\n\`\`\`\n${raw}\n\`\`\``;
    if (current.length + block.length > _DISCORD_MAX_LEN) {
      chunks.push(current);
      current = block.trimStart();
    } else {
      current += block;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current);
  }

  return chunks;
}
