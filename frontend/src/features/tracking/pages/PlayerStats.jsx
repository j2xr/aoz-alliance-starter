import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePlayerStatsLatest } from '../hooks/usePlayerStatsLatest';
import { PlayerStatsTable } from '../components/PlayerStatsTable';
import { PlayerSearchInput } from '../components/PlayerSearchInput';
import { isAccessDenied } from '../queries/atQueries';

export function PlayerStatsPage() {
  const { allianceId } = useParams();
  const { data: rows = [], isLoading, error } = usePlayerStatsLatest(allianceId);
  const [search, setSearch] = useState('');
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => (r.player_name ?? '').toLowerCase().includes(q));
  }, [rows, search]);

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
        {isAccessDenied(error)
          ? 'Access denied — you are not a member of this alliance.'
          : `Error: ${error.message}`}
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeUp 0.25s ease' }}>
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: '#38bdf8',
          textTransform: 'uppercase', fontFamily: "'Orbitron',sans-serif",
          marginBottom: '0.2rem' }}>
          Military
        </div>
        <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.1rem',
          fontWeight: '900', color: '#e2e8f0' }}>
          Combat Stats
        </h2>
        <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.25rem' }}>
          {rows.length} player{rows.length !== 1 ? 's' : ''} · Latest values · Click a name to see history
        </div>
      </div>

      <PlayerSearchInput value={search} onChange={setSearch} />

      <div style={{ background: '#0f111a', border: '1px solid #1e2132',
        borderRadius: '12px', overflow: 'hidden' }}>
        <PlayerStatsTable rows={filteredRows} />
      </div>
    </div>
  );
}
