import { formatHonor, formatPeriodStart, formatUpdatedAt } from '../utils/donationFormat';

export function DonationHistoryList({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '1.5rem',
        color: '#4a5568', fontSize: '0.78rem',
        fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em' }}>
        No donations recorded
      </div>
    );
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map(row => (
        <li key={row.id}
          style={{ display: 'flex', alignItems: 'baseline',
            justifyContent: 'space-between', padding: '0.5rem 0.25rem',
            borderBottom: '1px solid #1a1d2e', gap: '0.75rem' }}>
          <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
            Week of {formatPeriodStart(row.period_start)}
          </span>
          <span
            title={row.updated_at ? `Updated on ${formatUpdatedAt(row.updated_at)}` : undefined}
            style={{ color: '#38bdf8', fontWeight: '700',
              fontFamily: "'Orbitron',sans-serif", fontSize: '0.85rem',
              whiteSpace: 'nowrap' }}>
            {formatHonor(row.alliance_honor)} <span style={{ color: '#64748b',
              fontSize: '0.7rem', fontWeight: '400' }}>Honor</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
