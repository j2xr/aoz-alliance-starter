import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SendableChannels } from 'discord.js';
import { config } from '../config.js';
import { requireAlliance } from '../lib/alliance.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import {
  fetchChannelImageMessages,
  reprocessMessageScreenshots,
} from '../lib/reprocess.js';
import logger from '../logger.js';

// Le retraitement d'un canal complet peut durer bien plus que les ~15 minutes
// de validité du token d'interaction. Passé ce délai, editReply échoue
// (Unknown Webhook) : on bascule alors sur un message ordinaire dans le canal
// plutôt que de laisser l'exception avorter le retraitement en cours.
async function safeProgressReply(
  interaction: ChatInputCommandInteraction,
  channel: SendableChannels,
  content: string,
): Promise<void> {
  try {
    await interaction.editReply({ content });
  } catch (err) {
    logger.warn(
      { channelId: interaction.channelId, err: String(err) },
      'editReply failed (interaction token expired?), falling back to channel.send',
    );
    try {
      await channel.send(content);
    } catch (sendErr) {
      logger.error(
        { channelId: interaction.channelId, err: String(sendErr) },
        'channel.send fallback failed',
      );
    }
  }
}

function summarizeLines(lines: string[], maxLines = 20): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  return [
    ...lines.slice(0, maxLines),
    `... ${lines.length - maxLines} autre(s) resultat(s) masque(s).`,
  ];
}

export const data = new SlashCommandBuilder()
  .setName('reprocess-channel')
  .setDescription('Retraiter toutes les captures du canal courant')
  .addBooleanOption((opt) =>
    opt
      .setName('force_llm')
      .setDescription('Forcer le LLM sur toutes les lignes (ignorer le seuil de confiance OCR)')
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
    await interaction.editReply('❌ Channel introuvable ou inaccessible.');
    return;
  }

  await interaction.editReply(
    `⏳ Inventaire des captures du canal en cours${forceLlm ? ' (LLM force)' : ''}...`,
  );

  const messages = await fetchChannelImageMessages(channel);
  if (messages.length === 0) {
    await interaction.editReply('❌ Aucune capture trouvee dans ce canal.');
    return;
  }

  await interaction.editReply(
    `⏳ Retraitement de ${messages.length} message(s) avec captures${forceLlm ? ' (LLM force sur toutes les lignes)' : ''}. Cette operation peut prendre longtemps.`,
  );

  // Messages traités en parallèle (pool borné) : le gros du temps par capture
  // est de l'attente (download + polling OCR). La progression compte les
  // messages TERMINÉS ; l'agrégation se fait ensuite depuis le tableau
  // ordonné pour garder les lignes dans l'ordre du canal.
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
          `⏳ Progression: ${completed}/${messages.length} message(s), ${completedImages} capture(s) retraitee(s)...`,
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
    '✅ Retraitement du canal termine.',
    `Messages avec captures : ${messages.length}`,
    `Captures trouvees : ${totalImages}`,
    `Succes : ${successCount}`,
    `Doublons : ${duplicateCount}`,
    `Types inconnus : ${unknownEventCount}`,
    `Echecs : ${failedCount}`,
  ];

  const details = summarizeLines(lines);
  const content = [...summary, ...(details.length > 0 ? ['', ...details] : [])]
    .join('\n')
    .slice(0, 1900);

  await safeProgressReply(interaction, channel, content);
}
