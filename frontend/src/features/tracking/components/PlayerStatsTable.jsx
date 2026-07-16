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

export function PlayerStatsTable({ rows }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();

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
          <th style={TH_STYLE()}>PLAYER</th>
          <th style={TH_STYLE('center')}>RANK</th>
          <th style={TH_STYLE('right')}>ATK %</th>
          <th style={TH_STYLE('right')}>HP %</th>
          <th style={TH_STYLE('right')}>DEF %</th>
          <th style={TH_STYLE('right')}>DATE</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
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
