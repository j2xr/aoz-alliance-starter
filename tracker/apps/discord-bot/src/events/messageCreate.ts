import type { Attachment, Message, EmbedBuilder, TextChannel } from 'discord.js';
import { config } from '../config.js';
import logger from '../logger.js';
import { processImageAttachment, routeOcrResult, type OcrRoutingMessages } from '../lib/ingestion.js';
import { resolveAlliance } from '../lib/alliance.js';
import type { AllianceRow } from '../lib/alliance.js';
import { isImageAttachment } from '../lib/attachment.js';
import { safeProgressEdit } from '../lib/progress-reply.js';
import { messages } from '../lib/messages.js';
import { capDiscordContent } from '../lib/discord-limits.js';

// Shared wording (B4) — see lib/messages.ts. `databaseError`'s second
// param (the raw error) is deliberately ignored: the detail goes to
// logger.error only, never back to Discord.
const MESSAGES: OcrRoutingMessages = {
  screenUnrecognized: messages.screenUnrecognized,
  ocrError: messages.ocrError,
  databaseError: (filename) => messages.databaseError(filename),
  unknownEventType: messages.unknownEventType,
  missingDatetime: messages.missingDatetime,
};

export async function handleMessageCreate(message: Message): Promise<void> {
  // Incoming webhooks post with author.bot === true; allowlisted ones (the
  // automated capture agent) are let through, every other bot is not.
  // webhookId is `string | null`, so narrow before the Set lookup.
  if (message.author.bot) {
    const { webhookId } = message;
    if (!webhookId || !config.allowedWebhookIds.has(webhookId)) return;
  }
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
    await ackReply.edit(messages.allianceResolutionError());
    return;
  }

  if (!alliance) {
    logger.warn({ channelId: message.channelId }, 'No alliance mapped to this channel');
    await ackReply.edit('⚠️ This channel is not linked to an alliance. Configure `discord_channel_id` in `at_alliances`.');
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
      lines.push(messages.unexpectedError(att.name));
      return;
    }

    if (!result.ok) {
      lines.push(`❌ **${result.filename}** — ${result.error}`);
      return;
    }

    const { filename, fileHash, filePath, ocr } = result;

    const routed = await routeOcrResult({
      message,
      allianceId: resolvedAlliance.id,
      fileHash,
      filePath,
      filename,
      ocr,
      messages: MESSAGES,
    });

    if (routed.line) lines.push(routed.line);
    if (routed.embed) embeds.push(routed.embed);
    if (routed.rejectedRawTexts) allRejectedRawTexts.push(...routed.rejectedRawTexts);
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
      content: lines.length > 0 ? capDiscordContent(lines.join('\n')) : '',
      embeds,
    });
  } else {
    await ackReply.edit(capDiscordContent(lines.join('\n')));
  }

  // Send raw texts of rejected members (unknown players skipped during stats upsert).
  // Each entry is wrapped in a code block. Chunks are kept under Discord's 2000-char limit.
  if (allRejectedRawTexts.length > 0) {
    const header = `📋 **Rejected raw texts (${allRejectedRawTexts.length} unknown player(s)):**`;
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
