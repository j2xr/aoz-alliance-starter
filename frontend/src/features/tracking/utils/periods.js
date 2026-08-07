// Period windows for the PlayerDetail participation filter. Pure + UTC-anchored
// so the same input always yields the same boundary regardless of the viewer's
// timezone — mirroring the UTC date handling used elsewhere in the stack
// (e.g. `periodStartLabel` in the Discord bot's embed.ts).

export const PERIOD_OPTIONS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'all', label: 'All time' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

// Inclusive lower bound for a period as an ISO string, or null for 'all' (no
// lower bound — callers skip the period query and fall back to the all-time
// figures). `now` is injectable so tests can pin a fixed instant instead of the
// system clock. '7d'/'30d' are rolling windows ending at `now`; 'ytd' anchors to
// Jan 1 00:00 UTC of the current year.
export function periodStartIso(periodKey, now = new Date()) {
  switch (periodKey) {
    case '7d':
      return new Date(now.getTime() - 7 * DAY_MS).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS).toISOString();
    case 'ytd':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
    case 'all':
    default:
      return null;
  }
}
