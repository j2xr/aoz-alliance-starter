import { useNavigate, useParams } from 'react-router-dom';

function formatDatetime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

export function EventCard({ event }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();

  const typeName = event.at_event_types?.display_name ?? event.at_event_types?.code ?? '—';

  return (
    <button
      onClick={() => navigate(`/tracking/alliances/${allianceId}/events/${event.id}`)}
      style={{
        width: '100%', textAlign: 'left', background: 'var(--bg-panel)',
        border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)',
        borderRadius: '10px', padding: '0.9rem 1rem', cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = '#38bdf844';
        e.currentTarget.style.background = '#38bdf808';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--border)';
        e.currentTarget.style.borderLeftColor = 'var(--accent)';
        e.currentTarget.style.background = 'var(--bg-panel)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: '0.75rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
            marginBottom: '0.35rem', flexWrap: 'wrap' }}>
            <span style={{ background: '#38bdf822', color: 'var(--accent)',
              border: '1px solid #38bdf844', borderRadius: '999px',
              padding: '0.1rem 0.55rem', fontSize: '0.65rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em',
              fontWeight: '700', whiteSpace: 'nowrap' }}>
              {typeName}
            </span>
            {event.alliance_rank != null && (
              <span style={{ fontSize: '0.72rem', color: 'var(--gold)',
                fontFamily: "'Orbitron',sans-serif" }}>
                #{event.alliance_rank}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
            {formatDatetime(event.event_datetime)}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {event.total_points != null && (
            <div>
              <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem',
                fontWeight: '700', color: 'var(--text)' }}>
                {event.total_points.toLocaleString()}
              </span>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-faint)',
                display: 'block', textAlign: 'right' }}>total pts</span>
            </div>
          )}
          {event.total_battlers != null && (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>
              {event.total_battlers} fighters
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
