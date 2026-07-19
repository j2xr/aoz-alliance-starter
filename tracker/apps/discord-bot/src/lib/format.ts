// Shared fr-FR / Europe/Paris event-datetime formatting for Discord embeds
// and autocomplete choices. A module-scope Intl.DateTimeFormat instance
// (same pattern as lib/period.ts's PARIS_DATE_FMT) avoids reconstructing the
// formatter on every call — correct.ts's event_id autocomplete formats up
// to 50 rows per keystroke.
const EVENT_DATETIME_FMT = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Paris',
});

export function formatEventDateTime(iso: string): string {
  return EVENT_DATETIME_FMT.format(new Date(iso));
}
