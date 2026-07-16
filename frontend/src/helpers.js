// ─── Constants ──────────────────────────────────────────────────────────────
export const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
export const DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

export const EVENT_TYPES = [
  { id: "raid",       label: "KE",       color: "#ff4d4d" },
  { id: "tournament", label: "Alliance", color: "#ffd700" },
  { id: "event",      label: "Event",    color: "#4dffb8" },
  { id: "other",      label: "Other",    color: "#60a5fa" },
];

export const RECURRENCE_OPTIONS = [
  { id: "none",      label: "No recurrence" },
  { id: "daily",     label: "Every day" },
  { id: "weekly",    label: "Every week" },
  { id: "4weekly",   label: "Every 4 weeks" },
  { id: "monthly",   label: "Every month" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
export const getTypeColor = (id) => EVENT_TYPES.find(t => t.id === id)?.color ?? "#60a5fa";

export function daysInMonth(y, m)     { return new Date(y, m + 1, 0).getDate(); }
export function firstDayOfMonth(y, m) { const d = new Date(y, m, 1).getDay(); return d === 0 ? 6 : d - 1; }

/** Return the UTC Monday of the week that contains `date`.
 *
 * Semaine UTC de la grille du calendrier — PAS la clé de période des dons
 * (voir features/tracking/utils/donationFormat.js,
 * getCurrentParisIsoWeekMondayString, calée sur Europe/Paris). */
export function getMonday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

/** Normalise time from Supabase "HH:MM:SS" or "HH:MM" → "HH:MM" */
export function normaliseTime(t) {
  if (!t) return "00:00";
  return t.slice(0, 5);
}

/** Format a UTC event datetime into the viewer's local time string */
export function localTime(dateIso, timeStr) {
  return new Date(dateIso + "T" + timeStr + ":00Z")
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Generate all occurrences of an event that fall within [rangeStart, rangeEnd] (Date objects at midnight UTC) */
export function expandRecurrences(event, rangeStart, rangeEnd) {
  const base    = new Date(event.date + "T00:00:00Z");
  const endDate = event.recurrence_end ? new Date(event.recurrence_end + "T00:00:00Z") : null;
  const occurrences = [];

  if (event.recurrence === "none" || !event.recurrence) {
    if (base >= rangeStart && base <= rangeEnd)
      occurrences.push({ ...event, time: normaliseTime(event.time), _occurrenceDate: event.date });
    return occurrences;
  }

  let current = new Date(base);
  const originalDay = base.getUTCDate();
  let safetyLimit = 0;
  while (current <= rangeEnd && safetyLimit < 500) {
    safetyLimit++;
    if (endDate && current > endDate) break;
    if (current >= rangeStart) {
      const isoDate = current.toISOString().split("T")[0];
      occurrences.push({ ...event, time: normaliseTime(event.time), _occurrenceDate: isoDate });
    }
    if (event.recurrence === "daily")    current.setUTCDate(current.getUTCDate() + 1);
    if (event.recurrence === "weekly")   current.setUTCDate(current.getUTCDate() + 7);
    if (event.recurrence === "4weekly")  current.setUTCDate(current.getUTCDate() + 28);
    if (event.recurrence === "monthly") {
      current.setUTCDate(1); // avoid overflow before changing month
      current.setUTCMonth(current.getUTCMonth() + 1);
      const maxDay = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)).getUTCDate();
      current.setUTCDate(Math.min(originalDay, maxDay));
    }
  }
  return occurrences;
}

const RECURRENCE_FREQ = { daily: "DAILY", weekly: "WEEKLY", "4weekly": "WEEKLY", monthly: "MONTHLY" };

/** Start/end instants of an event as real Date objects (end = start + 1h),
 * so a 23:30 event correctly rolls over into the next UTC day instead of
 * producing an invalid "24:30" hour. Shared by the Google Calendar link and
 * the .ics export. */
function eventUtcRange(dateStr, timeStr) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const start = new Date(Date.UTC(y, m - 1, day, hh, mm));
  const end = new Date(start.getTime() + 3600e3);
  return { start, end };
}

/** Format a Date as a compact UTC iCal/Google timestamp: YYYYMMDDTHHMMSSZ */
function toCompactUTC(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Build an RFC 5545 RRULE value (e.g. "RRULE:FREQ=WEEKLY;UNTIL=20260630T235959Z"),
 * or "" if the event doesn't recur. Shared by the Google Calendar link and .ics export. */
function buildRRule(event) {
  if (!event.recurrence || event.recurrence === "none") return "";
  let rrule = `RRULE:FREQ=${RECURRENCE_FREQ[event.recurrence]}`;
  if (event.recurrence === "4weekly") rrule += ";INTERVAL=4";
  if (event.recurrence_end) rrule += `;UNTIL=${event.recurrence_end.replace(/-/g, "")}T235959Z`;
  return rrule;
}

/** Build Google Calendar URL (UTC times, with optional RRULE) */
export function toGoogleCalLink(event, occurrenceDate) {
  const d = occurrenceDate || event.date;
  const { start, end } = eventUtcRange(d, event.time);

  let url = `https://calendar.google.com/calendar/render?action=TEMPLATE`
    + `&text=${encodeURIComponent(event.title)}`
    + `&dates=${toCompactUTC(start)}/${toCompactUTC(end)}`
    + `&details=${encodeURIComponent(event.description || "")}`;

  const rrule = buildRRule(event);
  if (rrule) url += `&recur=${encodeURIComponent(rrule)}`;
  return url;
}

// ─── iCal (.ics) ─────────────────────────────────────────────────────────────
// Un seul builder VEVENT pour les trois téléchargements (événement seul, mois,
// semaine) : le bloc était copié-collé trois fois et toute évolution du format
// devait être répétée partout.

function icsDtstamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
}

/** Escape a TEXT-valued iCal field per RFC 5545 §3.3.11: backslash first (so
 * it doesn't re-escape the comma/semicolon escapes introduced after it), then
 * semicolon, comma, and newline. */
export function icsEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Build one VEVENT block (lines array). `includeRrule` is only used by the
 * single-event download; month/week exports expand occurrences instead. */
export function buildVEvent(event, occurrenceDate, dtstamp, { includeRrule = false } = {}) {
  const d = occurrenceDate || event.date;
  const { start, end } = eventUtcRange(d, event.time);
  const uid = `${event.id}-${d}@aoz-alliance`;

  const rruleLine = includeRrule ? buildRRule(event) : "";

  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toCompactUTC(start)}`,
    `DTEND:${toCompactUTC(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    event.description ? `DESCRIPTION:${icsEscape(event.description)}` : "",
    `ORGANIZER:CN=${icsEscape(event.author)}`,
    rruleLine,
    "END:VEVENT",
  ].filter(Boolean).join("\r\n");
}

function buildVCalendar(vevents) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AOZ Origins//Alliance Events//EN",
    "CALSCALE:GREGORIAN",
    ...vevents,
    "END:VCALENDAR",
  ].join("\r\n");
}

function downloadICSFile(ics, filename) {
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Download an .ics file for the event (full iCal standard, UTC) */
export function downloadICS(event, occurrenceDate) {
  const vevent = buildVEvent(event, occurrenceDate, icsDtstamp(), { includeRrule: true });
  downloadICSFile(buildVCalendar([vevent]), `${event.title.replace(/\s+/g, "-")}.ics`);
}

/** Download a single .ics file containing all events for a given month */
export function downloadMonthICS(monthEvents, year, month) {
  if (!monthEvents.length) { alert("No events this month."); return; }
  const dtstamp = icsDtstamp();
  const vevents = monthEvents.map(event => buildVEvent(event, event._occurrenceDate, dtstamp));
  downloadICSFile(
    buildVCalendar(vevents),
    `alliance-${MONTHS[month].toLowerCase()}-${year}.ics`,
  );
}

/** Download a single .ics file containing all events for a given week */
export function downloadWeekICS(weekEvents, weekLabel) {
  if (!weekEvents.length) { alert("No events this week."); return; }
  const dtstamp = icsDtstamp();
  const vevents = weekEvents.map(event => buildVEvent(event, event._occurrenceDate, dtstamp));
  downloadICSFile(
    buildVCalendar(vevents),
    `alliance-week-${weekLabel.replace(/[^a-zA-Z0-9]+/g, "-")}.ics`,
  );
}

// ─── Shared styles ───────────────────────────────────────────────────────────
export const input = {
  width: "100%", background: "#1a1d2e", border: "1px solid #2a2d3e",
  borderRadius: "8px", color: "#e2e8f0", padding: "0.6rem 0.8rem",
  fontSize: "0.9rem", outline: "none", boxSizing: "border-box",
};
export const label = { color: "#94a3b8", fontSize: "0.8rem", marginBottom: "0.3rem", display: "block" };

// ─── parseCountdown ───────────────────────────────────────────────────────────
export function parseCountdown(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(":");
  let days = 0, hours = 0, minutes = 0, seconds = 0;
  if (parts.length === 4) {
    days = parseInt(parts[0].replace(/d$/i, ""), 10) || 0;
    hours = parseInt(parts[1], 10) || 0;
    minutes = parseInt(parts[2], 10) || 0;
    seconds = parseInt(parts[3], 10) || 0;
  } else if (parts.length === 3) {
    hours = parseInt(parts[0], 10) || 0;
    minutes = parseInt(parts[1], 10) || 0;
    seconds = parseInt(parts[2], 10) || 0;
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10) || 0;
    seconds = parseInt(parts[1], 10) || 0;
  } else { return null; }
  const totalMs = ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
  if (totalMs <= 0) return null;
  const target = new Date(Date.now() + totalMs);
  return {
    date: target.toISOString().split("T")[0],
    time: target.toISOString().split("T")[1].slice(0, 5),
  };
}
