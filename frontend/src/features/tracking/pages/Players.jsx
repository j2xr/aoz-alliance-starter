import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useParticipationRates } from '../hooks/useParticipationRates';
import { ParticipationRateTable } from '../components/ParticipationRateTable';
import { PlayerSearchInput } from '../components/PlayerSearchInput';
import { isAccessDenied } from '../queries/atQueries';

export function PlayersPage() {
  const { allianceId } = useParams();
  const { data: rows = [], isLoading, error } = useParticipationRates(allianceId);
  const [search, setSearch] = useState('');
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => (r.player_name ?? '').toLowerCase().includes(q));
  }, [rows, search]);

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
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: 'var(--accent)',
          textTransform: 'uppercase', fontFamily: "'Orbitron',sans-serif",
          marginBottom: '0.2rem' }}>
          Statistics
        </div>
        <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.1rem',
          fontWeight: '900', color: 'var(--text)' }}>
          Players
        </h2>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
          {rows.length} player{rows.length !== 1 ? 's' : ''} · Click a name to see details
        </div>
      </div>

      <PlayerSearchInput value={search} onChange={setSearch} />

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)',
        borderRadius: '12px', overflow: 'hidden' }}>
        <ParticipationRateTable rows={filteredRows} />
      </div>
    </div>
  );
}
