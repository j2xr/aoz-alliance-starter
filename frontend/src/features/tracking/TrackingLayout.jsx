import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { AllianceSwitcher } from './components/AllianceSwitcher';
import { LoginPage } from './components/LoginPage';
import { useAuth } from './hooks/useAuth';
import { useUserAlliances } from './hooks/useUserAlliances';

const NAV_TABS = [
  { path: 'events', label: '📋 Events' },
  { path: 'players', label: '👥 Players' },
  { path: 'donations', label: '💰 Donations' },
  { path: 'stats', label: '⚔️ Stats' },
];

function detectActiveTab(pathname) {
  if (pathname.includes('/stats')) return 'stats';
  if (pathname.includes('/donations')) return 'donations';
  if (pathname.includes('/players')) return 'players';
  return 'events';
}

export function TrackingLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { allianceId } = useParams();
  const session = useAuth();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef(undefined);

  // Clear query cache when the logged-in user changes (login / logout / switch)
  useEffect(() => {
    const userId = session?.user?.id ?? null;
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
      queryClient.clear();
    }
    prevUserIdRef.current = userId;
  }, [session, queryClient]);

  const activeTab = detectActiveTab(location.pathname);

  // Still resolving session
  if (session === undefined) {
    return (
      <div style={{
        minHeight: '100vh', background: '#070810',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
        color: '#4a5568', letterSpacing: '0.1em',
      }}>
        LOADING…
      </div>
    );
  }

  // Not authenticated
  if (session === null) {
    return <LoginPage />;
  }

  // Authenticated
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;600&display=swap');
        *{margin:0;padding:0;box-sizing:border-box;}
        body{background:#070810;min-height:100vh;}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0f111a}::-webkit-scrollbar-thumb{background:#2a2d3e;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .tr-alliance-btn:hover{background:#38bdf80a!important;}
        .tr-back-btn:hover{background:#1a1d2e!important;}
        .tr-tab-btn:hover{background:#1a1d2e!important;}
        .tr-logout-btn:hover{color:#ff4d4d!important;border-color:#ff4d4d44!important;}
      `}</style>

      <div style={{ fontFamily: "'Rajdhani',sans-serif", background: '#070810',
        minHeight: '100vh', color: '#e2e8f0' }}>

        {/* ── Header ── */}
        <div style={{ borderBottom: '1px solid #1e2132', background: '#0a0c14',
          padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button className="tr-back-btn"
            onClick={() => navigate('/')}
            style={{ background: 'transparent', border: '1px solid #2a2d3e', borderRadius: '7px',
              color: '#94a3b8', padding: '0.35rem 0.7rem', cursor: 'pointer', fontSize: '0.75rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em' }}>
            ← Calendar
          </button>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: '#38bdf8',
              textTransform: 'uppercase' }}>Alliance Tracker</div>
            <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: '900',
              background: 'linear-gradient(135deg,#38bdf8,#0ea5e9)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              AOZ ORIGINS
            </div>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* User info + logout */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ fontSize: '0.75rem', color: '#4a5568', maxWidth: '180px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.user.email}
            </div>
            <button
              className="tr-logout-btn"
              onClick={() => supabase.auth.signOut()}
              style={{ background: 'transparent', border: '1px solid #2a2d3e', borderRadius: '7px',
                color: '#64748b', padding: '0.35rem 0.7rem', cursor: 'pointer', fontSize: '0.72rem',
                fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em',
                transition: 'color 0.15s, border-color 0.15s' }}>
              LOGOUT
            </button>
          </div>
        </div>

        {/* ── Layout: sidebar + main ── */}
        <div style={{ display: 'flex', minHeight: 'calc(100vh - 58px)' }}>

          {/* Sidebar */}
          <aside style={{ width: '220px', flexShrink: 0, borderRight: '1px solid #1e2132',
            background: '#090b13', display: 'flex', flexDirection: 'column' }}>
            <AllianceSwitcher />

            {/* Per-alliance sub-tabs (shown only when an alliance is selected) */}
            {allianceId && (
              <div style={{ borderTop: '1px solid #1e2132', padding: '0.75rem 0' }}>
                <div style={{ fontSize: '0.65rem', color: '#4a5568',
                  fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.06em',
                  marginBottom: '0.5rem', padding: '0 1rem' }}>
                  NAVIGATION
                </div>
                {NAV_TABS.map(tab => {
                  const isActive = activeTab === tab.path;
                  return (
                    <button
                      key={tab.path}
                      className="tr-tab-btn"
                      onClick={() => navigate(`/tracking/alliances/${allianceId}/${tab.path}`)}
                      style={{
                        width: '100%', textAlign: 'left', background: isActive ? '#38bdf810' : 'transparent',
                        border: 'none', borderLeft: `3px solid ${isActive ? '#38bdf8' : 'transparent'}`,
                        padding: '0.55rem 1rem', cursor: 'pointer',
                        fontSize: '0.8rem', fontWeight: isActive ? '600' : '400',
                        color: isActive ? '#38bdf8' : '#94a3b8',
                        transition: 'background 0.15s',
                      }}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          {/* Main content */}
          <main style={{ flex: 1, padding: '1.5rem', overflowY: 'auto', minWidth: 0 }}>
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
