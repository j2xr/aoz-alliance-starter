import { useNavigate, useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { onEnterOrSpace } from '@/lib/a11y';
import { useMediaQuery } from '@/lib/useMediaQuery';

const MOBILE_BREAKPOINT = '(max-width: 640px)';

const COLS = [
  { key: 'position', label: '#', numeric: true },
  { key: 'player_name', label: 'Player', numeric: false },
  { key: 'player_rank', label: 'Rank', numeric: false },
  { key: 'power', label: 'Power', numeric: true },
  { key: 'points', label: 'Points', numeric: true },
];
const COL_BY_KEY = Object.fromEntries(COLS.map(c => [c.key, c]));

function positionColor(position) {
  return position === 1 ? 'var(--gold)' : position === 2 ? 'var(--text-muted)'
    : position === 3 ? '#cd7f32' : 'var(--text-faint)';
}

// Shared by the <table> cells and the mobile card rows.
function renderValue(col, row) {
  switch (col.key) {
    case 'position':
      return <span style={{ fontFamily: "'Orbitron',sans-serif", fontWeight: '700', color: positionColor(row.position) }}>{row.position}</span>;
    case 'power':
      return row.power != null ? row.power.toLocaleString() : '—';
    case 'points':
      return <span style={{ fontWeight: '700', color: 'var(--accent)' }}>{row.points != null ? row.points.toLocaleString() : '—'}</span>;
    default:
      return row[col.key] ?? '—';
  }
}

export function LeaderboardTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [sortKey, setSortKey] = useState('position');
  const [sortAsc, setSortAsc] = useState(true);

  // Memoized: every re-render (including hover) used to re-sort the whole leaderboard.
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
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-faint)',
        fontSize: '0.8rem', fontFamily: "'Orbitron',sans-serif" }}>
        No ranking data
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {sorted.map((row, i) => (
          <div key={row.player_id ?? i}
            onClick={() => row.player_id && navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`)}
            role={row.player_id ? 'button' : undefined}
            tabIndex={row.player_id ? 0 : undefined}
            onKeyDown={row.player_id ? onEnterOrSpace(() => navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`)) : undefined}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '10px',
              padding: '0.75rem 0.9rem', cursor: row.player_id ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.45rem' }}>
              <span style={{ fontFamily: "'Orbitron',sans-serif", fontWeight: '700', fontSize: '0.9rem', color: positionColor(row.position) }}>
                #{row.position}
              </span>
              <span style={{ fontWeight: '600', color: 'var(--text)' }}>{row.player_name ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
              {COLS.filter(c => c.key !== 'player_name' && c.key !== 'position').map(col => (
                <div key={col.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text-faint)' }}>{col.label}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{renderValue(col, row)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {COLS.map(col => (
              <th key={col.key}
                onClick={() => handleSort(col.key)}
                tabIndex={0}
                onKeyDown={onEnterOrSpace(() => handleSort(col.key))}
                aria-sort={sortKey === col.key ? (sortAsc ? 'ascending' : 'descending') : 'none'}
                style={{
                  padding: '0.55rem 0.75rem',
                  textAlign: col.numeric ? 'right' : 'left',
                  color: sortKey === col.key ? 'var(--accent)' : 'var(--text-dim)',
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
              tabIndex={row.player_id ? 0 : undefined}
              onKeyDown={row.player_id ? onEnterOrSpace(() => navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`)) : undefined}
              style={{
                borderBottom: '1px solid var(--bg-hover)',
                cursor: row.player_id ? 'pointer' : 'default',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#38bdf808'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right' }}>
                {renderValue(COL_BY_KEY.position, row)}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text)', fontWeight: '600' }}>
                {row.player_name ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                {row.player_rank ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                {row.power != null ? row.power.toLocaleString() : '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right' }}>
                {renderValue(COL_BY_KEY.points, row)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
