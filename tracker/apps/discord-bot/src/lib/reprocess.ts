import type { EmbedBuilder, Message, TextBasedChannel } from 'discord.js';
import { config } from '../config.js';
import logger from '../logger.js';
import { isImageAttachment } from './attachment.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  processImageAttachment,
  routeOcrResult,
  type OcrRouteOutcome,
  type OcrRoutingMessages,
} from './ingestion.js';

// Wording specific to the /reprocess path — see messageCreate.ts for the
// (deliberately different) /upload-time wording. Unifying these is B4, not
// this refactor.
const MESSAGES: OcrRoutingMessages = {
  screenUnrecognized: (filename) => `⚠️ **${filename}** — type d'écran non reconnu. Utilisez \`/upload\`.`,
  ocrError: (filename, error, detail) =>
    `⚠️ **${filename}** — OCR: ${error}${detail ? ` (${detail})` : ''}`,
  databaseError: (filename, err) => `❌ **${filename}** — database error: ${err}`,
  unknownEventType: (filename, eventType) =>
    `⚠️ **${filename}** — type d'événement inconnu: \`${eventType}\`. Utilisez \`/upload event_type:<type>\`.`,
  missingDatetime: (filename) => `⚠️ **${filename}** — date/heure de l'événement illisible sur la capture.`,
};

export type ReprocessMessageParams = {
  message: Message<boolean>;
  allianceId: string;
  eventTypeOverride?: string;
  forceLlm?: boolean;
};

export type ReprocessMessageResult = {
  imageCount: number;
  successCount: number;
  duplicateCount: number;
  unknownEventCount: number;
  failedCount: number;
  lines: string[];
  embeds: EmbedBuilder[];
  rejectedRawTexts: string[];
};

export async function reprocessMessageScreenshots(
  params: ReprocessMessageParams,
): Promise<ReprocessMessageResult> {
  const { message, allianceId, eventTypeOverride, forceLlm = false } = params;

  const images = message.attachments.filter((att) =>
    isImageAttachment(att.contentType ?? null, att.name),
  );

  // Les pièces jointes indépendantes sont traitées en parallèle (pool borné) :
  // l'essentiel du temps par image est de l'attente (download + polling OCR).
  // Les upserts concurrents sont sûrs (onConflict / ignoreDuplicates / 23505).
  // Les résultats sont repliés dans l'ordre d'origine des pièces jointes.
  const outcomes = await mapWithConcurrency(
    [...images.values()],
    config.reprocessConcurrency,
    (att) => processOneAttachment(att, { message, allianceId, eventTypeOverride, forceLlm }),
  );

  const lines: string[] = [];
  const embeds: EmbedBuilder[] = [];
  const rejectedRawTexts: string[] = [];
  let successCount = 0;
  let duplicateCount = 0;
  let unknownEventCount = 0;
  let failedCount = 0;

  for (const o of outcomes) {
    if (o.outcome === 'success') successCount += 1;
    else if (o.outcome === 'duplicate') duplicateCount += 1;
    else if (o.outcome === 'unknown_event') unknownEventCount += 1;
    else failedCount += 1;
    if (o.line) lines.push(o.line);
    if (o.embed) embeds.push(o.embed);
    if (o.rejectedRawTexts) rejectedRawTexts.push(...o.rejectedRawTexts);
  }

  return {
    imageCount: images.size,
    successCount,
    duplicateCount,
    unknownEventCount,
    failedCount,
    lines,
    embeds,
    rejectedRawTexts,
  };
}

async function processOneAttachment(
  att: { url: string; name: string },
  ctx: {
    message: Message<boolean>;
    allianceId: string;
    eventTypeOverride?: string | undefined;
    forceLlm: boolean;
  },
): Promise<OcrRouteOutcome> {
  const { message, allianceId, eventTypeOverride, forceLlm } = ctx;

  let result;
  try {
    result = await processImageAttachment(
      message.id,
      att.url,
      att.name,
      eventTypeOverride,
      forceLlm,
    );
  } catch (err) {
    logger.error(
      { messageId: message.id, filename: att.name, err: String(err) },
      'reprocess attachment failed',
    );
    return { outcome: 'failed', line: `❌ **${att.name}** — unexpected error: ${String(err)}` };
  }

  if (!result.ok) {
    return { outcome: 'failed', line: `❌ **${result.filename}** — ${result.error}` };
  }

  const { filename, fileHash, filePath, ocr } = result;

  return routeOcrResult({
    message,
    allianceId,
    fileHash,
    filePath,
    filename,
    ocr,
    messages: MESSAGES,
  });
}

// Bufferise volontairement tous les messages à images du canal : le total est
// nécessaire d'emblée pour le dénominateur de progression et le récapitulatif,
// et quelques milliers d'objets Message tiennent largement en mémoire. Un
// streaming imposerait deux passes ou une progression sans dénominateur.
export async function fetchChannelImageMessages(
  channel: TextBasedChannel,
): Promise<Message<boolean>[]> {
  const messages: Message<boolean>[] = [];
  let before: string | undefined;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before !== undefined ? { before } : {}),
    });

    if (batch.size === 0) {
      break;
    }

    for (const [, message] of batch) {
      const hasImage = message.attachments.some((att) =>
        isImageAttachment(att.contentType ?? null, att.name),
      );
      if (hasImage) {
        messages.push(message);
      }
    }

    before = batch.last()?.id;
    if (!before) {
      break;
    }
  }

  return messages.reverse();
}
