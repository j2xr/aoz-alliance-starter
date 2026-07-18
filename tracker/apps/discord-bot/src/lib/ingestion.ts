import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EmbedBuilder } from 'discord.js';
import type { OcrError, OcrResponse, OcrResult } from '@alliance-tracker/shared-types';
import { isOcrError, isPlayerStatsResult } from '@alliance-tracker/shared-types';
import { config } from '../config.js';
import logger from '../logger.js';
import { sha256 } from './hash.js';
import { buildDonationEmbed, buildEventEmbed, buildPlayerStatsEmbed } from './embed.js';
import {
  recordUploadError,
  upsertDonationResult,
  upsertEventResult,
  upsertPlayerStatsResult,
} from './upsert.js';

export type AttachmentResult =
  | { ok: true; filename: string; fileHash: string; filePath: string; ocr: OcrResponse }
  | { ok: false; filename: string; error: string };

// Old OCR-service builds (pre-donations) returned an event-shaped result
// without a `kind` discriminator. Default to 'event' so routing keeps
// working during a rolling deploy. Shared by messageCreate, reprocess and
// /upload — every path that consumes an OCR result must normalize it.
export function ensureKind(ocr: OcrResult): OcrResult {
  if ((ocr as { kind?: string }).kind !== undefined) return ocr;
  return { ...(ocr as object), kind: 'event' } as OcrResult;
}

// Minimal structural shape both messageCreate's `Message` and reprocess's
// `Message<boolean>` satisfy — avoids importing discord.js's `Message` here
// just for three fields.
type OcrRouteMessageContext = {
  id: string;
  author: { id: string };
  createdAt: Date;
};

// Kept injectable rather than hardcoded here so routeOcrResult stays
// caller-agnostic; both real callers (messageCreate.ts, reprocess.ts) now
// pass the same wording from lib/messages.ts (B4) — this indirection mainly
// serves ingestion.test.ts, which injects distinctive wording to prove
// routeOcrResult actually uses what's passed in.
export type OcrRoutingMessages = {
  screenUnrecognized: (filename: string, detail: string) => string;
  ocrError: (filename: string, error: string, detail: string | undefined) => string;
  databaseError: (filename: string, err: string) => string;
  unknownEventType: (filename: string, eventType: string) => string;
  missingDatetime: (filename: string) => string;
};

export type RouteOcrResultParams = {
  message: OcrRouteMessageContext;
  allianceId: string;
  fileHash: string;
  filePath: string;
  filename: string;
  ocr: OcrResponse;
  messages: OcrRoutingMessages;
};

export type OcrRouteOutcome = {
  outcome: 'success' | 'duplicate' | 'unknown_event' | 'failed';
  line?: string;
  embed?: EmbedBuilder;
  rejectedRawTexts?: string[];
};

/**
 * Shared OCR-result → upsert routing, extracted from messageCreate.ts and
 * reprocess.ts (they duplicated this dispatch verbatim, error-handling and
 * all). Decides which upsert*Result to call based on `ocr.kind`, and turns
 * its status into a caller-agnostic outcome. Response wording that differs
 * between the two call sites is injected via `messages`.
 */
export async function routeOcrResult(params: RouteOcrResultParams): Promise<OcrRouteOutcome> {
  const { message, allianceId, fileHash, filePath, filename, ocr, messages } = params;

  if (isOcrError(ocr)) {
    const uploadStatus = ocr.error === 'unknown_event' ? ('unknown_event' as const) : ('failed' as const);
    try {
      await recordUploadError({
        messageId: message.id,
        userId: message.author.id,
        allianceId,
        fileHash,
        filePath,
        status: uploadStatus,
        errorMessage: ocr.error + (ocr.detail ? `: ${ocr.detail}` : ''),
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to record upload error');
    }

    if (uploadStatus === 'unknown_event') {
      return {
        outcome: 'unknown_event',
        line: messages.screenUnrecognized(filename, ocr.detail ?? ocr.error),
      };
    }
    return { outcome: 'failed', line: messages.ocrError(filename, ocr.error, ocr.detail) };
  }

  const typedOcr = ensureKind(ocr);

  if (isPlayerStatsResult(typedOcr)) {
    let statsResult;
    try {
      statsResult = await upsertPlayerStatsResult({
        messageId: message.id,
        userId: message.author.id,
        allianceId,
        fileHash,
        filePath,
        messageCreatedAt: message.createdAt,
        ocr: typedOcr,
      });
    } catch (err) {
      logger.error({ messageId: message.id, filename, err: String(err) }, 'Player stats upsert failed');
      return { outcome: 'failed', line: messages.databaseError(filename, String(err)) };
    }

    if (statsResult.status === 'duplicate') {
      return { outcome: 'duplicate', line: `🔁 **${filename}** — capture déjà traitée (doublon).` };
    }
    if (statsResult.status === 'no_members') {
      return {
        outcome: 'failed',
        line: `⚠️ **${filename}** — aucun joueur extrait de la capture stats.`,
      };
    }

    logger.info(
      {
        messageId: message.id,
        filename,
        memberCount: statsResult.memberCount,
        skippedCount: statsResult.skippedCount,
      },
      'Player stats upsert successful',
    );
    return {
      outcome: 'success',
      embed: buildPlayerStatsEmbed(filename, typedOcr, statsResult),
      ...(statsResult.rejectedRawTexts.length > 0 && {
        rejectedRawTexts: statsResult.rejectedRawTexts,
      }),
    };
  }

  if (typedOcr.kind === 'donation') {
    let donationResult;
    try {
      donationResult = await upsertDonationResult({
        messageId: message.id,
        userId: message.author.id,
        allianceId,
        fileHash,
        filePath,
        messageCreatedAt: message.createdAt,
        ocr: typedOcr,
      });
    } catch (err) {
      logger.error({ messageId: message.id, filename, err: String(err) }, 'Donation upsert failed');
      return { outcome: 'failed', line: messages.databaseError(filename, String(err)) };
    }

    if (donationResult.status === 'duplicate') {
      return { outcome: 'duplicate', line: `🔁 **${filename}** — capture déjà traitée (doublon).` };
    }
    if (donationResult.status === 'unsupported_period_type') {
      return {
        outcome: 'failed',
        line: `⚠️ **${filename}** — onglet \`${donationResult.periodType}\` non géré (V1 = Weekly uniquement).`,
      };
    }

    logger.info(
      { messageId: message.id, filename, periodId: donationResult.periodId },
      'Donation upsert successful',
    );
    return { outcome: 'success', embed: buildDonationEmbed(filename, typedOcr, donationResult) };
  }

  // kind === 'event'
  let upsertResult;
  try {
    upsertResult = await upsertEventResult({
      messageId: message.id,
      userId: message.author.id,
      allianceId,
      fileHash,
      filePath,
      ocr: typedOcr,
    });
  } catch (err) {
    logger.error({ messageId: message.id, filename, err: String(err) }, 'Upsert failed');
    return { outcome: 'failed', line: messages.databaseError(filename, String(err)) };
  }

  if (upsertResult.status === 'duplicate') {
    return { outcome: 'duplicate', line: `🔁 **${filename}** — capture déjà traitée (doublon).` };
  }
  if (upsertResult.status === 'unknown_event') {
    return {
      outcome: 'unknown_event',
      line: messages.unknownEventType(filename, upsertResult.eventType),
    };
  }
  if (upsertResult.status === 'missing_datetime') {
    return { outcome: 'failed', line: messages.missingDatetime(filename) };
  }

  logger.info(
    { messageId: message.id, filename, eventId: upsertResult.eventId },
    'Upsert successful',
  );
  return { outcome: 'success', embed: buildEventEmbed(filename, typedOcr, upsertResult) };
}

type JobStartResponse = { job_id: string; status: 'pending' };
type JobStatusResponse =
  | { status: 'pending' }
  | { status: 'done'; result: OcrResult }
  | { status: 'error'; error: string; detail?: string };

async function startOcrJob(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  eventTypeOverride: string | undefined,
  forceLlm: boolean,
): Promise<string> {
  const form = new FormData();
  // Wrap in Uint8Array: Buffer's ArrayBufferLike includes SharedArrayBuffer,
  // which the standard Blob constructor (used after dropping undici types)
  // refuses as a BlobPart.
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  const url = new URL(`${config.ocrServiceUrl}/extract`);
  if (eventTypeOverride) url.searchParams.set('event_type', eventTypeOverride);
  if (forceLlm) url.searchParams.set('force_llm', 'true');

  const res = await fetch(url.toString(), { method: 'POST', body: form });
  if (res.status !== 202) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`OCR /extract returned ${res.status}: ${body}`);
  }
  const data = (await res.json()) as JobStartResponse;
  return data.job_id;
}

async function pollOcrJob(jobId: string): Promise<OcrResponse> {
  const deadline = Date.now() + config.ocrTimeoutMs;
  const url = `${config.ocrServiceUrl}/jobs/${jobId}`;
  let attempt = 0;

  while (Date.now() < deadline) {
    const base = Math.min(config.ocrPollIntervalMs * 2 ** attempt, 30_000);
    const jitter = base * (Math.random() * 0.2 - 0.1);
    const wait = Math.min(Math.round(base + jitter), deadline - Date.now());
    await sleep(wait);

    const res = await fetch(url);
    if (res.status === 404) {
      throw new Error(`OCR job ${jobId} disappeared (service restarted?)`);
    }
    if (!res.ok) {
      throw new Error(`OCR /jobs/${jobId} returned ${res.status}`);
    }
    const body = (await res.json()) as JobStatusResponse;
    if (body.status === 'pending') {
      attempt += 1;
      continue;
    }
    if (body.status === 'done') return body.result;
    const err: OcrError = { error: body.error };
    if (body.detail !== undefined) err.detail = body.detail;
    return err;
  }
  throw new Error(`OCR job ${jobId} timed out after ${config.ocrTimeoutMs}ms`);
}

export async function processImageAttachment(
  messageId: string,
  attachmentUrl: string,
  filename: string,
  eventTypeOverride?: string,
  forceLlm = false,
): Promise<AttachmentResult> {
  const downloadRes = await fetch(attachmentUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!downloadRes.ok) {
    return { ok: false, filename, error: `Download failed: ${downloadRes.statusText}` };
  }

  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  const fileHash = sha256(buffer);

  const messageDir = join(config.dataInboxDir, messageId);
  await mkdir(messageDir, { recursive: true });
  const filePath = join(messageDir, filename);
  await writeFile(filePath, buffer);

  logger.info({ messageId, filename, fileHash, filePath }, 'Attachment stored');

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mimeType =
    ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[ext] ?? 'image/jpeg';

  const jobId = await startOcrJob(buffer, filename, mimeType, eventTypeOverride, forceLlm);
  logger.info({ messageId, filename, jobId }, 'OCR job scheduled');

  const ocr = await pollOcrJob(jobId);

  if ('error' in ocr) {
    logger.warn({ messageId, filename, jobId, ocr }, 'OCR job returned error');
  } else {
    logger.info({ messageId, filename, jobId, ocr }, 'OCR job result received');
  }

  return { ok: true, filename, fileHash, filePath, ocr };
}
