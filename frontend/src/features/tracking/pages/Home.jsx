import { useNavigate } from 'react-router-dom';
import { useUserAlliances } from '../hooks/useUserAlliances';
import { useAuth } from '../hooks/useAuth';

export function TrackingHome() {
  const navigate = useNavigate();
  const session = useAuth();
  const { data: alliances = [], isLoading, error } = useUserAlliances();

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
        Failed to load: {error.message}
      </div>
    );
  }

  if (alliances.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', animation: 'fadeUp 0.25s ease' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🏰</div>
        <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.9rem',
          color: '#38bdf8', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>
          ALLIANCE TRACKER
        </div>
        <div style={{ fontSize: '0.85rem', color: '#64748b', maxWidth: '400px', margin: '0 auto' }}>
          You are not a member of any alliance yet.
          An administrator must add you via the Supabase console.
        </div>
        {session?.user?.id && (
          <div style={{ marginTop: '1.5rem', background: '#0f111a', border: '1px solid #1e2132',
            borderRadius: '10px', padding: '1rem', maxWidth: '440px', margin: '1.5rem auto 0',
            textAlign: 'left' }}>
            <div style={{ fontSize: '0.68rem', fontFamily: "'Orbitron',sans-serif",
              color: '#4a5568', letterSpacing: '0.06em', marginBottom: '0.75rem' }}>
              YOUR USER ID (share with your admin)
            </div>
            <code style={{ fontSize: '0.72rem', color: '#38bdf8', display: 'block',
              fontFamily: 'monospace', lineHeight: 1.6, wordBreak: 'break-all' }}>
              {session.user.id}
            </code>
            <div style={{ marginTop: '1rem', borderTop: '1px solid #1e2132', paddingTop: '0.75rem',
              fontSize: '0.68rem', fontFamily: "'Orbitron',sans-serif",
              color: '#4a5568', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
              SQL COMMAND (Supabase admin)
            </div>
            <code style={{ fontSize: '0.72rem', color: '#94a3b8', display: 'block',
              fontFamily: 'monospace', lineHeight: 1.6 }}>
              {`insert into at_alliance_members\n(alliance_id, user_id, role)\nvalues ('<alliance_id>', '${session.user.id}', 'viewer');`}
            </code>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeUp 0.25s ease' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.3em', color: '#38bdf8',
          textTransform: 'uppercase', marginBottom: '0.3rem',
          fontFamily: "'Orbitron',sans-serif" }}>
          Alliance Tracker
        </div>
        <h1 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
          fontWeight: '900', color: '#e2e8f0' }}>
          Your alliances
        </h1>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))',
        gap: '1rem' }}>
        {alliances.map(alliance => (
          <button
            key={alliance.id}
            onClick={() => navigate(`/tracking/alliances/${alliance.id}/events`)}
            style={{
              background: '#0f111a', border: '1px solid #1e2132',
              borderRadius: '12px', padding: '1.25rem', cursor: 'pointer',
              textAlign: 'left', transition: 'border-color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = '#38bdf844';
              e.currentTarget.style.background = '#38bdf808';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = '#1e2132';
              e.currentTarget.style.background = '#0f111a';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem',
              marginBottom: '0.5rem' }}>
              <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                fontWeight: '900', color: '#38bdf8', lineHeight: 1 }}>
                {alliance.tag ? `[${alliance.tag}]` : '🏰'}
              </div>
            </div>
            <div style={{ fontWeight: '700', fontSize: '1rem', color: '#e2e8f0',
              marginBottom: '0.2rem' }}>
              {alliance.name}
            </div>
            <div style={{ fontSize: '0.65rem', color: '#4a5568',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em' }}>
              {alliance.role}
            </div>
            <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#38bdf8',
              display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              View events →
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
