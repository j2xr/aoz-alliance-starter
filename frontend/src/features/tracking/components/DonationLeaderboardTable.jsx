import { useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { formatHonor, formatUpdatedAt } from '../utils/donationFormat';

const PAGE_SIZE = 50;

function positionDecoration(position) {
  if (position === 1) return { medal: '🥇', color: '#ffd700' };
  if (position === 2) return { medal: '🥈', color: '#cbd5e1' };
  if (position === 3) return { medal: '🥉', color: '#cd7f32' };
  return { medal: null, color: '#4a5568' };
}

export function DonationLeaderboardTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const [showAll, setShowAll] = useState(false);

  if (!rows || rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2.5rem 1.5rem',
        color: '#4a5568', fontSize: '0.8rem',
        fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.05em' }}>
        No donations recorded for this period
      </div>
    );
  }

  const visible = showAll ? rows : rows.slice(0, PAGE_SIZE);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #1e2132' }}>
            <th style={thStyle('right')}>#</th>
            <th style={thStyle('left')}>Player</th>
            <th style={thStyle('left')}>Rank</th>
            <th style={thStyle('right')}>Alliance Honor</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => {
            const deco = positionDecoration(row.position);
            return (
              <tr key={row.player_id ?? `${row.donation_period_id}-${i}`}
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
                  color: deco.color, whiteSpace: 'nowrap' }}>
                  {deco.medal ? <span style={{ marginRight: '0.3rem' }}>{deco.medal}</span> : null}
                  {row.position}
                </td>
                <td style={{ padding: '0.55rem 0.75rem', color: '#e2e8f0', fontWeight: '600' }}>
                  {row.player_name ?? '—'}
                </td>
                <td style={{ padding: '0.55rem 0.75rem', color: '#94a3b8', fontSize: '0.75rem' }}>
                  {row.player_rank ?? '—'}
                </td>
                <td
                  title={row.updated_at ? `Updated on ${formatUpdatedAt(row.updated_at)}` : undefined}
                  style={{ padding: '0.55rem 0.75rem', textAlign: 'right',
                    fontWeight: '700', color: '#38bdf8',
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
            style={{ background: 'transparent', border: '1px solid #2a2d3e',
              borderRadius: '8px', color: '#94a3b8', padding: '0.4rem 1rem',
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
    color: '#64748b',
    fontFamily: "'Orbitron',sans-serif",
    fontSize: '0.62rem',
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };
}
