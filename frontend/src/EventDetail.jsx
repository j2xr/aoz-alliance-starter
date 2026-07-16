import { useState } from "react";
import { getTypeColor, EVENT_TYPES, RECURRENCE_OPTIONS, localTime, toGoogleCalLink, downloadICS, input } from "./helpers";
import { useToast } from "./components/Toast.jsx";

function EventDetail({ event, occurrenceDate, onClose, onDelete, deleting, onEdit }) {
  const toast = useToast();
  const [deleteNick, setDeleteNick] = useState(null); // null = hidden, string = asking
  const color = getTypeColor(event.type);
  const typeLabel = EVENT_TYPES.find(t => t.id === event.type)?.label || "Other";
  const d = occurrenceDate || event.date;
  const dateObj = new Date(d + "T" + event.time + ":00Z");
  const formatted = dateObj.toLocaleDateString("en-GB", { weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:"UTC" });
  const recLabel = RECURRENCE_OPTIONS.find(r => r.id === event.recurrence)?.label;
  const localT = localTime(d, event.time);

  const handleDeleteConfirm = () => {
    if (deleteNick.trim().toLowerCase() !== event.author.trim().toLowerCase()) {
      toast.error("Nickname doesn't match. Only the event creator can delete it.");
      return;
    }
    onDelete(event.id);
  };

  return (
    <div>
      <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:"1rem" }}>
        <div style={{ display:"flex",gap:"0.4rem",flexWrap:"wrap" }}>
          <span style={{ background:color+"22",color,border:`1px solid ${color}44`,
            padding:"0.2rem 0.7rem",borderRadius:"999px",fontSize:"0.73rem",fontWeight:"700" }}>{typeLabel}</span>
          {event.recurrence && event.recurrence !== "none" && (
            <span style={{ background:"#ffd70011",color:"#ffd700",border:"1px solid #ffd70033",
              padding:"0.2rem 0.7rem",borderRadius:"999px",fontSize:"0.73rem" }}>🔁 {recLabel}</span>
          )}
        </div>
        <button onClick={onClose} style={{ background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:"1.2rem" }}>✕</button>
      </div>

      <h2 style={{ color:"#e2e8f0",fontFamily:"'Orbitron',sans-serif",fontSize:"1.05rem",marginBottom:"0.5rem" }}>{event.title}</h2>
      <p style={{ color:"#94a3b8",fontSize:"0.85rem",marginBottom:"0.2rem" }}>📅 {formatted}</p>
      <div style={{ display:"flex",alignItems:"baseline",gap:"0.6rem",marginBottom:"0.5rem",flexWrap:"wrap" }}>
        <p style={{ color:"#94a3b8",fontSize:"0.85rem" }}>
          ⏰ {event.time} <span style={{ color:"#ffd700",fontWeight:"700" }}>UTC</span>
        </p>
        <p style={{ color:"#64748b",fontSize:"0.8rem" }}>
          · {localT} <span style={{ color:"#94a3b8" }}>your time</span>
        </p>
      </div>
      {event.recurrence_end && <p style={{ color:"#64748b",fontSize:"0.78rem",marginBottom:"0.3rem" }}>Ends: {event.recurrence_end}</p>}

      {event.description && (
        <p style={{ color:"#cbd5e1",fontSize:"0.88rem",background:"#1a1d2e",
          padding:"0.8rem",borderRadius:"8px",marginBottom:"0.8rem" }}>{event.description}</p>
      )}
      <p style={{ color:"#64748b",fontSize:"0.76rem",marginBottom:"1.2rem" }}>
        Created by <span style={{ color:"#94a3b8" }}>{event.author}</span>
      </p>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.5rem",marginBottom:"0.5rem" }}>
        <a href={toGoogleCalLink(event, d)} target="_blank" rel="noreferrer" style={{
          padding:"0.65rem",borderRadius:"8px",background:"linear-gradient(135deg,#ffd700,#ff9500)",
          color:"#0a0c14",fontWeight:"700",textDecoration:"none",textAlign:"center",
          fontSize:"0.78rem",fontFamily:"'Orbitron',sans-serif",letterSpacing:"0.02em" }}>
          Google Cal
        </a>
        <button onClick={() => downloadICS(event, d)} style={{
          padding:"0.65rem",borderRadius:"8px",background:"transparent",
          border:"1px solid #4dffb844",color:"#4dffb8",cursor:"pointer",fontSize:"0.78rem",
          fontFamily:"'Orbitron',sans-serif" }}>
          .ics / Apple
        </button>
      </div>

      {/* ── Edit button ── */}
      <button onClick={() => onEdit(event)} style={{
        width:"100%",padding:"0.6rem",borderRadius:"8px",background:"transparent",
        border:"1px solid #ffd70044",color:"#ffd700",cursor:"pointer",fontSize:"0.8rem",marginBottom:"0.5rem" }}>
        Edit event
      </button>

      {/* ── Delete with ownership check ── */}
      {deleteNick === null ? (
        <button onClick={() => setDeleteNick("")} style={{
          width:"100%",padding:"0.6rem",borderRadius:"8px",background:"transparent",
          border:"1px solid #ff4d4d33",color:"#ff4d4d66",cursor:"pointer",fontSize:"0.8rem" }}>
          Delete event
        </button>
      ) : (
        <div style={{ border:"1px solid #ff4d4d33",borderRadius:"8px",padding:"0.75rem",background:"#ff4d4d08" }}>
          <p style={{ color:"#94a3b8",fontSize:"0.76rem",marginBottom:"0.5rem" }}>
            Enter your nickname to confirm:
          </p>
          <input style={{ ...input,marginBottom:"0.5rem" }}
            value={deleteNick}
            onChange={e => setDeleteNick(e.target.value)}
            placeholder={event.author}
            autoFocus />
          <div style={{ display:"flex",gap:"0.5rem" }}>
            <button onClick={() => setDeleteNick(null)} style={{
              flex:1,padding:"0.55rem",borderRadius:"7px",background:"transparent",
              border:"1px solid #2a2d3e",color:"#94a3b8",cursor:"pointer",fontSize:"0.78rem" }}>
              Cancel
            </button>
            <button onClick={handleDeleteConfirm} disabled={deleting} style={{
              flex:1,padding:"0.55rem",borderRadius:"7px",background:"transparent",
              border:"1px solid #ff4d4d55",color:"#ff4d4d",cursor:"pointer",fontSize:"0.78rem",
              opacity:deleting?0.5:1 }}>
              {deleting ? "Deleting…" : "Confirm delete"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default EventDetail;
