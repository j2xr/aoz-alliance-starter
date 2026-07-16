import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "./lib/supabase";
import { MONTHS, DAYS_SHORT, EVENT_TYPES, getTypeColor, daysInMonth, firstDayOfMonth, getMonday, localTime, expandRecurrences, downloadMonthICS, downloadWeekICS } from "./helpers";
import Modal from "./Modal";
import AddEventForm from "./AddEventForm";
import EventDetail from "./EventDetail";
import WidgetView from "./WidgetView";
import { useToast } from "./components/Toast.jsx";

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // Widget mode: render minimal view when ?widget=true is in the URL
  if (new URLSearchParams(window.location.search).get("widget") === "true") {
    return <WidgetView />;
  }
  const navigate = useNavigate();
  const toast = useToast();
  const today = new Date();
  const todayISO = `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,"0")}-${String(today.getUTCDate()).padStart(2,"0")}`;
  const [year, setYear]   = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());
  const [events, setEvents]           = useState([]);
  const [dbStatus, setDbStatus]       = useState("loading"); // loading | ok | error
  const [showAdd, setShowAdd]         = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [selectedOccDate, setSelectedOccDate] = useState(null);
  const [view, setView]   = useState("week");
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeFilter, setActiveFilter] = useState(null); // null = all, or event type id
  const [editingEvent, setEditingEvent] = useState(null);

  // ── Load events from Supabase ─────────────────────────────────────────────
  const fetchEvents = useCallback(async () => {
    const { data, error } = await supabase.from("events").select("*").order("date").order("time");
    if (error) { setDbStatus("error"); return; }
    setEvents(data || []);
    setDbStatus("ok");
  }, []);

  useEffect(() => {
    fetchEvents();
    const channel = supabase
      .channel('events-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => fetchEvents())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchEvents]);

  // ── Add event ─────────────────────────────────────────────────────────────
  const handleAddEvent = useCallback(async (form) => {
    setSaving(true);
    const { error } = await supabase.from("events").insert([{
      title: form.title, date: form.date, time: form.time,
      type: form.type, description: form.description || null,
      author: form.author, recurrence: form.recurrence || "none",
      recurrence_end: form.recurrence_end || null,
    }]);
    setSaving(false);
    if (error) { toast.error("Error saving event: " + error.message); return; }
    await fetchEvents();
    setShowAdd(false); setSelectedDate(null);
  }, [fetchEvents, toast]);

  // ── Delete event ──────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (id) => {
    setDeleting(true);
    const { error } = await supabase.from("events").delete().eq("id", id);
    setDeleting(false);
    if (error) { toast.error("Error deleting event: " + error.message); return; }
    await fetchEvents();
    setSelectedEvent(null);
  }, [fetchEvents, toast]);

  // ── Edit event ──────────────────────────────────────────────────────────
  const handleEditEvent = useCallback(async (form) => {
    if (!editingEvent) return;
    setSaving(true);
    const { error } = await supabase.from("events").update({
      title: form.title, date: form.date, time: form.time,
      type: form.type, description: form.description || null,
      author: form.author, recurrence: form.recurrence || "none",
      recurrence_end: form.recurrence_end || null,
    }).eq("id", editingEvent.id);
    setSaving(false);
    if (error) { toast.error("Error updating event: " + error.message); return; }
    await fetchEvents();
    setEditingEvent(null);
  }, [editingEvent, fetchEvents, toast]);

  // ── Calendar grid ─────────────────────────────────────────────────────────
  const monthStart = useMemo(() => new Date(Date.UTC(year, month, 1)), [year, month]);
  const monthEnd   = useMemo(() => new Date(Date.UTC(year, month + 1, 0, 23, 59, 59)), [year, month]);

  const expandedThisMonth = useMemo(() =>
    events.flatMap(e => expandRecurrences(e, monthStart, monthEnd)),
    [events, monthStart, monthEnd]
  );

  const eventsOnDay = (day) => {
    const iso = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    return expandedThisMonth
      .filter(e => e._occurrenceDate === iso)
      .filter(e => !activeFilter || e.type === activeFilter);
  };

  const totalDays = daysInMonth(year, month);
  const startDay  = firstDayOfMonth(year, month);
  const cells = [...Array(startDay).fill(null), ...Array.from({length:totalDays},(_,i)=>i+1)];

  const prevMonth = () => month===0 ? (setMonth(11),setYear(y=>y-1)) : setMonth(m=>m-1);
  const nextMonth = () => month===11? (setMonth(0), setYear(y=>y+1)) : setMonth(m=>m+1);

  // ── Week view ─────────────────────────────────────────────────────────────
  const [weekStart, setWeekStart] = useState(() => getMonday(today));

  const weekDays = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().split("T")[0];
    }),
    [weekStart]
  );

  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + 6);
    d.setUTCHours(23, 59, 59, 0);
    return d;
  }, [weekStart]);

  const expandedThisWeek = useMemo(() =>
    events.flatMap(e => expandRecurrences(e, weekStart, weekEnd)),
    [events, weekStart, weekEnd]
  );

  const prevWeek = () => setWeekStart(ws => { const d = new Date(ws); d.setUTCDate(d.getUTCDate() - 7); return d; });
  const nextWeek = () => setWeekStart(ws => { const d = new Date(ws); d.setUTCDate(d.getUTCDate() + 7); return d; });

  const weekLabel = useMemo(() => {
    const s = weekDays[0].split("-").map(Number);
    const e = weekDays[6].split("-").map(Number);
    const sm = MONTHS[s[1]-1].slice(0,3).toUpperCase();
    const em = MONTHS[e[1]-1].slice(0,3).toUpperCase();
    return s[1] === e[1]
      ? `${sm} ${s[2]}–${e[2]}, ${s[0]}`
      : `${sm} ${s[2]} – ${em} ${e[2]}, ${e[0]}`;
  }, [weekDays]);

  const upcomingEvents = useMemo(() => {
    const now           = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const far           = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
    return events
      .flatMap(e => expandRecurrences(e, todayMidnight, far))
      .filter(e => new Date(e._occurrenceDate + "T" + e.time + ":00Z") >= now)
      .sort((a, b) => (a._occurrenceDate + a.time).localeCompare(b._occurrenceDate + b.time))
      .slice(0, 30);
  }, [events]);

  const filteredUpcoming = useMemo(() =>
    activeFilter ? upcomingEvents.filter(e => e.type === activeFilter) : upcomingEvents,
    [upcomingEvents, activeFilter]
  );

  // ── KE countdown ──────────────────────────────────────────────────────────
  const nextKE = useMemo(() =>
    upcomingEvents.find(e => e.type === "raid") ?? null,
    [upcomingEvents]
  );

  const [keCountdown, setKeCountdown] = useState("");
  useEffect(() => {
    if (!nextKE) { setKeCountdown(""); return; }
    const tick = () => {
      const diff = new Date(nextKE._occurrenceDate + "T" + nextKE.time + ":00Z") - new Date();
      if (diff <= 0) { setKeCountdown("NOW"); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setKeCountdown(
        (d > 0 ? d + "d " : "") +
        String(h).padStart(2,"0") + "h " +
        String(m).padStart(2,"0") + "m " +
        String(s).padStart(2,"0") + "s"
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextKE]);

  // ─── Render ───────────────────────────────────────────────────────────────
  const todayDay   = today.getUTCDate();
  const todayMonth = today.getUTCMonth();
  const todayYear  = today.getUTCFullYear();

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;600&display=swap');
        *{margin:0;padding:0;box-sizing:border-box;}
        body{background:#070810;min-height:100vh;}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0f111a}::-webkit-scrollbar-thumb{background:#2a2d3e;border-radius:3px}
        @keyframes glow{0%,100%{text-shadow:0 0 12px #ffd70055}50%{text-shadow:0 0 24px #ffd700aa,0 0 48px #ffd70033}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .day-cell:hover{background:#1a1d2e!important;cursor:pointer}
        .pill:hover{filter:brightness(1.25);cursor:pointer}
        .nav-btn:hover{background:#1a1d2e!important}
        .upcoming-row:hover{background:#14172600!important;border-color:#2a2d3e!important;cursor:pointer}
        .filter-tag:hover{filter:brightness(1.2);cursor:pointer}
        .week-day:hover{background:#1a1d2e!important;cursor:pointer}
      `}</style>

      <div style={{ fontFamily:"'Rajdhani',sans-serif",background:"#070810",minHeight:"100vh",
        color:"#e2e8f0",maxWidth:"920px",margin:"0 auto",padding:"1.5rem 1rem" }}>

        {/* ── Header ── */}
        <div style={{ textAlign:"center",marginBottom:"1.8rem" }}>
          <div style={{ fontSize:"0.68rem",letterSpacing:"0.35em",color:"#ffd700",marginBottom:"0.25rem",textTransform:"uppercase" }}>
            Community Calendar
          </div>
          <h1 style={{ fontFamily:"'Orbitron',sans-serif",fontSize:"clamp(1.5rem,5vw,2.3rem)",
            fontWeight:"900",background:"linear-gradient(135deg,#ffd700 0%,#ff9500 50%,#ffd700 100%)",
            WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
            animation:"glow 3s ease-in-out infinite",letterSpacing:"0.08em" }}>
            AOZ ORIGINS EVENTS
          </h1>
          <div style={{ display:"flex",justifyContent:"center",alignItems:"center",gap:"0.5rem",marginTop:"0.5rem" }}>
            <div style={{ width:"40px",height:"1px",background:"linear-gradient(90deg,transparent,#ffd700)" }} />
            <span style={{ fontSize:"0.65rem",color:"#ffd700",letterSpacing:"0.2em",opacity:0.7 }}>ALL TIMES UTC</span>
            <div style={{ width:"40px",height:"1px",background:"linear-gradient(90deg,#ffd700,transparent)" }} />
          </div>
          {dbStatus==="error" && (
            <div style={{ marginTop:"0.5rem",background:"#ff4d4d18",border:"1px solid #ff4d4d44",
              borderRadius:"8px",padding:"0.5rem 1rem",fontSize:"0.8rem",color:"#ff4d4d" }}>
              ⚠ Database connection error — check your Supabase config in .env
            </div>
          )}
        </div>

        {/* ── KE Countdown banner ── */}
        {nextKE && (
          <div style={{ background:"#ff4d4d0d",border:"1px solid #ff4d4d44",borderRadius:"10px",
            padding:"0.7rem 1rem",marginBottom:"1rem",display:"flex",alignItems:"center",
            justifyContent:"space-between",flexWrap:"wrap",gap:"0.5rem" }}>
            <div style={{ display:"flex",alignItems:"center",gap:"0.5rem" }}>
              <span style={{ background:"#ff4d4d22",color:"#ff4d4d",border:"1px solid #ff4d4d44",
                borderRadius:"999px",padding:"0.15rem 0.6rem",fontSize:"0.68rem",fontWeight:"700",
                fontFamily:"'Orbitron',sans-serif",letterSpacing:"0.05em" }}>⚔ KE</span>
              <span style={{ color:"#e2e8f0",fontSize:"0.88rem",fontWeight:"600" }}>{nextKE.title}</span>
            </div>
            <div style={{ fontFamily:"'Orbitron',sans-serif",fontSize:"0.82rem",fontWeight:"700",
              color: "#ff4d4d",letterSpacing:"0.04em",
              textShadow:"0 0 12px #ff4d4d55" }}>
              {keCountdown === "NOW" ? "🔴 HAPPENING NOW" : keCountdown}
            </div>
          </div>
        )}

        {/* ── Tabs ── */}
        <div style={{ display:"flex",gap:"0.4rem",marginBottom:"1rem",background:"#0f111a",
          padding:"0.3rem",borderRadius:"10px",border:"1px solid #1a1d2e" }}>
          {[["calendar","📅 Month"],["week","📆 Week"],["list","📋 Upcoming"]].map(([v,l]) => (
            <button key={v} onClick={() => setView(v)} style={{ flex:1,padding:"0.5rem",
              borderRadius:"7px",border:"none",cursor:"pointer",
              background: view===v?"linear-gradient(135deg,#ffd700,#ff9500)":"transparent",
              color: view===v?"#0a0c14":"#94a3b8",fontFamily:"'Orbitron',sans-serif",
              fontSize:"0.7rem",fontWeight:"700",letterSpacing:"0.05em" }}>{l}</button>
          ))}
          <button onClick={() => navigate("/tracking")} style={{ flex:1,padding:"0.5rem",
            borderRadius:"7px",border:"none",cursor:"pointer",background:"transparent",
            color:"#38bdf8",fontFamily:"'Orbitron',sans-serif",
            fontSize:"0.7rem",fontWeight:"700",letterSpacing:"0.05em" }}>📊 Track</button>
        </div>

        {/* ── Add button ── */}
        <button onClick={() => { setSelectedDate(null); setShowAdd(true); }}
          style={{ width:"100%",padding:"0.85rem",
            background:"linear-gradient(135deg,#ffd700 0%,#ff9500 100%)",
            border:"none",borderRadius:"10px",color:"#0a0c14",
            fontFamily:"'Orbitron',sans-serif",fontSize:"0.78rem",fontWeight:"700",
            letterSpacing:"0.1em",cursor:"pointer",marginBottom:"0.75rem",
            boxShadow:"0 4px 24px rgba(255,215,0,0.18)" }}>
          ✦ ADD AN EVENT
        </button>

        {/* ── Filter / Stats bar ── */}
        {events.length > 0 && (
          <div style={{ display:"flex",gap:"0.4rem",marginBottom:"0.75rem",justifyContent:"center",flexWrap:"wrap",alignItems:"center" }}>
            {EVENT_TYPES.map(t => {
              const count = events.filter(e => e.type===t.id).length;
              if (!count) return null;
              const isActive = activeFilter === t.id;
              return (
                <span key={t.id} className="filter-tag"
                  onClick={() => setActiveFilter(isActive ? null : t.id)}
                  title={isActive ? "Clear filter" : `Show only ${t.label}`}
                  style={{
                    background: isActive ? t.color+"33" : t.color+"12",
                    color: t.color,
                    border: `1px solid ${isActive ? t.color+"88" : t.color+"2a"}`,
                    borderRadius:"999px",
                    padding:"0.18rem 0.65rem",
                    fontSize:"0.68rem",
                    fontWeight: isActive ? "700" : "400",
                    transition:"all 0.15s",
                  }}>
                  {isActive ? "✕ " : ""}{t.label}: {count}
                </span>
              );
            })}
            {activeFilter ? (
              <span onClick={() => setActiveFilter(null)} className="filter-tag"
                style={{ color:"#94a3b8",fontSize:"0.68rem",cursor:"pointer" }}>
                show all
              </span>
            ) : (
              <span style={{ color:"#4a5568",fontSize:"0.68rem" }}>
                {events.length} event{events.length!==1?"s":""} total
              </span>
            )}
          </div>
        )}

        {dbStatus==="loading" ? (
          <div style={{ textAlign:"center",color:"#4a5568",padding:"3rem",
            fontFamily:"'Orbitron',sans-serif",fontSize:"0.8rem",letterSpacing:"0.1em" }}>
            LOADING…
          </div>
        ) : view==="calendar" ? (
          /* ── Calendar view ── */
          <div style={{ background:"#0f111a",border:"1px solid #1e2132",borderRadius:"14px",overflow:"hidden",
            animation:"fadeUp 0.25s ease" }}>
            {/* Month nav */}
            <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"1rem 1.2rem",borderBottom:"1px solid #1e2132" }}>
              <button onClick={prevMonth} className="nav-btn" style={{ background:"transparent",
                border:"1px solid #2a2d3e",borderRadius:"7px",color:"#94a3b8",
                width:"32px",height:"32px",cursor:"pointer",fontSize:"1rem" }}>‹</button>
              <span style={{ fontFamily:"'Orbitron',sans-serif",fontSize:"0.88rem",
                color:"#e2e8f0",letterSpacing:"0.08em" }}>
                {MONTHS[month].toUpperCase()} {year}
              </span>
              <div style={{ display:"flex",gap:"0.4rem",alignItems:"center" }}>
                <button onClick={nextMonth} className="nav-btn" style={{ background:"transparent",
                  border:"1px solid #2a2d3e",borderRadius:"7px",color:"#94a3b8",
                  width:"32px",height:"32px",cursor:"pointer",fontSize:"1rem" }}>›</button>
                <button onClick={() => downloadMonthICS(expandedThisMonth, year, month)}
                  title={`Download all events for ${MONTHS[month]} ${year}`}
                  className="nav-btn" style={{ background:"transparent",
                  border:"1px solid #2a2d3e",borderRadius:"7px",color:"#94a3b8",
                  width:"32px",height:"32px",cursor:"pointer",fontSize:"0.85rem" }}>⬇</button>
              </div>
            </div>
            {/* Day headers */}
            <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",borderBottom:"1px solid #1e2132" }}>
              {DAYS_SHORT.map(d => (
                <div key={d} style={{ textAlign:"center",padding:"0.55rem 0.2rem",fontSize:"0.68rem",
                  color:"#4a5568",fontFamily:"'Orbitron',sans-serif",letterSpacing:"0.04em" }}>{d}</div>
              ))}
            </div>
            {/* Day cells */}
            <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)" }}>
              {cells.map((day, i) => {
                const isToday = day && day===todayDay && month===todayMonth && year===todayYear;
                const dayEvs = day ? eventsOnDay(day) : [];
                return (
                  <div key={i} className={day?"day-cell":""} style={{
                    minHeight:"78px",padding:"0.35rem",
                    borderRight:(i+1)%7!==0?"1px solid #1a1d2e":"none",
                    borderBottom:i<cells.length-7?"1px solid #1a1d2e":"none",
                    background:isToday?"#181b2a":"transparent",transition:"background 0.15s"
                  }} onClick={() => { if(day){ setSelectedDate(`${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`); setShowAdd(true); } }}>
                    {day && <>
                      <div style={{ fontSize:"0.75rem",fontWeight:isToday?"700":"400",textAlign:"right",marginBottom:"0.2rem",
                        color:isToday?"#ffd700":"#64748b",fontFamily:isToday?"'Orbitron',sans-serif":"inherit" }}>{day}</div>
                      {dayEvs.slice(0,3).map((e,idx) => (
                        <div key={idx} className="pill"
                          onClick={ev => { ev.stopPropagation(); setSelectedEvent(e); setSelectedOccDate(e._occurrenceDate); setShowAdd(false); }}
                          style={{ background:getTypeColor(e.type)+"1e",borderLeft:`2px solid ${getTypeColor(e.type)}`,
                            borderRadius:"3px",padding:"0.12rem 0.28rem",fontSize:"0.64rem",color:getTypeColor(e.type),
                            marginBottom:"2px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",
                            display:"flex",gap:"3px",alignItems:"center" }}>
                          {e.recurrence && e.recurrence!=="none" && <span style={{ opacity:0.7,fontSize:"0.58rem" }}>🔁</span>}
                          {e.time} {e.title}
                        </div>
                      ))}
                      {dayEvs.length>3 && <div style={{ fontSize:"0.6rem",color:"#4a5568" }}>+{dayEvs.length-3} more</div>}
                    </>}
                  </div>
                );
              })}
            </div>
          </div>
        ) : view==="week" ? (
          /* ── Week view ── */
          <div style={{ background:"#0f111a",border:"1px solid #1e2132",borderRadius:"14px",overflow:"hidden",
            animation:"fadeUp 0.25s ease" }}>
            {/* Week nav */}
            <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"1rem 1.2rem",borderBottom:"1px solid #1e2132" }}>
              <button onClick={prevWeek} className="nav-btn" style={{ background:"transparent",
                border:"1px solid #2a2d3e",borderRadius:"7px",color:"#94a3b8",
                width:"32px",height:"32px",cursor:"pointer",fontSize:"1rem" }}>‹</button>
              <span style={{ fontFamily:"'Orbitron',sans-serif",fontSize:"0.82rem",
                color:"#e2e8f0",letterSpacing:"0.06em" }}>{weekLabel}</span>
              <div style={{ display:"flex",gap:"0.4rem",alignItems:"center" }}>
                <button onClick={nextWeek} className="nav-btn" style={{ background:"transparent",
                  border:"1px solid #2a2d3e",borderRadius:"7px",color:"#94a3b8",
                  width:"32px",height:"32px",cursor:"pointer",fontSize:"1rem" }}>›</button>
                <button onClick={() => downloadWeekICS(expandedThisWeek, weekLabel)}
                  title={`Download all events for the week of ${weekLabel}`}
                  className="nav-btn" style={{ background:"transparent",
                  border:"1px solid #2a2d3e",borderRadius:"7px",color:"#94a3b8",
                  width:"32px",height:"32px",cursor:"pointer",fontSize:"0.85rem" }}>⬇</button>
              </div>
            </div>
            {/* 7-column grid — scrolls horizontally on mobile */}
            <div style={{ overflowX:"auto" }}>
              <div style={{ display:"grid",gridTemplateColumns:"repeat(7,minmax(110px,1fr))",minWidth:"560px" }}>
                {weekDays.map((isoDate, i) => {
                  const isToday = isoDate === todayISO;
                  const dayEvs = expandedThisWeek
                    .filter(e => e._occurrenceDate === isoDate)
                    .filter(e => !activeFilter || e.type === activeFilter)
                    .sort((a,b) => a.time.localeCompare(b.time));
                  const dayNum = parseInt(isoDate.split("-")[2]);
                  const dayMon = parseInt(isoDate.split("-")[1]) - 1;
                  return (
                    <div key={isoDate} style={{
                      borderRight: i < 6 ? "1px solid #1e2132" : "none",
                      minHeight:"200px",
                    }}>
                      {/* Day header */}
                      <div onClick={() => { setSelectedDate(isoDate); setShowAdd(true); }}
                        className="week-day"
                        style={{ padding:"0.55rem 0.3rem",textAlign:"center",
                          borderBottom:"1px solid #1e2132",cursor:"pointer",
                          background: isToday ? "#181b2a" : "transparent" }}>
                        <div style={{ fontSize:"0.6rem",color:"#4a5568",
                          fontFamily:"'Orbitron',sans-serif",letterSpacing:"0.04em" }}>{DAYS_SHORT[i]}</div>
                        <div style={{ fontFamily:"'Orbitron',sans-serif",fontSize:"1.1rem",fontWeight:"700",
                          color: isToday ? "#ffd700" : "#e2e8f0",lineHeight:1.1 }}>{dayNum}</div>
                        <div style={{ fontSize:"0.58rem",color:"#4a5568" }}>
                          {MONTHS[dayMon].slice(0,3).toUpperCase()}
                        </div>
                      </div>
                      {/* Events — all shown, no limit */}
                      <div style={{ padding:"0.3rem" }}>
                        {dayEvs.length === 0 && (
                          <div style={{ fontSize:"0.58rem",color:"#2a2d3e",textAlign:"center",marginTop:"0.5rem" }}>—</div>
                        )}
                        {dayEvs.map((e, idx) => {
                          const color = getTypeColor(e.type);
                          return (
                            <div key={idx} className="pill"
                              onClick={ev => { ev.stopPropagation(); setSelectedEvent(e); setSelectedOccDate(e._occurrenceDate); }}
                              style={{ background:color+"1e",borderLeft:`2px solid ${color}`,borderRadius:"4px",
                                padding:"0.22rem 0.35rem",marginBottom:"3px",cursor:"pointer" }}>
                              <div style={{ fontSize:"0.58rem",color,opacity:0.9,fontFamily:"'Orbitron',sans-serif" }}>
                                {e.recurrence && e.recurrence!=="none" && "🔁 "}{e.time}
                              </div>
                              <div style={{ fontSize:"0.7rem",color:"#e2e8f0",overflow:"hidden",
                                textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{e.title}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          /* ── Upcoming list ── */
          <div style={{ display:"grid",gap:"0.6rem",animation:"fadeUp 0.25s ease" }}>
            {filteredUpcoming.length===0 ? (
              <div style={{ textAlign:"center",color:"#4a5568",padding:"3rem",background:"#0f111a",
                borderRadius:"12px",border:"1px solid #1a1d2e" }}>
                <div style={{ fontSize:"2rem",marginBottom:"0.5rem" }}>📭</div>
                <div style={{ fontFamily:"'Orbitron',sans-serif",fontSize:"0.78rem" }}>No upcoming events</div>
              </div>
            ) : filteredUpcoming.map((e, idx) => {
              const color = getTypeColor(e.type);
              const typeLabel = EVENT_TYPES.find(t=>t.id===e.type)?.label||"Other";
              const d = new Date(e._occurrenceDate + "T" + e.time + ":00Z");
              const localT = localTime(e._occurrenceDate, e.time);
              return (
                <div key={`${e.id}-${idx}`} className="upcoming-row"
                  onClick={() => { setSelectedEvent(e); setSelectedOccDate(e._occurrenceDate); }}
                  style={{ background:"#0f111a",border:"1px solid #1e2132",borderLeft:`3px solid ${color}`,
                    borderRadius:"10px",padding:"0.85rem 1rem",
                    display:"flex",alignItems:"center",gap:"1rem",transition:"border-color 0.15s" }}>
                  <div style={{ textAlign:"center",minWidth:"46px" }}>
                    <div style={{ fontFamily:"'Orbitron',sans-serif",fontSize:"1.25rem",fontWeight:"900",color,lineHeight:1 }}>
                      {String(d.getUTCDate()).padStart(2,"0")}
                    </div>
                    <div style={{ fontSize:"0.65rem",color:"#64748b" }}>{MONTHS[d.getUTCMonth()].slice(0,3).toUpperCase()}</div>
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontWeight:"600",fontSize:"0.92rem",color:"#e2e8f0",marginBottom:"0.15rem",
                      display:"flex",alignItems:"center",gap:"0.4rem" }}>
                      {e.recurrence && e.recurrence!=="none" && <span style={{ fontSize:"0.72rem",opacity:0.6 }}>🔁</span>}
                      {e.title}
                    </div>
                    <div style={{ fontSize:"0.75rem",color:"#64748b" }}>
                      ⏰ {e.time} <span style={{ color:"#ffd700",fontWeight:"700",fontSize:"0.68rem" }}>UTC</span>
                      <span style={{ color:"#4a5568" }}> · {localT} your time</span>
                      <span> · {typeLabel} · by {e.author}</span>
                    </div>
                  </div>
                  <div style={{ color:"#2a2d3e" }}>›</div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ textAlign:"center",marginTop:"1.5rem",fontSize:"0.6rem",
          color:"#1e2132",letterSpacing:"0.12em" }}>
          AOZ ORIGINS · EVENTS CALENDAR · ALL TIMES IN UTC
        </div>
      </div>

      {/* ── Modals ── */}
      {showAdd && (
        <Modal onClose={() => { setShowAdd(false); setSelectedDate(null); }}>
          <AddEventForm defaultDate={selectedDate} onSave={handleAddEvent}
            onClose={() => { setShowAdd(false); setSelectedDate(null); }} loading={saving} />
        </Modal>
      )}
      {selectedEvent && !showAdd && (
        <Modal onClose={() => { setSelectedEvent(null); setSelectedOccDate(null); }}>
          <EventDetail event={selectedEvent} occurrenceDate={selectedOccDate}
            onClose={() => { setSelectedEvent(null); setSelectedOccDate(null); }}
            onDelete={handleDelete} deleting={deleting}
            onEdit={(evt) => { setEditingEvent(evt); setSelectedEvent(null); setSelectedOccDate(null); }} />
        </Modal>
      )}
      {editingEvent && (
        <Modal onClose={() => setEditingEvent(null)}>
          <AddEventForm editingEvent={editingEvent} onSave={handleEditEvent}
            onClose={() => setEditingEvent(null)} loading={saving} />
        </Modal>
      )}
    </>
  );
}
