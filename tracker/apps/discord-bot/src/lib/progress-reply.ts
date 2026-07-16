import type { ChatInputCommandInteraction, Message, SendableChannels } from 'discord.js';
import logger from '../logger.js';

async function safeSend(
  edit: () => Promise<unknown>,
  channel: SendableChannels,
  content: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await edit();
  } catch (err) {
    logger.warn(
      { ...context, err: String(err) },
      'Progress edit failed, falling back to channel.send',
    );
    try {
      await channel.send(content);
    } catch (sendErr) {
      logger.error({ ...context, err: String(sendErr) }, 'channel.send fallback failed');
    }
  }
}

/** Edit an interaction's reply, falling back to a plain channel message if the
 * edit fails -- most commonly because a long-running job outlived the
 * interaction token's ~15 minute validity window. */
export async function safeProgressReply(
  interaction: ChatInputCommandInteraction,
  channel: SendableChannels,
  content: string,
): Promise<void> {
  await safeSend(
    () => interaction.editReply({ content }),
    channel,
    content,
    { channelId: interaction.channelId },
  );
}

/** Edit a regular message (e.g. the bot's own "⏳ Processing..." ack reply),
 * falling back to a plain channel message if the edit fails (e.g. the
 * message was deleted meanwhile). */
export async function safeProgressEdit(
  message: Message,
  channel: SendableChannels,
  content: string,
): Promise<void> {
  await safeSend(
    () => message.edit(content),
    channel,
    content,
    { channelId: message.channelId },
  );
}
