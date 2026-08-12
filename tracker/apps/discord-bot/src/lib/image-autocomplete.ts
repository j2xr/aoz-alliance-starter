import type { AutocompleteInteraction } from 'discord.js';
import { imageAttachmentsOf } from './attachment.js';
import logger from '../logger.js';

// Shared with /reprocess and /upload for parsing the message_url option.
export const MESSAGE_URL_RE =
  /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/\d+\/(\d+)\/(\d+)/;

/**
 * Autocomplete choices for the `image` option of /reprocess and /upload:
 * "#1 — <filename>" with the 1-based index as the (integer) value. Reads the
 * message_url already typed in the same interaction, fetches the message, and
 * lists its image attachments in operator order.
 *
 * Autocomplete has a hard, non-deferrable 3s Discord budget and no reply state
 * to fall back on, so every failure path (missing/partial/unparsable URL, a
 * fetch error, no images) resolves to [] rather than throwing.
 */
export async function imageChoicesForMessageUrl(
  interaction: AutocompleteInteraction,
): Promise<{ name: string; value: number }[]> {
  const messageUrl = interaction.options.getString('message_url');
  if (!messageUrl) return [];

  const match = MESSAGE_URL_RE.exec(messageUrl);
  if (!match) return [];
  const channelId = match[1]!;
  const messageId = match[2]!;

  let images;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return [];
    const message = await channel.messages.fetch(messageId);
    images = imageAttachmentsOf(message);
  } catch (err) {
    logger.error({ channelId, messageId, err: String(err) }, 'image autocomplete fetch failed');
    return [];
  }

  const focused = interaction.options.getFocused().trim().toLowerCase();
  const choices = images.map((att, i) => ({
    // Discord caps choice labels at 100 chars.
    name: `#${i + 1} — ${att.name}`.slice(0, 100),
    value: i + 1,
  }));

  const filtered =
    focused.length === 0
      ? choices
      : choices.filter(
          (c) => c.name.toLowerCase().includes(focused) || String(c.value) === focused,
        );

  return filtered.slice(0, 25);
}
