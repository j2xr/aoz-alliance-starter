import { useNavigate, useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { formatHonor, formatUpdatedAt } from '../utils/donationFormat';
import { onEnterOrSpace } from '@/lib/a11y';

const PAGE_SIZE = 50;

function positionDecoration(position) {
  if (position === 1) return { medal: '🥇', color: 'var(--gold)' };
  if (position === 2) return { medal: '🥈', color: '#cbd5e1' };
  if (position === 3) return { medal: '🥉', color: '#cd7f32' };
  return { medal: null, color: 'var(--text-faint)' };
}

const COLS = [
  { key: 'position', label: '#', align: 'right', numeric: true },
  { key: 'player_name', label: 'Player', align: 'left', numeric: false },
  { key: 'player_rank', label: 'Rank', align: 'left', numeric: false },
  { key: 'alliance_honor', label: 'Alliance Honor', align: 'right', numeric: true },
];

export function DonationLeaderboardTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState('position');
  const [sortAsc, setSortAsc] = useState(true);

  const numericSort = COLS.find(c => c.key === sortKey)?.numeric ?? false;
  const sorted = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (numericSort) return sortAsc ? av - bv : bv - av;
      return sortAsc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  }, [rows, sortKey, sortAsc, numericSort]);

  const handleSort = key => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(key === 'player_name' || key === 'player_rank'); }
  };

  if (!rows || rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2.5rem 1.5rem',
        color: 'var(--text-faint)', fontSize: '0.8rem',
        fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.05em' }}>
        No donations recorded for this period
      </div>
    );
  }

  const visible = showAll ? sorted : sorted.slice(0, PAGE_SIZE);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {COLS.map(col => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                tabIndex={0}
                onKeyDown={onEnterOrSpace(() => handleSort(col.key))}
                aria-sort={sortKey === col.key ? (sortAsc ? 'ascending' : 'descending') : 'none'}
                style={{
                  ...thStyle(col.align),
                  color: sortKey === col.key ? 'var(--accent)' : thStyle().color,
                  cursor: 'pointer',
                }}
              >
                {col.label}
                {sortKey === col.key ? (sortAsc ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => {
            const deco = positionDecoration(row.position);
            return (
              <tr key={row.player_id ?? `${row.donation_period_id}-${i}`}
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
                <td style={{ padding: '0.55rem 0.75rem', textAlign: 'right',
                  fontFamily: "'Orbitron',sans-serif", fontWeight: '700',
                  color: deco.color, whiteSpace: 'nowrap' }}>
                  {deco.medal ? <span style={{ marginRight: '0.3rem' }}>{deco.medal}</span> : null}
                  {row.position}
                </td>
                <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text)', fontWeight: '600' }}>
                  {row.player_name ?? '—'}
                </td>
                <td style={{ padding: '0.55rem 0.75rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  {row.player_rank ?? '—'}
                </td>
                <td
                  title={row.updated_at ? `Updated on ${formatUpdatedAt(row.updated_at)}` : undefined}
                  style={{ padding: '0.55rem 0.75rem', textAlign: 'right',
                    fontWeight: '700', color: 'var(--accent)',
                    fontFamily: "'Orbitron',sans-serif" }}>
                  {formatHonor(row.alliance_honor)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length > PAGE_SIZE && (
        <div style={{ textAlign: 'center', padding: '0.75rem' }}>
          <button onClick={() => setShowAll(s => !s)}
            style={{ background: 'transparent', border: '1px solid var(--border-strong)',
              borderRadius: '8px', color: 'var(--text-muted)', padding: '0.4rem 1rem',
              cursor: 'pointer', fontSize: '0.72rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.05em' }}>
            {showAll ? `Collapse (first ${PAGE_SIZE})` : `Show all (${rows.length})`}
          </button>
        </div>
      )}
    </div>
  );
}

function thStyle(align) {
  return {
    padding: '0.55rem 0.75rem',
    textAlign: align,
    color: 'var(--text-dim)',
    fontFamily: "'Orbitron',sans-serif",
    fontSize: '0.62rem',
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };
}
