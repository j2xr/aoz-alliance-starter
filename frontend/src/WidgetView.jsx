import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { getTypeColor, normaliseTime, expandRecurrences } from "./helpers";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

function todayISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

export default function WidgetView() {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState("loading");

  const fetchEvents = useCallback(async () => {
    const { data, error } = await supabase.from("events").select("*").order("date").order("time");
    if (error) { setStatus("error"); return; }
    setEvents(data || []);
    setStatus("ok");
  }, []);

  useEffect(() => {
    fetchEvents();
    const channel = supabase
      .channel("widget-events")
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, fetchEvents)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchEvents]);

  // Compute displayed events: today's first, then next upcoming if today is empty
  const displayedEvents = (() => {
    if (!events.length) return { kind: "upcoming", items: [] };
    const now = new Date();
    const iso = todayISO();

    // Range: today → 30 days out
    const rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rangeEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 30));

    const expanded = events.flatMap(e => expandRecurrences(e, rangeStart, rangeEnd));
    expanded.sort((a, b) => {
      if (a._occurrenceDate !== b._occurrenceDate) return a._occurrenceDate < b._occurrenceDate ? -1 : 1;
      return (a.time || "00:00") < (b.time || "00:00") ? -1 : 1;
    });

    const todayEvents = expanded.filter(e => e._occurrenceDate === iso);
    if (todayEvents.length > 0) return { kind: "today", items: todayEvents.slice(0, 6), date: iso };
    // No events today → show next 5 upcoming
    const upcoming = expanded.filter(e => e._occurrenceDate > iso).slice(0, 5);
    return { kind: "upcoming", items: upcoming };
  })();

  const styles = {
    root: {
      background: "#070810",
      color: "#e2e8f0",
      fontFamily: "'Rajdhani', 'Segoe UI', sans-serif",
      minHeight: "100vh",
      padding: "12px",
      boxSizing: "border-box",
    },
    header: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: "10px",
      borderBottom: "1px solid #1a1d2e",
      paddingBottom: "8px",
    },
    title: {
      fontFamily: "'Orbitron', monospace",
      fontSize: "0.75rem",
      color: "#ffd700",
      letterSpacing: "0.05em",
      textTransform: "uppercase",
    },
    dot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
    row: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "6px 0",
      borderBottom: "1px solid #0f1120",
    },
    time: { color: "#94a3b8", fontSize: "0.78rem", minWidth: 36, fontVariantNumeric: "tabular-nums" },
    eventTitle: { fontSize: "0.88rem", color: "#e2e8f0", flex: 1, lineHeight: 1.3 },
    date: { fontSize: "0.7rem", color: "#4a5568", marginRight: 4 },
    loading: { color: "#4a5568", fontSize: "0.8rem", textAlign: "center", marginTop: 20 },
    empty: { color: "#4a5568", fontSize: "0.82rem", textAlign: "center", marginTop: 20 },
    sectionLabel: { fontSize: "0.7rem", color: "#4a5568", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" },
    refreshed: { fontSize: "0.65rem", color: "#2d3748" },
  };

  const shortDate = (iso) => {
    const [, m, d] = iso.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${d} ${months[parseInt(m)-1]}`;
  };

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>AOZ ORIGINS</span>
        <span style={styles.refreshed}>{timeStr}</span>
      </div>

      {status === "loading" && <div style={styles.loading}>Loading…</div>}
      {status === "error"   && <div style={styles.loading}>Connection error</div>}

      {status === "ok" && displayedEvents.items?.length === 0 && (
        <div style={styles.empty}>No upcoming events</div>
      )}

      {status === "ok" && displayedEvents.items?.length > 0 && (
        <>
          <div style={styles.sectionLabel}>
            {displayedEvents.kind === "today" ? "Today" : "Upcoming"}
          </div>
          {displayedEvents.items.map((ev, i) => (
            <div key={`${ev.id}-${ev._occurrenceDate}-${i}`} style={styles.row}>
              <div style={{ ...styles.dot, background: getTypeColor(ev.type) }} />
              {displayedEvents.kind === "upcoming" && (
                <span style={styles.date}>{shortDate(ev._occurrenceDate)}</span>
              )}
              <span style={styles.time}>{normaliseTime(ev.time)}</span>
              <span style={styles.eventTitle}>{ev.title}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
