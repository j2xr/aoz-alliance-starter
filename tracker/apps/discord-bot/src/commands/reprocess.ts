import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Message } from 'discord.js';
import { requireAlliance, resolveAlliance } from '../lib/alliance.js';
import { isImageAttachment } from '../lib/attachment.js';
import { reprocessMessageScreenshots } from '../lib/reprocess.js';
import logger from '../logger.js';

const MESSAGE_URL_RE =
  /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/\d+\/(\d+)\/(\d+)/;

export const data = new SlashCommandBuilder()
  .setName('reprocess')
  .setDescription('Re-run OCR on a screenshot as-is — see /upload to force its type')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('message_url')
      .setDescription('URL of the Discord message containing the screenshots')
      .setRequired(true),
  )
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

  const messageUrl = interaction.options.getString('message_url', true);
  const forceLlm = interaction.options.getBoolean('force_llm') ?? false;

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

  // Alliance of the TARGET channel (extracted from the message URL), which
  // must match the invoking channel's — otherwise a member could reprocess
  // (and read back the results of) another alliance's screenshots just by
  // pasting a message URL from a channel the bot can see.
  const alliance = await resolveAlliance(channelId);
  if (!alliance) {
    await interaction.editReply(
      '⚠️ This channel is not linked to an alliance.',
    );
    return;
  }

  if (alliance.id !== invokingAlliance.id) {
    await interaction.editReply(
      '❌ That message is not in an alliance channel you can reprocess from.',
    );
    return;
  }

  let originalMessage: Message<boolean>;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      await interaction.editReply('❌ Channel not found or inaccessible.');
      return;
    }
    originalMessage = await channel.messages.fetch(messageId);
  } catch (err) {
    logger.error(
      { channelId, messageId, err: String(err) },
      'Failed to fetch original message',
    );
    await interaction.editReply(
      '❌ Message not found. The bot must have access to the channel.',
    );
    return;
  }

  const imageCount = originalMessage.attachments.filter((att) =>
    isImageAttachment(att.contentType ?? null, att.name),
  ).size;

  if (imageCount === 0) {
    await interaction.editReply('❌ No image found in this message.');
    return;
  }

  const plural = imageCount > 1 ? 's' : '';
  const llmNote = forceLlm ? ' (LLM forced on every line)' : '';
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
    await interaction.editReply(lines.join('\n') || '✅ Reprocessing complete.');
  }

  if (rejectedRawTexts.length > 0) {
    const header = `📋 **Rejected raw texts (${rejectedRawTexts.length} unknown player(s)):**`;
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
