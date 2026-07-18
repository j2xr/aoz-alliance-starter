// Fires `handler` on Enter/Space, matching native <button>/<a> activation
// keys, for elements that need a click handler but aren't natively focusable
// (e.g. <tr>, <th>, <div>).
export function onEnterOrSpace(handler) {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler(e);
    }
  };
}
