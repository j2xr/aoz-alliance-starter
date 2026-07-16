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
        width: '100%', textAlign: 'left', background: '#0f111a',
        border: '1px solid #1e2132', borderLeft: '3px solid #38bdf8',
        borderRadius: '10px', padding: '0.9rem 1rem', cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = '#38bdf844';
        e.currentTarget.style.background = '#38bdf808';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = '#1e2132';
        e.currentTarget.style.borderLeftColor = '#38bdf8';
        e.currentTarget.style.background = '#0f111a';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: '0.75rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
            marginBottom: '0.35rem', flexWrap: 'wrap' }}>
            <span style={{ background: '#38bdf822', color: '#38bdf8',
              border: '1px solid #38bdf844', borderRadius: '999px',
              padding: '0.1rem 0.55rem', fontSize: '0.65rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em',
              fontWeight: '700', whiteSpace: 'nowrap' }}>
              {typeName}
            </span>
            {event.alliance_rank != null && (
              <span style={{ fontSize: '0.72rem', color: '#ffd700',
                fontFamily: "'Orbitron',sans-serif" }}>
                #{event.alliance_rank}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
            {formatDatetime(event.event_datetime)}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {event.total_points != null && (
            <div>
              <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem',
                fontWeight: '700', color: '#e2e8f0' }}>
                {event.total_points.toLocaleString()}
              </span>
              <span style={{ fontSize: '0.6rem', color: '#4a5568',
                display: 'block', textAlign: 'right' }}>total pts</span>
            </div>
          )}
          {event.total_battlers != null && (
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '0.15rem' }}>
              {event.total_battlers} fighters
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
