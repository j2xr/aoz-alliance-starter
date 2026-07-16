const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: number = LEVELS[(process.env['LOG_LEVEL'] as Level) ?? 'info'] ?? LEVELS.info;

// Serializes any thrown value into something JSON.stringify can render usefully.
// Supabase PostgrestError is a plain object { message, details, hint, code } — not an Error instance.
export function toLogError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  if (typeof err === 'object' && err !== null) {
    return err;
  }
  return String(err);
}

function log(level: Level, ctx: Record<string, unknown>, msg: string): void {
  if (LEVELS[level] < currentLevel) return;
  const entry = { level, time: new Date().toISOString(), ...ctx, msg };
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log; // eslint-disable-line no-console
  fn(JSON.stringify(entry));
}

const logger = {
  debug: (ctx: Record<string, unknown>, msg: string) => log('debug', ctx, msg),
  info: (ctx: Record<string, unknown>, msg: string) => log('info', ctx, msg),
  warn: (ctx: Record<string, unknown>, msg: string) => log('warn', ctx, msg),
  error: (ctx: Record<string, unknown>, msg: string) => log('error', ctx, msg),
};

export default logger;
