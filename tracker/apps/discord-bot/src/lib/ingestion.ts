import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { OcrError, OcrResponse, OcrResult } from '@alliance-tracker/shared-types';
import { config } from '../config.js';
import logger from '../logger.js';
import { sha256 } from './hash.js';

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
