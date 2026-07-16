import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Message, EmbedBuilder } from 'discord.js';
import { isOcrError } from '@alliance-tracker/shared-types';
import { requireAlliance } from '../lib/alliance.js';
import { ensureKind, processImageAttachment } from '../lib/ingestion.js';
import {
  recordUploadError,
  upsertDonationResult,
  upsertEventResult,
} from '../lib/upsert.js';
import { buildDonationEmbed, buildEventEmbed } from '../lib/embed.js';
import { supabase } from '../lib/supabase.js';
import logger from '../logger.js';
import { isImageAttachment } from '../lib/attachment.js';

const MESSAGE_URL_RE =
  /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/\d+\/(\d+)\/(\d+)/;

// Code attendu par le service OCR pour forcer le routage vers le parser de
// dons (cf. apps/ocr-service/app/dispatcher.py: DONATION_CODE).
const DONATION_OCR_CODE = 'contribution_ranking';

export const data = new SlashCommandBuilder()
  .setName('upload')
  .setDescription(
    "Forcer le retraitement OCR d'une capture (événement ou don)",
  )
  .addStringOption((opt) =>
    opt
      .setName('message_url')
      .setDescription(
        'URL du message Discord contenant les captures à retraiter',
      )
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('kind')
      .setDescription("Type d'écran à forcer (par défaut : event)")
      .setRequired(false)
      .addChoices(
        { name: 'event', value: 'event' },
        { name: 'donation', value: 'donation' },
      ),
  )
  .addStringOption((opt) =>
    opt
      .setName('event_type')
      .setDescription("Code du type d'événement (requis si kind=event)"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  const alliance = await requireAlliance(interaction);
  if (!alliance) return;

  const messageUrl = interaction.options.getString('message_url', true);
  const kind = (interaction.options.getString('kind') ?? 'event') as 'event' | 'donation';
  const eventTypeCode = interaction.options.getString('event_type');
  if (eventTypeCode !== null &&
      (eventTypeCode.trim().length === 0 || eventTypeCode.length > 50)) {
    await interaction.editReply('❌ event_type doit faire entre 1 et 50 caractères.');
    return;
  }

  let ocrOverrideCode: string;
  let eventTypeDisplayName: string | null = null;

  if (kind === 'donation') {
    ocrOverrideCode = DONATION_OCR_CODE;
  } else {
    if (!eventTypeCode) {
      await interaction.editReply(
        '❌ `event_type` est requis quand `kind=event`. Indiquez par exemple `event_type:polar_invasion`.',
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
        `❌ Type d'événement inconnu : \`${eventTypeCode}\`. Vérifiez les codes dans \`at_event_types\`.`,
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
      "❌ URL de message invalide. Format attendu : `https://discord.com/channels/<guild>/<channel>/<message>`",
    );
    return;
  }

  const channelId = match[1]!;
  const messageId = match[2]!;

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
      '❌ Message introuvable. Le bot doit avoir accès au channel.',
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
    await interaction.editReply('❌ Aucune image trouvée dans ce message.');
    return;
  }

  const plural = images.size > 1 ? 's' : '';
  const kindLabel = kind === 'donation' ? '(donations)' : `(${eventTypeDisplayName ?? eventTypeCode ?? 'event'})`;
  await interaction.editReply(
    `⏳ Processing ${images.size} screenshot${plural} ${kindLabel}. This can take several minutes — **please do not upload again**.`,
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
      );
    } catch (err) {
      logger.error(
        { messageId, filename: att.name, err: String(err) },
        'upload reprocess failed',
      );
      lines.push(`❌ **${att.name}** — erreur inattendue : ${String(err)}`);
      continue;
    }

    if (!result.ok) {
      lines.push(`❌ **${result.filename}** — ${result.error}`);
      continue;
    }

    const { filename, fileHash, filePath, ocr: rawOcr } = result;

    if (isOcrError(rawOcr)) {
      const ocr = rawOcr;
      try {
        await recordUploadError({
          messageId,
          userId: originalMessage.author.id,
          allianceId: alliance.id,
          fileHash,
          filePath,
          status: 'failed',
          errorMessage: ocr.error + (ocr.detail ? `: ${ocr.detail}` : ''),
        });
      } catch (err) {
        logger.error({ err: String(err) }, 'Failed to record upload error');
      }
      lines.push(
        `⚠️ **${filename}** — OCR : ${ocr.error}${ocr.detail ? ` (${ocr.detail})` : ''}`,
      );
      continue;
    }

    // Normalise les résultats OCR legacy sans discriminant `kind`
    // (même traitement que messageCreate/reprocess).
    const ocr = ensureKind(rawOcr);

    if (kind === 'donation') {
      // The OCR override forces the donation parser; defensively re-check the
      // shape rather than trusting a possibly stale OCR build.
      if (ocr.kind !== 'donation') {
        lines.push(
          `⚠️ **${filename}** — réponse OCR incohérente (kind=${(ocr as { kind?: string }).kind ?? '?'}). Service OCR à redéployer ?`,
        );
        continue;
      }

      let donationResult;
      try {
        donationResult = await upsertDonationResult({
          messageId,
          userId: originalMessage.author.id,
          allianceId: alliance.id,
          fileHash,
          filePath,
          messageCreatedAt: originalMessage.createdAt,
          ocr,
        });
      } catch (err) {
        logger.error(
          { messageId, filename, err: String(err) },
          'Donation upsert failed',
        );
        lines.push(`❌ **${filename}** — erreur base de données : ${String(err)}`);
        continue;
      }

      if (donationResult.status === 'duplicate') {
        lines.push(`🔁 **${filename}** — capture déjà traitée (doublon).`);
        continue;
      }
      if (donationResult.status === 'unsupported_period_type') {
        lines.push(
          `⚠️ **${filename}** — onglet \`${donationResult.periodType}\` non géré (V1 = Weekly uniquement).`,
        );
        continue;
      }

      embeds.push(buildDonationEmbed(filename, ocr, donationResult));
      continue;
    }

    // kind === 'event'
    if (ocr.kind !== 'event') {
      lines.push(
        `⚠️ **${filename}** — réponse OCR de type \`${ocr.kind}\` alors que kind=event a été forcé. Vérifiez la capture.`,
      );
      continue;
    }

    let upsertResult;
    try {
      upsertResult = await upsertEventResult({
        messageId,
        userId: originalMessage.author.id,
        allianceId: alliance.id,
        fileHash,
        filePath,
        ocr,
      });
    } catch (err) {
      logger.error(
        { messageId, filename, err: String(err) },
        'Upsert failed',
      );
      lines.push(
        `❌ **${filename}** — erreur base de données : ${String(err)}`,
      );
      continue;
    }

    if (upsertResult.status === 'duplicate') {
      lines.push(`🔁 **${filename}** — capture déjà traitée (doublon).`);
      continue;
    }

    if (upsertResult.status === 'unknown_event') {
      lines.push(
        `⚠️ **${filename}** — type toujours non reconnu : \`${upsertResult.eventType}\`.`,
      );
      continue;
    }

    if (upsertResult.status === 'missing_datetime') {
      lines.push(
        `⚠️ **${filename}** — date/heure de l'événement illisible sur la capture. Recadrez l'écran (en-tête visible) et renvoyez-la.`,
      );
      continue;
    }

    embeds.push(buildEventEmbed(filename, ocr, upsertResult));
  }

  if (embeds.length > 0) {
    await interaction.editReply({
      ...(lines.length > 0 && { content: lines.join('\n') }),
      embeds,
    });
  } else {
    await interaction.editReply(
      lines.join('\n') || '✅ Retraitement terminé.',
    );
  }
}
