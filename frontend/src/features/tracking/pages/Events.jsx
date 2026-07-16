import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAllianceEvents } from '../hooks/useAllianceEvents';
import { EventCard } from '../components/EventCard';

const PAGE_SIZES = [20, 50, 100];

export function EventsPage() {
  const { allianceId } = useParams();
  const [limit, setLimit] = useState(20);
  const { data: events = [], isLoading, error } = useAllianceEvents(allianceId, limit);

  if (!allianceId) {
    return (
      <div style={{ color: '#4a5568', textAlign: 'center', padding: '3rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem' }}>
        Select an alliance in the sidebar
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
        color: '#4a5568', letterSpacing: '0.1em' }}>
        LOADING…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: '#ff4d4d0d', border: '1px solid #ff4d4d44',
        borderRadius: '10px', padding: '1.5rem', color: '#ff4d4d', fontSize: '0.85rem' }}>
        {error.message.includes('0 rows')
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
          <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: '#38bdf8',
            textTransform: 'uppercase', fontFamily: "'Orbitron',sans-serif",
            marginBottom: '0.2rem' }}>
            History
          </div>
          <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.1rem',
            fontWeight: '900', color: '#e2e8f0' }}>
            Events
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
          fontSize: '0.72rem', color: '#64748b' }}>
          <span>Show</span>
          {PAGE_SIZES.map(size => (
            <button key={size} onClick={() => setLimit(size)}
              style={{
                background: limit === size ? '#38bdf822' : 'transparent',
                border: `1px solid ${limit === size ? '#38bdf844' : '#2a2d3e'}`,
                borderRadius: '6px', color: limit === size ? '#38bdf8' : '#94a3b8',
                padding: '0.2rem 0.5rem', cursor: 'pointer', fontSize: '0.7rem',
                fontFamily: "'Orbitron',sans-serif",
              }}>
              {size}
            </button>
          ))}
        </div>
      </div>

      {events.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', background: '#0f111a',
          border: '1px solid #1a1d2e', borderRadius: '12px' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📊</div>
          <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.78rem',
            color: '#4a5568' }}>
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
            style={{ background: 'transparent', border: '1px solid #2a2d3e',
              borderRadius: '8px', color: '#94a3b8', padding: '0.5rem 1.25rem',
              cursor: 'pointer', fontSize: '0.75rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.05em' }}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
