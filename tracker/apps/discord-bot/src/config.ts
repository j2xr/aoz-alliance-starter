import 'dotenv/config';

function requireEnv(name: string): string {
  const val = process.env[name]?.trim();
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// Strip accidental /rest/v1 suffix: supabase-js appends it internally, so
// SUPABASE_URL must be the bare project URL (https://xxx.supabase.co).
// If the env var already includes /rest/v1 the client builds
// /rest/v1/rest/v1/<table> → PostgREST receives /rest/v1/<table> as the path
// → PGRST125 "Invalid path specified in request URL".
function sanitizeSupabaseUrl(raw: string): string {
  return raw.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
}

export const config = {
  discordToken: requireEnv('DISCORD_BOT_TOKEN'),
  allowedChannelIds: new Set(
    requireEnv('DISCORD_ALLOWED_CHANNEL_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  ocrServiceUrl: process.env['OCR_SERVICE_URL'] ?? 'http://ocr-service:8000',
  ocrTimeoutMs: Number.parseInt(process.env['OCR_TIMEOUT_MS'] ?? '1800000', 10),
  ocrPollIntervalMs: Number.parseInt(process.env['OCR_POLL_INTERVAL_MS'] ?? '5000', 10),
  dataInboxDir: process.env['DATA_INBOX_DIR'] ?? '/data/inbox',
  // Nombre de captures retraitées en parallèle par /reprocess-channel et
  // /reprocess. 3 par défaut : la majeure partie du temps par image est de
  // l'attente (download CDN + polling du job OCR), donc un petit pool
  // pipeline sans saturer le service OCR.
  reprocessConcurrency: Number.parseInt(process.env['REPROCESS_CONCURRENCY'] ?? '3', 10),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  supabaseUrl: sanitizeSupabaseUrl(requireEnv('SUPABASE_URL')),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
} as const;
