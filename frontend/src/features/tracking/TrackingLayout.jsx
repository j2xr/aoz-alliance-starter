import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { AllianceSwitcher } from './components/AllianceSwitcher';
import { LoginPage } from './components/LoginPage';
import { useAuth } from './hooks/useAuth';
import { useUserAlliances } from './hooks/useUserAlliances';

const MOBILE_BREAKPOINT = '(max-width: 720px)';

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
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the mobile sidebar drawer on navigation
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

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
        minHeight: '100vh', background: 'var(--bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
        color: 'var(--text-faint)', letterSpacing: '0.1em',
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
        body{background:var(--bg);min-height:100vh;}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:var(--bg-panel)}::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .tr-alliance-btn:hover{background:#38bdf80a!important;}
        .tr-back-btn:hover{background:var(--bg-hover)!important;}
        .tr-tab-btn:hover{background:var(--bg-hover)!important;}
        .tr-logout-btn:hover{color:var(--danger)!important;border-color:#ff4d4d44!important;}
      `}</style>

      <div style={{ fontFamily: "'Rajdhani',sans-serif", background: 'var(--bg)',
        minHeight: '100vh', color: 'var(--text)' }}>

        {/* ── Header ── */}
        <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-deep)',
          padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {isMobile && (
            <button
              className="tr-back-btn"
              onClick={() => setSidebarOpen(open => !open)}
              aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={sidebarOpen}
              style={{ background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: '7px',
                color: 'var(--text-muted)', padding: '0.35rem 0.6rem', cursor: 'pointer', fontSize: '0.9rem',
                lineHeight: 1 }}>
              ☰
            </button>
          )}
          <button className="tr-back-btn"
            onClick={() => navigate('/')}
            style={{ background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: '7px',
              color: 'var(--text-muted)', padding: '0.35rem 0.7rem', cursor: 'pointer', fontSize: '0.75rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em' }}>
            ← Calendar
          </button>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: 'var(--accent)',
              textTransform: 'uppercase' }}>Alliance Tracker</div>
            <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: '900',
              background: 'linear-gradient(135deg,var(--accent),#0ea5e9)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              AOZ ORIGINS
            </div>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* User info + logout */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', maxWidth: '180px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.user.email}
            </div>
            <button
              className="tr-logout-btn"
              onClick={() => supabase.auth.signOut()}
              style={{ background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: '7px',
                color: 'var(--text-dim)', padding: '0.35rem 0.7rem', cursor: 'pointer', fontSize: '0.72rem',
                fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em',
                transition: 'color 0.15s, border-color 0.15s' }}>
              LOGOUT
            </button>
          </div>
        </div>

        {/* ── Layout: sidebar + main ── */}
        <div style={{ display: 'flex', minHeight: 'calc(100vh - 58px)', position: 'relative' }}>

          {/* Backdrop (mobile drawer only) */}
          {isMobile && sidebarOpen && (
            <div
              onClick={() => setSidebarOpen(false)}
              style={{ position: 'fixed', inset: 0, top: '58px', background: 'rgba(0,0,0,0.55)', zIndex: 20 }}
            />
          )}

          {/* Sidebar */}
          <aside style={{
            width: '220px', flexShrink: 0, borderRight: '1px solid var(--border)',
            background: '#090b13', display: 'flex', flexDirection: 'column',
            ...(isMobile ? {
              position: 'fixed', top: '58px', bottom: 0, left: 0, zIndex: 21,
              transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.2s ease', overflowY: 'auto',
            } : {}),
          }}>
            <AllianceSwitcher />

            {/* Per-alliance sub-tabs (shown only when an alliance is selected) */}
            {allianceId && (
              <div style={{ borderTop: '1px solid var(--border)', padding: '0.75rem 0' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-faint)',
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
                        border: 'none', borderLeft: `3px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                        padding: '0.55rem 1rem', cursor: 'pointer',
                        fontSize: '0.8rem', fontWeight: isActive ? '600' : '400',
                        color: isActive ? 'var(--accent)' : 'var(--text-muted)',
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
