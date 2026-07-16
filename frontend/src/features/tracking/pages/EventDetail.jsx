import { useNavigate, useParams } from 'react-router-dom';
import { useEventLeaderboard } from '../hooks/useEventLeaderboard';
import { useAllianceEvents } from '../hooks/useAllianceEvents';
import { LeaderboardTable } from '../components/LeaderboardTable';

function formatDatetime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

export function EventDetailPage() {
  const { allianceId, eventId } = useParams();
  const navigate = useNavigate();
  const { data: leaderboard = [], isLoading: lbLoading, error: lbError } = useEventLeaderboard(eventId);

  // Fetch event meta from the events list (avoid a separate query for now)
  const { data: events = [] } = useAllianceEvents(allianceId, 100);
  const event = events.find(e => e.id === eventId);

  const typeName = event?.at_event_types?.display_name ?? event?.at_event_types?.code ?? '—';

  return (
    <div style={{ animation: 'fadeUp 0.25s ease' }}>
      {/* Breadcrumb */}
      <button onClick={() => navigate(`/tracking/alliances/${allianceId}/events`)}
        style={{ background: 'transparent', border: 'none', color: '#38bdf8',
          cursor: 'pointer', fontSize: '0.75rem', padding: '0',
          marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        ← Back to events
      </button>

      {/* Event header */}
      <div style={{ background: '#0f111a', border: '1px solid #1e2132',
        borderLeft: '3px solid #38bdf8', borderRadius: '12px',
        padding: '1.25rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem',
          alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <span style={{ background: '#38bdf822', color: '#38bdf8',
              border: '1px solid #38bdf844', borderRadius: '999px',
              padding: '0.15rem 0.65rem', fontSize: '0.68rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.05em',
              fontWeight: '700' }}>
              {typeName}
            </span>
            <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#94a3b8' }}>
              {event ? formatDatetime(event.event_datetime) : '—'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {event?.alliance_rank != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900', color: '#ffd700' }}>
                  #{event.alliance_rank}
                </div>
                <div style={{ fontSize: '0.62rem', color: '#4a5568' }}>Ranking</div>
              </div>
            )}
            {event?.total_battlers != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900', color: '#e2e8f0' }}>
                  {event.total_battlers}
                </div>
                <div style={{ fontSize: '0.62rem', color: '#4a5568' }}>Fighters</div>
              </div>
            )}
            {event?.total_points != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900', color: '#38bdf8' }}>
                  {event.total_points.toLocaleString()}
                </div>
                <div style={{ fontSize: '0.62rem', color: '#4a5568' }}>Total points</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <div style={{ background: '#0f111a', border: '1px solid #1e2132',
        borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #1e2132',
          fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
          color: '#e2e8f0', letterSpacing: '0.06em' }}>
          LEADERBOARD
        </div>
        {lbLoading ? (
          <div style={{ textAlign: 'center', padding: '3rem',
            fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem', color: '#4a5568' }}>
            LOADING…
          </div>
        ) : lbError ? (
          <div style={{ padding: '1.5rem', color: '#ff4d4d', fontSize: '0.82rem' }}>
            Error: {lbError.message}
          </div>
        ) : (
          <LeaderboardTable rows={leaderboard} />
        )}
      </div>
    </div>
  );
}
