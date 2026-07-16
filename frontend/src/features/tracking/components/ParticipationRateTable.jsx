import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

const COLS = [
  { key: 'player_name', label: 'Player', numeric: false },
  { key: 'participation_rate_pct', label: 'Rate %', numeric: true },
  { key: 'events_participated', label: 'Participations', numeric: true },
  { key: 'eligible_events', label: 'Eligible', numeric: true },
  { key: 'avg_points', label: 'Avg. pts', numeric: true },
  { key: 'last_participation', label: 'Last part.', numeric: false },
];

function rateColor(pct) {
  if (pct == null) return '#4a5568';
  if (pct >= 80) return '#22c55e';
  if (pct >= 50) return '#ffd700';
  return '#ff4d4d';
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export function ParticipationRateTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const [sortKey, setSortKey] = useState('participation_rate_pct');
  const [sortAsc, setSortAsc] = useState(false);

  // Mémoïsé : chaque re-render (hover compris) re-triait toute l'alliance.
  // Numeric vs. string comparison is driven by COLS.numeric, not value-sniffing
  // (a numeric column with two null rows previously fell through to `Infinity -
  // Infinity` = NaN, which Array.sort does not handle predictably). Nulls
  // always sort last, independent of sort direction.
  const numericSort = COLS.find(c => c.key === sortKey)?.numeric ?? false;
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (numericSort) return sortAsc ? av - bv : bv - av;
    return sortAsc
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  }), [rows, sortKey, sortAsc, numericSort]);

  const handleSort = key => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(key === 'player_name'); }
  };

  if (rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: '#4a5568',
        fontSize: '0.8rem', fontFamily: "'Orbitron',sans-serif" }}>
        No participation data
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #1e2132' }}>
            {COLS.map(col => (
              <th key={col.key}
                onClick={() => handleSort(col.key)}
                style={{
                  padding: '0.55rem 0.75rem',
                  textAlign: col.numeric ? 'right' : 'left',
                  color: sortKey === col.key ? '#38bdf8' : '#64748b',
                  fontFamily: "'Orbitron',sans-serif", fontSize: '0.6rem',
                  letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
                  userSelect: 'none',
                }}>
                {col.label}
                {sortKey === col.key ? (sortAsc ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={row.player_id ?? i}
              onClick={() => row.player_id && navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`)}
              style={{
                borderBottom: '1px solid #1a1d2e',
                cursor: row.player_id ? 'pointer' : 'default',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#38bdf808'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <td style={{ padding: '0.55rem 0.75rem', color: '#e2e8f0', fontWeight: '600' }}>
                {row.player_name ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right' }}>
                <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.85rem',
                  fontWeight: '700', color: rateColor(row.participation_rate_pct) }}>
                  {row.participation_rate_pct != null
                    ? `${Math.round(row.participation_rate_pct)}%`
                    : '—'}
                </span>
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: '#94a3b8' }}>
                {row.events_participated ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: '#64748b' }}>
                {row.eligible_events ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: '#94a3b8' }}>
                {row.avg_points != null ? Math.round(row.avg_points).toLocaleString() : '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', color: '#64748b', fontSize: '0.75rem' }}>
                {formatDate(row.last_participation)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
