import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { onEnterOrSpace } from '@/lib/a11y';
import { useMediaQuery } from '@/lib/useMediaQuery';

const MOBILE_BREAKPOINT = '(max-width: 640px)';

function fmtPct(v) {
  if (v == null) return '—';
  return `${Number(v).toFixed(1)}%`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

const TH_STYLE = (align = 'left') => ({
  padding: '0.7rem 1rem',
  textAlign: align,
  fontSize: '0.68rem',
  fontFamily: "'Orbitron',sans-serif",
  color: 'var(--text-faint)',
  letterSpacing: '0.06em',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
});

const COLS = [
  { key: 'player_name', label: 'PLAYER', align: 'left', numeric: false },
  { key: 'last_rank', label: 'RANK', align: 'center', numeric: false },
  { key: 'attack_pct', label: 'ATK %', align: 'right', numeric: true },
  { key: 'hp_pct', label: 'HP %', align: 'right', numeric: true },
  { key: 'defense_pct', label: 'DEF %', align: 'right', numeric: true },
  { key: 'recorded_date', label: 'DATE', align: 'right', numeric: false },
];
const COL_BY_KEY = Object.fromEntries(COLS.map(c => [c.key, c]));

const PCT_COLOR = { attack_pct: 'var(--accent)', hp_pct: 'var(--success)', defense_pct: '#fb923c' };

// Shared by the <table> cells and the mobile card rows.
function renderValue(col, row) {
  switch (col.key) {
    case 'last_rank':
      return <span style={{ color: 'var(--gold)', fontFamily: "'Orbitron',sans-serif" }}>{row.last_rank ?? '—'}</span>;
    case 'attack_pct': case 'hp_pct': case 'defense_pct':
      return <span style={{ color: PCT_COLOR[col.key], fontFamily: "'Orbitron',sans-serif", fontWeight: '700' }}>{fmtPct(row[col.key])}</span>;
    case 'recorded_date':
      return fmtDate(row.recorded_date);
    default:
      return row[col.key] ?? '—';
  }
}

export function PlayerStatsTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [sortKey, setSortKey] = useState('attack_pct');
  const [sortAsc, setSortAsc] = useState(false);

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

  if (!rows.length) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-faint)',
        fontSize: '0.78rem', fontFamily: "'Orbitron',sans-serif" }}>
        No data
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {sorted.map((row, i) => (
          <div key={row.player_id}
            onClick={() => navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`)}
            role="button" tabIndex={0}
            onKeyDown={onEnterOrSpace(() => navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`))}
            style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '10px',
              padding: '0.75rem 0.9rem', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginBottom: '0.45rem' }}>
              <span style={{ color: 'var(--text-faint)', fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem' }}>#{i + 1}</span>
              <span style={{ fontWeight: '600', color: 'var(--text)', fontSize: '0.85rem' }}>{row.player_name ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.78rem' }}>
              {COLS.filter(c => c.key !== 'player_name').map(col => (
                <div key={col.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text-faint)' }}>{col.label}</span>
                  <span>{renderValue(col, row)}</span>
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
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={TH_STYLE('center')}>#</th>
          {COLS.map(col => (
            <th
              key={col.key}
              onClick={() => handleSort(col.key)}
              tabIndex={0}
              onKeyDown={onEnterOrSpace(() => handleSort(col.key))}
              aria-sort={sortKey === col.key ? (sortAsc ? 'ascending' : 'descending') : 'none'}
              style={{
                ...TH_STYLE(col.align),
                color: sortKey === col.key ? 'var(--accent)' : TH_STYLE().color,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              {col.label}
              {sortKey === col.key ? (sortAsc ? ' ▲' : ' ▼') : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, i) => (
          <tr
            key={row.player_id}
            onClick={() => navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`)}
            tabIndex={0}
            onKeyDown={onEnterOrSpace(() => navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`))}
            style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)',
              transition: 'background 0.12s' }}
            onMouseEnter={e => e.currentTarget.style.background = '#38bdf808'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <td style={{ padding: '0.65rem 1rem', textAlign: 'center', color: 'var(--text-faint)',
              fontSize: '0.78rem', fontFamily: "'Orbitron',sans-serif" }}>{i + 1}</td>
            <td style={{ padding: '0.65rem 1rem', color: 'var(--text)', fontSize: '0.85rem',
              fontWeight: '600' }}>{row.player_name ?? '—'}</td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'center', fontSize: '0.8rem' }}>
              {renderValue(COL_BY_KEY.last_rank, row)}
            </td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', fontSize: '0.82rem' }}>
              {renderValue(COL_BY_KEY.attack_pct, row)}
            </td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', fontSize: '0.82rem' }}>
              {renderValue(COL_BY_KEY.hp_pct, row)}
            </td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', fontSize: '0.82rem' }}>
              {renderValue(COL_BY_KEY.defense_pct, row)}
            </td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', color: 'var(--text-dim)',
              fontSize: '0.75rem' }}>{renderValue(COL_BY_KEY.recorded_date, row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
