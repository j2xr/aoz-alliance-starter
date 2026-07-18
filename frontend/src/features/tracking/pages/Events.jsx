import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAllianceEvents } from '../hooks/useAllianceEvents';
import { EventCard } from '../components/EventCard';
import { isAccessDenied } from '../queries/atQueries';

const PAGE_SIZES = [20, 50, 100];

export function EventsPage() {
  const { allianceId } = useParams();
  const [limit, setLimit] = useState(20);
  const { data: events = [], isLoading, error } = useAllianceEvents(allianceId, limit);

  if (!allianceId) {
    return (
      <div style={{ color: 'var(--text-faint)', textAlign: 'center', padding: '3rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem' }}>
        Select an alliance in the sidebar
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
        color: 'var(--text-faint)', letterSpacing: '0.1em' }}>
        LOADING…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: '#ff4d4d0d', border: '1px solid #ff4d4d44',
        borderRadius: '10px', padding: '1.5rem', color: 'var(--danger)', fontSize: '0.85rem' }}>
        {isAccessDenied(error)
          ? 'Access denied — you are not a member of this alliance.'
          : `Error: ${error.message}`}
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeUp 0.25s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: 'var(--accent)',
            textTransform: 'uppercase', fontFamily: "'Orbitron',sans-serif",
            marginBottom: '0.2rem' }}>
            History
          </div>
          <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.1rem',
            fontWeight: '900', color: 'var(--text)' }}>
            Events
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
          fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          <span>Show</span>
          {PAGE_SIZES.map(size => (
            <button key={size} onClick={() => setLimit(size)}
              style={{
                background: limit === size ? '#38bdf822' : 'transparent',
                border: `1px solid ${limit === size ? '#38bdf844' : 'var(--border-strong)'}`,
                borderRadius: '6px', color: limit === size ? 'var(--accent)' : 'var(--text-muted)',
                padding: '0.2rem 0.5rem', cursor: 'pointer', fontSize: '0.7rem',
                fontFamily: "'Orbitron',sans-serif",
              }}>
              {size}
            </button>
          ))}
        </div>
      </div>

      {events.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', background: 'var(--bg-panel)',
          border: '1px solid var(--bg-hover)', borderRadius: '12px' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📊</div>
          <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.78rem',
            color: 'var(--text-faint)' }}>
            No events recorded
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.6rem' }}>
          {events.map(event => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {events.length >= limit && (
        <div style={{ textAlign: 'center', marginTop: '1rem' }}>
          <button onClick={() => setLimit(l => l + 20)}
            style={{ background: 'transparent', border: '1px solid var(--border-strong)',
              borderRadius: '8px', color: 'var(--text-muted)', padding: '0.5rem 1.25rem',
              cursor: 'pointer', fontSize: '0.75rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.05em' }}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
