import { useState } from "react";
import { normaliseTime, EVENT_TYPES, RECURRENCE_OPTIONS, parseCountdown, input, label } from "./helpers";
import { useToast } from "./components/Toast.jsx";

function AddEventForm({ onSave, onClose, defaultDate, loading, editingEvent }) {
  const toast = useToast();
  const [form, setForm] = useState(editingEvent ? {
    title: editingEvent.title, date: editingEvent.date,
    time: normaliseTime(editingEvent.time), type: editingEvent.type || "event",
    description: editingEvent.description || "", author: editingEvent.author,
    recurrence: editingEvent.recurrence || "none",
    recurrence_end: editingEvent.recurrence_end || "",
  } : {
    title: "", date: defaultDate || new Date().toISOString().split("T")[0],
    time: "00:00", type: "event", description: "", author: "",
    recurrence: "none", recurrence_end: "",
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [countdownMode, setCountdownMode] = useState(false);
  const [countdownInput, setCountdownInput] = useState("");
  const [countdownPreview, setCountdownPreview] = useState(null);
  const handleCountdownChange = (value) => {
    setCountdownInput(value);
    const result = parseCountdown(value);
    setCountdownPreview(result);
    if (result) { set("date", result.date); set("time", result.time); }
  };

  const handleSubmit = () => {
    if (!form.title || !form.date || !form.time || !form.author) {
      toast.error("Please fill in all required fields."); return;
    }
    onSave({ ...form, recurrence_end: form.recurrence_end || null });
  };

  return (
    <div>
      <h2 style={{ color:"#ffd700",fontFamily:"'Orbitron',sans-serif",fontSize:"1rem",
        marginBottom:"1.5rem",letterSpacing:"0.05em" }}>{editingEvent ? "✦ Edit Event" : "✦ New Event"}</h2>
      <div style={{ display:"grid",gap:"1rem" }}>
        <div>
          <label style={label}>Title *</label>
          <input style={input} value={form.title} onChange={e => set("title",e.target.value)} placeholder="Event name" />
        </div>
        {/* Mode toggle */}
        <div style={{ display:"flex",gap:"0.4rem",marginBottom:"0.2rem" }}>
          <button onClick={() => setCountdownMode(false)} style={{
            padding:"0.3rem 0.75rem",borderRadius:"999px",border:"1px solid #2a2d3e",
            background:!countdownMode?"#ffd70022":"transparent",
            color:!countdownMode?"#ffd700":"#94a3b8",
            fontSize:"0.78rem",cursor:"pointer",fontWeight:!countdownMode?"700":"400"
          }}>Date/Time</button>
          <button onClick={() => setCountdownMode(true)} style={{
            padding:"0.3rem 0.75rem",borderRadius:"999px",border:"1px solid #2a2d3e",
            background:countdownMode?"#ffd70022":"transparent",
            color:countdownMode?"#ffd700":"#94a3b8",
            fontSize:"0.78rem",cursor:"pointer",fontWeight:countdownMode?"700":"400"
          }}>Countdown</button>
        </div>

        {countdownMode ? (<>
          <div>
            <label style={label}>Countdown (e.g. 1d:01:51:43 or 01:51:43 or 51:43)</label>
            <input style={input} value={countdownInput}
              onChange={e => handleCountdownChange(e.target.value)}
              placeholder="1d:02:30:00" />
          </div>
          {countdownPreview && (
            <div style={{ background:"#ffd70011",border:"1px solid #ffd70033",borderRadius:"8px",
              padding:"0.6rem 0.8rem",fontSize:"0.78rem",color:"#ffd700",display:"flex",gap:"0.5rem",alignItems:"center" }}>
              🎯 Target: {countdownPreview.date} at {countdownPreview.time} UTC
              <button onClick={() => handleCountdownChange(countdownInput)}
                style={{ marginLeft:"auto",background:"transparent",border:"1px solid #ffd70044",
                  borderRadius:"4px",color:"#ffd700",fontSize:"0.7rem",cursor:"pointer",
                  padding:"0.15rem 0.4rem" }}>↻ Recalculate</button>
            </div>
          )}
          {!countdownPreview && countdownInput && (
            <div style={{ background:"#ff4d4d11",border:"1px solid #ff4d4d33",borderRadius:"8px",
              padding:"0.6rem 0.8rem",fontSize:"0.78rem",color:"#ff4d4d" }}>
              Invalid format. Use 1d:02:30:00 or 02:30:00 or 30:00
            </div>
          )}
        </>) : (<>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.8rem" }}>
            <div>
              <label style={label}>Date * (UTC)</label>
              <input type="date" style={input} value={form.date} onChange={e => set("date",e.target.value)} />
            </div>
            <div>
              <label style={label}>Time * (UTC)</label>
              <input type="time" style={input} value={form.time} onChange={e => set("time",e.target.value)} />
            </div>
          </div>
          <div style={{ background:"#ffd70011",border:"1px solid #ffd70033",borderRadius:"8px",
            padding:"0.6rem 0.8rem",fontSize:"0.78rem",color:"#ffd700",display:"flex",gap:"0.5rem",alignItems:"center" }}>
            🌍 All times are in <strong>UTC</strong>. Members convert to their local timezone.
          </div>
        </>)}

        {/* Type */}
        <div>
          <label style={label}>Type</label>
          <div style={{ display:"flex",gap:"0.4rem",flexWrap:"wrap" }}>
            {EVENT_TYPES.map(t => (
              <button key={t.id} onClick={() => set("type",t.id)} style={{
                padding:"0.3rem 0.75rem",borderRadius:"999px",border:`1px solid ${t.color}`,
                background: form.type===t.id ? t.color+"33":"transparent",
                color:t.color,fontSize:"0.78rem",cursor:"pointer",fontWeight:form.type===t.id?"700":"400"
              }}>{t.label}</button>
            ))}
          </div>
        </div>

        {/* Recurrence */}
        <div>
          <label style={label}>Recurrence</label>
          <div style={{ display:"flex",gap:"0.4rem",flexWrap:"wrap" }}>
            {RECURRENCE_OPTIONS.map(r => (
              <button key={r.id} onClick={() => set("recurrence",r.id)} style={{
                padding:"0.3rem 0.75rem",borderRadius:"999px",border:"1px solid #2a2d3e",
                background: form.recurrence===r.id ? "#ffd70022":"transparent",
                color: form.recurrence===r.id ? "#ffd700":"#94a3b8",
                fontSize:"0.78rem",cursor:"pointer",fontWeight:form.recurrence===r.id?"700":"400"
              }}>{r.label}</button>
            ))}
          </div>
        </div>

        {form.recurrence !== "none" && (
          <div>
            <label style={label}>End date (optional)</label>
            <input type="date" style={input} value={form.recurrence_end}
              onChange={e => set("recurrence_end",e.target.value)}
              min={form.date} placeholder="Leave empty = no end" />
          </div>
        )}

        <div>
          <label style={label}>Description</label>
          <textarea style={{ ...input,resize:"vertical",minHeight:"65px" }}
            value={form.description} onChange={e => set("description",e.target.value)}
            placeholder="Details, rules, requirements..." />
        </div>
        <div>
          <label style={label}>Your nickname *</label>
          <input style={input} value={form.author} onChange={e => set("author",e.target.value)}
            placeholder="e.g. DragonSlayer99" />
        </div>
      </div>
      <div style={{ display:"flex",gap:"0.8rem",marginTop:"1.5rem" }}>
        <button onClick={onClose} style={{ flex:1,padding:"0.7rem",borderRadius:"8px",
          background:"transparent",border:"1px solid #2a2d3e",color:"#94a3b8",cursor:"pointer" }}>
          Cancel
        </button>
        <button onClick={handleSubmit} disabled={loading} style={{ flex:2,padding:"0.7rem",borderRadius:"8px",
          background:"linear-gradient(135deg,#ffd700,#ff9500)",border:"none",color:"#0a0c14",
          fontWeight:"700",cursor:loading?"wait":"pointer",fontFamily:"'Orbitron',sans-serif",
          fontSize:"0.82rem",letterSpacing:"0.05em",opacity:loading?0.7:1 }}>
          {loading ? "SAVING…" : editingEvent ? "SAVE CHANGES" : "ADD EVENT"}
        </button>
      </div>
    </div>
  );
}

export default AddEventForm;
