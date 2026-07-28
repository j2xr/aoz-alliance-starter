import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';
import type { Message, EmbedBuilder } from 'discord.js';
import { isOcrError } from '@alliance-tracker/shared-types';
import { requireAlliance } from '../lib/alliance.js';
import {
  ensureKind,
  processImageAttachment,
  routeOcrResult,
  type OcrRoutingMessages,
} from '../lib/ingestion.js';
import { supabase } from '../lib/supabase.js';
import logger from '../logger.js';
import { isImageAttachment } from '../lib/attachment.js';
import { messages } from '../lib/messages.js';
import { capDiscordContent } from '../lib/discord-limits.js';

// Shared wording (B4), same object as messageCreate.ts's MESSAGES —
// `databaseError`'s second param (the raw error) is deliberately ignored:
// the detail goes to logger.error only, never back to Discord.
const OCR_ROUTING_MESSAGES: OcrRoutingMessages = {
  screenUnrecognized: messages.screenUnrecognized,
  ocrError: messages.ocrError,
  databaseError: (filename) => messages.databaseError(filename),
  unknownEventType: messages.unknownEventType,
  missingDatetime: messages.missingDatetime,
};

const MESSAGE_URL_RE =
  /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/\d+\/(\d+)\/(\d+)/;

// Code expected by the OCR service to force routing to the donation parser
// (cf. apps/ocr-service/app/dispatcher.py: DONATION_CODE).
const DONATION_OCR_CODE = 'contribution_ranking';

export const data = new SlashCommandBuilder()
  .setName('upload')
  .setDescription(
    'Reprocess a screenshot, forcing its type (event/donation) — /reprocess = re-run as-is',
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('message_url')
      .setDescription(
        'URL of the Discord message containing the screenshots to reprocess',
      )
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('kind')
      .setDescription('Screen type to force (default: event)')
      .setRequired(false)
      .addChoices(
        { name: 'event', value: 'event' },
        { name: 'donation', value: 'donation' },
      ),
  )
  .addStringOption((opt) =>
    opt
      .setName('event_type')
      .setDescription('Event type code (required if kind=event)')
      .setAutocomplete(true),
  )
  .addBooleanOption((opt) =>
    opt
      .setName('force_llm')
      .setDescription('Force the LLM on every line (ignore the OCR confidence threshold)')
      .setRequired(false),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().trim().toLowerCase();

  const { data: eventTypes, error } = await supabase
    .from('at_event_types')
    .select('code, display_name')
    .order('code');

  if (error) {
    logger.error({ err: String(error) }, 'event_type autocomplete query failed');
    await interaction.respond([]);
    return;
  }

  const matches = (eventTypes ?? []).filter(
    (et: { code: string; display_name: string }) =>
      focused.length === 0 ||
      et.code.toLowerCase().includes(focused) ||
      et.display_name.toLowerCase().includes(focused),
  );

  await interaction.respond(
    matches.slice(0, 25).map((et: { code: string; display_name: string }) => ({
      name: `${et.display_name} (${et.code})`,
      value: et.code,
    })),
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const messageUrl = interaction.options.getString('message_url', true);
  const kind = (interaction.options.getString('kind') ?? 'event') as 'event' | 'donation';
  const eventTypeCode = interaction.options.getString('event_type');
  const forceLlm = interaction.options.getBoolean('force_llm') ?? false;
  if (eventTypeCode !== null &&
      (eventTypeCode.trim().length === 0 || eventTypeCode.length > 50)) {
    await interaction.editReply('❌ event_type must be between 1 and 50 characters.');
    return;
  }

  let ocrOverrideCode: string;
  let eventTypeDisplayName: string | null = null;

  if (kind === 'donation') {
    ocrOverrideCode = DONATION_OCR_CODE;
  } else {
    if (!eventTypeCode) {
      await interaction.editReply(
        '❌ `event_type` is required when `kind=event`. For example, specify `event_type:polar_invasion`.',
      );
      return;
    }

    // Validate event type exists in DB
    const { data: et, error: etError } = await supabase
      .from('at_event_types')
      .select('id, display_name')
      .eq('code', eventTypeCode)
      .maybeSingle();

    if (etError) throw etError;
    if (!et) {
      await interaction.editReply(
        `❌ Unknown event type: \`${eventTypeCode}\`. Check the codes in \`at_event_types\`.`,
      );
      return;
    }
    ocrOverrideCode = eventTypeCode;
    eventTypeDisplayName = (et as { display_name: string }).display_name;
  }

  // Parse Discord message URL
  const match = MESSAGE_URL_RE.exec(messageUrl);
  if (!match) {
    await interaction.editReply(
      '❌ Invalid message URL. Expected format: `https://discord.com/channels/<guild>/<channel>/<message>`',
    );
    return;
  }

  const channelId = match[1]!;
  const messageId = match[2]!;

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

  // Remove existing upload records so re-processing can proceed
  await supabase
    .from('at_screenshot_uploads')
    .delete()
    .eq('discord_message_id', messageId)
    .eq('alliance_id', alliance.id);

  const images = originalMessage.attachments.filter(
    (att) => isImageAttachment(att.contentType ?? null, att.name),
  );

  if (images.size === 0) {
    await interaction.editReply('❌ No image found in this message.');
    return;
  }

  const plural = images.size > 1 ? 's' : '';
  const kindLabel = kind === 'donation' ? '(donations)' : `(${eventTypeDisplayName ?? eventTypeCode ?? 'event'})`;
  const llmNote = forceLlm ? ' (LLM forced on every line)' : '';
  await interaction.editReply(
    `⏳ Processing ${images.size} screenshot${plural} ${kindLabel}${llmNote}. This can take several minutes — **please do not upload again**.`,
  );

  const lines: string[] = [];
  const embeds: EmbedBuilder[] = [];

  for (const [, att] of images) {
    let result;
    try {
      result = await processImageAttachment(
        messageId,
        att.url,
        att.name,
        ocrOverrideCode,
        forceLlm,
      );
    } catch (err) {
      logger.error(
        { messageId, filename: att.name, err: String(err) },
        'upload reprocess failed',
      );
      lines.push(messages.unexpectedError(att.name));
      continue;
    }

    if (!result.ok) {
      lines.push(`❌ **${result.filename}** — ${result.error}`);
      continue;
    }

    const { filename, fileHash, filePath, ocr: rawOcr } = result;

    // The OCR override forces a specific parser; defensively re-check the
    // shape rather than trusting a possibly stale OCR build. This has to
    // happen before routeOcrResult, which just dispatches on whatever kind
    // it's given — it has no notion of what kind THIS caller demanded.
    if (!isOcrError(rawOcr)) {
      const typedKind = ensureKind(rawOcr).kind;
      if (typedKind !== kind) {
        lines.push(
          `⚠️ **${filename}** — inconsistent OCR response (kind=${typedKind}, expected=${kind}). Does the OCR service need redeploying?`,
        );
        continue;
      }
    }

    const routed = await routeOcrResult({
      message: { id: messageId, author: { id: originalMessage.author.id }, createdAt: originalMessage.createdAt },
      allianceId: alliance.id,
      fileHash,
      filePath,
      filename,
      ocr: rawOcr,
      messages: OCR_ROUTING_MESSAGES,
    });

    if (routed.line) lines.push(routed.line);
    if (routed.embed) embeds.push(routed.embed);
  }

  if (embeds.length > 0) {
    await interaction.editReply({
      ...(lines.length > 0 && { content: capDiscordContent(lines.join('\n')) }),
      embeds,
    });
  } else {
    await interaction.editReply(
      lines.length > 0 ? capDiscordContent(lines.join('\n')) : '✅ Reprocessing complete.',
    );
  }
}
