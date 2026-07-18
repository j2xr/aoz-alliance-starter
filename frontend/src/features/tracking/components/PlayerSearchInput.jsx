export function PlayerSearchInput({ value, onChange, placeholder = 'Search by player name…' }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label="Search by player name"
      style={{
        width: '100%',
        maxWidth: '280px',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        color: 'var(--text)',
        padding: '0.5rem 0.75rem',
        fontSize: '0.82rem',
        outline: 'none',
        boxSizing: 'border-box',
        marginBottom: '1rem',
      }}
    />
  );
}
