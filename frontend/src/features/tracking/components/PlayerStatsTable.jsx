import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

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
  color: '#4a5568',
  letterSpacing: '0.06em',
  borderBottom: '1px solid #1e2132',
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

export function PlayerStatsTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
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
      <div style={{ textAlign: 'center', padding: '2rem', color: '#4a5568',
        fontSize: '0.78rem', fontFamily: "'Orbitron',sans-serif" }}>
        No data
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={TH_STYLE('center')}>#</th>
          {COLS.map(col => (
            <th
              key={col.key}
              onClick={() => handleSort(col.key)}
              style={{
                ...TH_STYLE(col.align),
                color: sortKey === col.key ? '#38bdf8' : TH_STYLE().color,
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
            style={{ cursor: 'pointer', borderBottom: '1px solid #1e2132',
              transition: 'background 0.12s' }}
            onMouseEnter={e => e.currentTarget.style.background = '#38bdf808'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <td style={{ padding: '0.65rem 1rem', textAlign: 'center', color: '#4a5568',
              fontSize: '0.78rem', fontFamily: "'Orbitron',sans-serif" }}>{i + 1}</td>
            <td style={{ padding: '0.65rem 1rem', color: '#e2e8f0', fontSize: '0.85rem',
              fontWeight: '600' }}>{row.player_name ?? '—'}</td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'center', color: '#ffd700',
              fontSize: '0.8rem', fontFamily: "'Orbitron',sans-serif" }}>{row.last_rank ?? '—'}</td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', color: '#38bdf8',
              fontSize: '0.82rem', fontFamily: "'Orbitron',sans-serif", fontWeight: '700' }}>
              {fmtPct(row.attack_pct)}
            </td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', color: '#22c55e',
              fontSize: '0.82rem', fontFamily: "'Orbitron',sans-serif" }}>
              {fmtPct(row.hp_pct)}
            </td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', color: '#fb923c',
              fontSize: '0.82rem', fontFamily: "'Orbitron',sans-serif" }}>
              {fmtPct(row.defense_pct)}
            </td>
            <td style={{ padding: '0.65rem 1rem', textAlign: 'right', color: '#64748b',
              fontSize: '0.75rem' }}>{fmtDate(row.recorded_date)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
