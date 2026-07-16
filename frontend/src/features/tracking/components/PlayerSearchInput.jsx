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
        background: '#0f111a',
        border: '1px solid #1e2132',
        borderRadius: '8px',
        color: '#e2e8f0',
        padding: '0.5rem 0.75rem',
        fontSize: '0.82rem',
        outline: 'none',
        boxSizing: 'border-box',
        marginBottom: '1rem',
      }}
    />
  );
}
