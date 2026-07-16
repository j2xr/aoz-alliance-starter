import { useState } from 'react';
import { supabase } from '@/lib/supabase';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) setError(error.message);
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#070810',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Rajdhani',sans-serif", padding: '1rem',
    }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: '#38bdf8',
            textTransform: 'uppercase', marginBottom: '0.3rem',
            fontFamily: "'Orbitron',sans-serif" }}>
            Alliance Tracker
          </div>
          <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.6rem', fontWeight: '900',
            background: 'linear-gradient(135deg,#38bdf8,#0ea5e9)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            AOZ ORIGINS
          </div>
        </div>

        {/* Card */}
        <div style={{ background: '#0a0c14', border: '1px solid #1e2132',
          borderRadius: '14px', padding: '2rem' }}>
          <div style={{ fontSize: '0.7rem', fontFamily: "'Orbitron',sans-serif",
            color: '#4a5568', letterSpacing: '0.08em', marginBottom: '1.5rem' }}>
            LOGIN
          </div>

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8',
                marginBottom: '0.4rem', letterSpacing: '0.04em' }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                style={{
                  width: '100%', background: '#070810', border: '1px solid #2a2d3e',
                  borderRadius: '8px', padding: '0.65rem 0.85rem',
                  color: '#e2e8f0', fontSize: '0.9rem',
                  fontFamily: "'Rajdhani',sans-serif", outline: 'none',
                  boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = '#38bdf844'}
                onBlur={e => e.target.style.borderColor = '#2a2d3e'}
              />
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8',
                marginBottom: '0.4rem', letterSpacing: '0.04em' }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                style={{
                  width: '100%', background: '#070810', border: '1px solid #2a2d3e',
                  borderRadius: '8px', padding: '0.65rem 0.85rem',
                  color: '#e2e8f0', fontSize: '0.9rem',
                  fontFamily: "'Rajdhani',sans-serif", outline: 'none',
                  boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = '#38bdf844'}
                onBlur={e => e.target.style.borderColor = '#2a2d3e'}
              />
            </div>

            {error && (
              <div style={{ background: '#ff4d4d0d', border: '1px solid #ff4d4d44',
                borderRadius: '8px', padding: '0.75rem', color: '#ff4d4d',
                fontSize: '0.8rem', marginBottom: '1rem' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%', padding: '0.75rem',
                background: loading ? '#0ea5e930' : 'linear-gradient(135deg,#38bdf8,#0ea5e9)',
                border: 'none', borderRadius: '8px',
                color: loading ? '#38bdf8' : '#0a0c14',
                fontFamily: "'Orbitron',sans-serif", fontWeight: '700',
                fontSize: '0.8rem', letterSpacing: '0.06em',
                cursor: loading ? 'not-allowed' : 'pointer',
                transition: 'opacity 0.15s',
              }}
            >
              {loading ? 'LOGGING IN…' : 'LOG IN'}
            </button>
          </form>
        </div>

        <div style={{ textAlign: 'center', marginTop: '1.5rem',
          fontSize: '0.75rem', color: '#2a2d3e', lineHeight: 1.6 }}>
          Access by invitation only.<br />
          Contact an administrator to obtain your credentials.
        </div>
      </div>
    </div>
  );
}
