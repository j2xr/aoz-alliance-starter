import { useNavigate, useParams } from 'react-router-dom';
import { useUserAlliances } from '../hooks/useUserAlliances';

export function AllianceSwitcher() {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const { data: alliances = [], isLoading } = useUserAlliances();

  if (isLoading) {
    return (
      <div style={{ padding: '0.75rem 1rem', fontSize: '0.7rem',
        fontFamily: "'Orbitron',sans-serif", color: 'var(--text-faint)', letterSpacing: '0.08em' }}>
        LOADING…
      </div>
    );
  }

  if (alliances.length === 0) {
    return (
      <div style={{ padding: '0.75rem 1rem' }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--text-faint)', fontFamily: "'Orbitron',sans-serif",
          letterSpacing: '0.06em', marginBottom: '0.4rem' }}>ALLIANCES</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--border-strong)', fontStyle: 'italic' }}>
          No alliance available
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '0.75rem 0' }}>
      <div style={{ fontSize: '0.65rem', color: 'var(--text-faint)', fontFamily: "'Orbitron',sans-serif",
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
              border: 'none', borderLeft: `3px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
              borderBottom: '1px solid var(--bg-hover)',
              padding: '0.6rem 1rem', cursor: 'pointer', transition: 'background 0.15s',
            }}
          >
            <div style={{ fontSize: '0.82rem', fontWeight: '600',
              color: isActive ? 'var(--accent)' : 'var(--text)' }}>
              {alliance.tag ? `[${alliance.tag}] ` : ''}{alliance.name}
            </div>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)', marginTop: '0.1rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em' }}>
              {alliance.role}
            </div>
          </button>
        );
      })}
    </div>
  );
}
