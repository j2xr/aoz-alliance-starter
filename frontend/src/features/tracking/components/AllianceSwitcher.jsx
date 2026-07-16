import { useNavigate, useParams } from 'react-router-dom';
import { useUserAlliances } from '../hooks/useUserAlliances';

export function AllianceSwitcher() {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const { data: alliances = [], isLoading } = useUserAlliances();

  if (isLoading) {
    return (
      <div style={{ padding: '0.75rem 1rem', fontSize: '0.7rem',
        fontFamily: "'Orbitron',sans-serif", color: '#4a5568', letterSpacing: '0.08em' }}>
        LOADING…
      </div>
    );
  }

  if (alliances.length === 0) {
    return (
      <div style={{ padding: '0.75rem 1rem' }}>
        <div style={{ fontSize: '0.65rem', color: '#4a5568', fontFamily: "'Orbitron',sans-serif",
          letterSpacing: '0.06em', marginBottom: '0.4rem' }}>ALLIANCES</div>
        <div style={{ fontSize: '0.72rem', color: '#2a2d3e', fontStyle: 'italic' }}>
          No alliance available
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '0.75rem 0' }}>
      <div style={{ fontSize: '0.65rem', color: '#4a5568', fontFamily: "'Orbitron',sans-serif",
        letterSpacing: '0.06em', marginBottom: '0.5rem', padding: '0 1rem' }}>
        ALLIANCES
      </div>
      {alliances.map(alliance => {
        const isActive = alliance.id === allianceId;
        return (
          <button
            key={alliance.id}
            onClick={() => navigate(`/tracking/alliances/${alliance.id}/events`)}
            style={{
              width: '100%', textAlign: 'left', background: isActive ? '#38bdf818' : 'transparent',
              border: 'none', borderLeft: `3px solid ${isActive ? '#38bdf8' : 'transparent'}`,
              borderBottom: '1px solid #1a1d2e',
              padding: '0.6rem 1rem', cursor: 'pointer', transition: 'background 0.15s',
            }}
          >
            <div style={{ fontSize: '0.82rem', fontWeight: '600',
              color: isActive ? '#38bdf8' : '#e2e8f0' }}>
              {alliance.tag ? `[${alliance.tag}] ` : ''}{alliance.name}
            </div>
            <div style={{ fontSize: '0.62rem', color: '#4a5568', marginTop: '0.1rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em' }}>
              {alliance.role}
            </div>
          </button>
        );
      })}
    </div>
  );
}
