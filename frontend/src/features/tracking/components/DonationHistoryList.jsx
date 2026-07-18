import { formatHonor, formatPeriodStart, formatUpdatedAt } from '../utils/donationFormat';

export function DonationHistoryList({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '1.5rem',
        color: 'var(--text-faint)', fontSize: '0.78rem',
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
            borderBottom: '1px solid var(--bg-hover)', gap: '0.75rem' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            Week of {formatPeriodStart(row.period_start)}
          </span>
          <span
            title={row.updated_at ? `Updated on ${formatUpdatedAt(row.updated_at)}` : undefined}
            style={{ color: 'var(--accent)', fontWeight: '700',
              fontFamily: "'Orbitron',sans-serif", fontSize: '0.85rem',
              whiteSpace: 'nowrap' }}>
            {formatHonor(row.alliance_honor)} <span style={{ color: 'var(--text-dim)',
              fontSize: '0.7rem', fontWeight: '400' }}>Honor</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
