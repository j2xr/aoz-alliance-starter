import { useNavigate, useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';

const COLS = [
  { key: 'position', label: '#', numeric: true },
  { key: 'player_name', label: 'Player', numeric: false },
  { key: 'player_rank', label: 'Rank', numeric: false },
  { key: 'power', label: 'Power', numeric: true },
  { key: 'points', label: 'Points', numeric: true },
];

export function LeaderboardTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const [sortKey, setSortKey] = useState('position');
  const [sortAsc, setSortAsc] = useState(true);

  // Mémoïsé : chaque re-render (hover compris) re-triait tout le classement.
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = a[sortKey] ?? (sortAsc ? Infinity : -Infinity);
    const bv = b[sortKey] ?? (sortAsc ? Infinity : -Infinity);
    if (typeof av === 'number') return sortAsc ? av - bv : bv - av;
    return sortAsc
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  }), [rows, sortKey, sortAsc]);

  const handleSort = key => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  if (rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: '#4a5568',
        fontSize: '0.8rem', fontFamily: "'Orbitron',sans-serif" }}>
        No ranking data
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
                  fontFamily: "'Orbitron',sans-serif", fontSize: '0.62rem',
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
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right',
                fontFamily: "'Orbitron',sans-serif", fontWeight: '700',
                color: row.position === 1 ? '#ffd700' : row.position === 2 ? '#94a3b8' : row.position === 3 ? '#cd7f32' : '#4a5568' }}>
                {row.position}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', color: '#e2e8f0', fontWeight: '600' }}>
                {row.player_name ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', color: '#94a3b8', fontSize: '0.75rem' }}>
                {row.player_rank ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: '#94a3b8' }}>
                {row.power != null ? row.power.toLocaleString() : '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right',
                fontWeight: '700', color: '#38bdf8' }}>
                {row.points != null ? row.points.toLocaleString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
