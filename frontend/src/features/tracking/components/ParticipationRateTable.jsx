import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { onEnterOrSpace } from '@/lib/a11y';
import { useMediaQuery } from '@/lib/useMediaQuery';

const MOBILE_BREAKPOINT = '(max-width: 640px)';

const COLS = [
  { key: 'player_name', label: 'Player', numeric: false },
  { key: 'participation_rate_pct', label: 'Rate %', numeric: true },
  { key: 'events_participated', label: 'Participations', numeric: true },
  { key: 'eligible_events', label: 'Eligible', numeric: true },
  { key: 'avg_points', label: 'Avg. pts', numeric: true },
  { key: 'last_participation', label: 'Last part.', numeric: false },
];
const COL_BY_KEY = Object.fromEntries(COLS.map(c => [c.key, c]));

function rateColor(pct) {
  if (pct == null) return 'var(--text-faint)';
  if (pct >= 80) return 'var(--success)';
  if (pct >= 50) return 'var(--gold)';
  return 'var(--danger)';
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

// Shared by the <table> cells and the mobile card rows, so formatting
// (colors, rounding, dates) is defined once instead of duplicated per layout.
function renderValue(col, row) {
  switch (col.key) {
    case 'participation_rate_pct':
      return (
        <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.85rem',
          fontWeight: '700', color: rateColor(row.participation_rate_pct) }}>
          {row.participation_rate_pct != null ? `${Math.round(row.participation_rate_pct)}%` : '—'}
        </span>
      );
    case 'avg_points':
      return row.avg_points != null ? Math.round(row.avg_points).toLocaleString() : '—';
    case 'last_participation':
      return formatDate(row.last_participation);
    default:
      return row[col.key] ?? '—';
  }
}

export function ParticipationRateTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [sortKey, setSortKey] = useState('participation_rate_pct');
  const [sortAsc, setSortAsc] = useState(false);

  // Memoized: every re-render (including hover) used to re-sort the whole alliance.
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
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-faint)',
        fontSize: '0.8rem', fontFamily: "'Orbitron',sans-serif" }}>
        No participation data
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
            <div style={{ fontWeight: '600', color: 'var(--text)', marginBottom: '0.45rem' }}>
              {row.player_name ?? '—'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
              {COLS.filter(c => c.key !== 'player_name').map(col => (
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
              <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text)', fontWeight: '600' }}>
                {row.player_name ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right' }}>
                {renderValue(COL_BY_KEY.participation_rate_pct, row)}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                {row.events_participated ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: 'var(--text-dim)' }}>
                {row.eligible_events ?? '—'}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                {renderValue(COL_BY_KEY.avg_points, row)}
              </td>
              <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                {formatDate(row.last_participation)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
