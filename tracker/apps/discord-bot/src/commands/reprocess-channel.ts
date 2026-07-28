import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { requireAlliance } from '../lib/alliance.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { safeProgressReply } from '../lib/progress-reply.js';
import {
  fetchChannelImageMessages,
  reprocessMessageScreenshots,
} from '../lib/reprocess.js';
import logger from '../logger.js';

function summarizeLines(lines: string[], maxLines = 20): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  return [
    ...lines.slice(0, maxLines),
    `... ${lines.length - maxLines} other result(s) hidden.`,
  ];
}

export const data = new SlashCommandBuilder()
  .setName('reprocess-channel')
  .setDescription('Reprocess every screenshot in the current channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addBooleanOption((opt) =>
    opt
      .setName('force_llm')
      .setDescription('Force the LLM on every line (ignore the OCR confidence threshold)')
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const forceLlm = interaction.options.getBoolean('force_llm') ?? false;
  const channel = await interaction.client.channels.fetch(interaction.channelId);

  if (!channel?.isTextBased() || !channel.isSendable()) {
    await interaction.editReply('❌ Channel not found or inaccessible.');
    return;
  }

  await interaction.editReply(
    `⏳ Taking inventory of the channel's screenshots${forceLlm ? ' (LLM forced)' : ''}...`,
  );

  const messages = await fetchChannelImageMessages(channel);
  if (messages.length === 0) {
    await interaction.editReply('❌ No screenshot found in this channel.');
    return;
  }

  await interaction.editReply(
    `⏳ Reprocessing ${messages.length} message(s) with screenshots${forceLlm ? ' (LLM forced on every line)' : ''}. This may take a while.`,
  );

  // Messages processed in parallel (bounded pool): most of the time per
  // screenshot is waiting (download + OCR polling). Progress counts
  // COMPLETED messages; aggregation then happens from the ordered array to
  // keep lines in channel order.
  let completed = 0;
  let completedImages = 0;
  const results = await mapWithConcurrency(
    messages,
    config.reprocessConcurrency,
    async (message) => {
      const result = await reprocessMessageScreenshots({
        message,
        allianceId: alliance.id,
        forceLlm,
      });
      completed += 1;
      completedImages += result.imageCount;
      if (completed % 5 === 0 || completed === messages.length) {
        await safeProgressReply(
          interaction,
          channel,
          `⏳ Progress: ${completed}/${messages.length} message(s), ${completedImages} screenshot(s) reprocessed...`,
        );
      }
      return result;
    },
  );

  let totalImages = 0;
  let successCount = 0;
  let duplicateCount = 0;
  let unknownEventCount = 0;
  let failedCount = 0;
  const lines: string[] = [];

  for (const result of results) {
    totalImages += result.imageCount;
    successCount += result.successCount;
    duplicateCount += result.duplicateCount;
    unknownEventCount += result.unknownEventCount;
    failedCount += result.failedCount;
    lines.push(...result.lines);
  }

  logger.info(
    {
      channelId: interaction.channelId,
      messages: messages.length,
      totalImages,
      successCount,
      duplicateCount,
      unknownEventCount,
      failedCount,
      forceLlm,
    },
    'Channel reprocess completed',
  );

  const summary = [
    '✅ Channel reprocessing complete.',
    `Messages with screenshots: ${messages.length}`,
    `Screenshots found: ${totalImages}`,
    `Successes: ${successCount}`,
    `Duplicates: ${duplicateCount}`,
    `Unknown types: ${unknownEventCount}`,
    `Failures: ${failedCount}`,
  ];

  const details = summarizeLines(lines);
  const content = [...summary, ...(details.length > 0 ? ['', ...details] : [])]
    .join('\n')
    .slice(0, 1900);

  await safeProgressReply(interaction, channel, content);
}
