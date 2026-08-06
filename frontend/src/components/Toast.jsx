import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const ToastContext = createContext(null);

const DEFAULT_DURATION_MS = 5000;

const TYPE_STYLES = {
  success: { icon: "✓", color: "var(--success)" },
  error: { icon: "✕", color: "var(--danger)" },
  info: { icon: "ℹ", color: "var(--accent)" },
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

  const push = useCallback((message, type = "info", duration = DEFAULT_DURATION_MS, action = null) => {
    const id = ++nextId.current;
    setToasts((prev) => [...prev, { id, message, type, action }]);
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
    success: (message, duration, action) => push(message, "success", duration, action),
    error: (message, duration, action) => push(message, "error", duration, action),
    info: (message, duration, action) => push(message, "info", duration, action),
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
              {t.action && (
                <button
                  type="button"
                  style={styles.action}
                  onClick={() => { t.action.onClick(); dismiss(t.id); }}
                >
                  {t.action.label}
                </button>
              )}
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
    border: "1px solid var(--border-strong)",
    borderLeftWidth: "4px",
    borderRadius: "8px",
    padding: "0.6rem 0.75rem",
    color: "var(--text)",
    fontSize: "0.85rem",
    boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
  },
  message: { flex: 1 },
  action: {
    background: "none",
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    color: "var(--text)",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 700,
    padding: "0.15rem 0.5rem",
    whiteSpace: "nowrap",
  },
  close: {
    background: "none",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    fontSize: "1rem",
    lineHeight: 1,
    padding: 0,
  },
};
