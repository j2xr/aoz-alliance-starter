import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Message } from 'discord.js';
import { resolveAlliance } from '../lib/alliance.js';
import { isImageAttachment } from '../lib/attachment.js';
import { reprocessMessageScreenshots } from '../lib/reprocess.js';
import logger from '../logger.js';

const MESSAGE_URL_RE =
  /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/\d+\/(\d+)\/(\d+)/;

export const data = new SlashCommandBuilder()
  .setName('reprocess')
  .setDescription("Forcer le retraitement d'une capture depuis son message Discord")
  .addStringOption((opt) =>
    opt
      .setName('message_url')
      .setDescription('URL du message Discord contenant les captures')
      .setRequired(true),
  )
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

  const messageUrl = interaction.options.getString('message_url', true);
  const forceLlm = interaction.options.getBoolean('force_llm') ?? false;

  const match = MESSAGE_URL_RE.exec(messageUrl);
  if (!match) {
    await interaction.editReply(
      '❌ URL de message invalide. Format attendu : `https://discord.com/channels/<guild>/<channel>/<message>`',
    );
    return;
  }

  const channelId = match[1]!;
  const messageId = match[2]!;

  // Alliance du channel CIBLE (extrait de l'URL du message), pas celui de
  // l'interaction — requireAlliance ne s'applique volontairement pas ici.
  const alliance = await resolveAlliance(channelId);
  if (!alliance) {
    await interaction.editReply(
      "⚠️ Ce channel n'est pas associé à une alliance.",
    );
    return;
  }

  let originalMessage: Message<boolean>;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      await interaction.editReply('❌ Channel introuvable ou inaccessible.');
      return;
    }
    originalMessage = await channel.messages.fetch(messageId);
  } catch (err) {
    logger.error(
      { channelId, messageId, err: String(err) },
      'Failed to fetch original message',
    );
    await interaction.editReply(
      "❌ Message introuvable. Le bot doit avoir acces au channel.",
    );
    return;
  }

  const imageCount = originalMessage.attachments.filter((att) =>
    isImageAttachment(att.contentType ?? null, att.name),
  ).size;

  if (imageCount === 0) {
    await interaction.editReply('❌ Aucune image trouvee dans ce message.');
    return;
  }

  const plural = imageCount > 1 ? 's' : '';
  const llmNote = forceLlm ? ' (LLM force sur toutes les lignes)' : '';
  await interaction.editReply(
    `⏳ Processing ${imageCount} screenshot${plural}${llmNote}. This can take several minutes - please do not upload again.`,
  );

  const { lines, embeds, rejectedRawTexts } = await reprocessMessageScreenshots({
    message: originalMessage,
    allianceId: alliance.id,
    forceLlm,
  });

  if (embeds.length > 0) {
    await interaction.editReply({
      ...(lines.length > 0 ? { content: lines.join('\n') } : {}),
      embeds,
    });
  } else {
    await interaction.editReply(lines.join('\n') || '✅ Retraitement termine.');
  }

  if (rejectedRawTexts.length > 0) {
    const header = `📋 **Raw texts rejetés (${rejectedRawTexts.length} joueur(s) inconnu(s)) :**`;
    const chunks = _buildRejectedRawChunks(header, rejectedRawTexts);
    for (const chunk of chunks) {
      await interaction.followUp({ content: chunk, ephemeral: false });
    }
  }
}

const _DISCORD_MAX_LEN = 1990;

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

  if (current.trim().length > 0) chunks.push(current);
  return chunks;
}
