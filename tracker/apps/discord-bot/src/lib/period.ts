// Helpers de calcul de période pour les dons d'alliance.
// La période hebdomadaire est calée sur le lundi ISO de la semaine, calculé
// dans le fuseau Europe/Paris (langue de jeu et fuseau de référence du projet).

const PARIS_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Returns the ISO-week-start date (Monday) in Europe/Paris for the given
 * instant, formatted as `YYYY-MM-DD`.
 *
 * Example: Thursday 2026-04-30 18:00 Europe/Paris → "2026-04-27".
 *
 * IMPORTANT : le frontend possède une implémentation jumelle
 * (frontend/src/features/tracking/utils/donationFormat.js,
 * getCurrentParisIsoWeekMondayString) qui DOIT rester d'accord avec
 * celle-ci — le bot écrit period_start, le frontend dérive la clé de la
 * période courante. Les deux sont testées contre les mêmes vecteurs :
 * shared-test-vectors/paris-iso-week.json.
 */
export function isoWeekStartParis(date: Date): string {
  const parts = PARIS_DATE_FMT.formatToParts(date);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);

  // Reconstruct the local Paris date as a UTC instant just for date arithmetic.
  // getUTCDay returns 0 (Sunday) … 6 (Saturday). ISO week starts on Monday,
  // so we subtract ((dow + 6) % 7) days to land on the previous Monday.
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dow = utc.getUTCDay();
  const offset = (dow + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - offset);

  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
}
