const numberFmt = new Intl.NumberFormat('en-US');

const longDateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Paris',
});

const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Paris',
});

export function formatHonor(value) {
  if (value == null) return '—';
  return numberFmt.format(value);
}

export function formatPeriodStart(isoDate) {
  if (!isoDate) return '—';
  // Treat YYYY-MM-DD as a calendar date in Europe/Paris (use noon to dodge DST).
  const d = new Date(`${isoDate}T12:00:00Z`);
  return longDateFmt.format(d);
}

export function formatWeekLabel(isoDate) {
  return `Week of ${formatPeriodStart(isoDate)}`;
}

export function formatUpdatedAt(iso) {
  if (!iso) return '—';
  return dateTimeFmt.format(new Date(iso));
}

/**
 * Monday (ISO week start) in Europe/Paris for the supplied UTC date, as YYYY-MM-DD.
 *
 * IMPORTANT : le bot possède une implémentation jumelle
 * (tracker/apps/discord-bot/src/lib/period.ts, isoWeekStartParis) qui DOIT
 * rester d'accord avec celle-ci — le bot écrit period_start, le frontend
 * dérive la clé de la période courante. Les deux sont testées contre les
 * mêmes vecteurs : shared-test-vectors/paris-iso-week.json.
 */
export function getCurrentParisIsoWeekMondayString(now = new Date()) {
  const parisFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = parisFmt.formatToParts(now);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  const weekday = get('weekday');
  const weekdayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = weekdayMap[weekday] ?? 0;
  // Build a UTC date for the Paris-local Y-M-D, subtract offset days.
  const utcMidnight = new Date(Date.UTC(y, m - 1, d));
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - offset);
  return utcMidnight.toISOString().slice(0, 10);
}
