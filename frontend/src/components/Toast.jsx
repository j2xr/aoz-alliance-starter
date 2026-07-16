import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const ToastContext = createContext(null);

const DEFAULT_DURATION_MS = 5000;

const TYPE_STYLES = {
  success: { icon: "✓", color: "#22c55e" },
  error: { icon: "✕", color: "#ff4d4d" },
  info: { icon: "ℹ", color: "#38bdf8" },
};

// Module-level escape hatch so non-component code (helpers.js) can push a
// toast without needing the useToast hook, which only works inside React
// components. Set by the mounted ToastProvider; a no-op before that.
let externalPush = null;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message, type = "info", duration = DEFAULT_DURATION_MS) => {
    const id = ++nextId.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);

  useEffect(() => {
    externalPush = push;
    return () => { externalPush = null; };
  }, [push]);

  const api = useRef({
    success: (message, duration) => push(message, "success", duration),
    error: (message, duration) => push(message, "error", duration),
    info: (message, duration) => push(message, "info", duration),
  }).current;

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div style={styles.container}>
        {toasts.map((t) => {
          const typeStyle = TYPE_STYLES[t.type] ?? TYPE_STYLES.info;
          return (
            <div key={t.id} role="status" style={{ ...styles.toast, borderLeftColor: typeStyle.color }}>
              <span style={{ color: typeStyle.color, fontWeight: 700 }}>{typeStyle.icon}</span>
              <span style={styles.message}>{t.message}</span>
              <button
                type="button"
                aria-label="Dismiss"
                style={styles.close}
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Use inside a React component: const toast = useToast(); toast.error("..."). */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

/** Use outside React components (e.g. plain helper modules). Silently no-ops
 * if no ToastProvider is mounted yet. */
export function showToast(message, type = "info", duration = DEFAULT_DURATION_MS) {
  externalPush?.(message, type, duration);
}

const styles = {
  container: {
    position: "fixed",
    bottom: "1rem",
    right: "1rem",
    zIndex: 9999,
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    maxWidth: "360px",
  },
  toast: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    background: "#12131c",
    border: "1px solid #2a2d3e",
    borderLeftWidth: "4px",
    borderRadius: "8px",
    padding: "0.6rem 0.75rem",
    color: "#e2e8f0",
    fontSize: "0.85rem",
    boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
  },
  message: { flex: 1 },
  close: {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "1rem",
    lineHeight: 1,
    padding: 0,
  },
};
