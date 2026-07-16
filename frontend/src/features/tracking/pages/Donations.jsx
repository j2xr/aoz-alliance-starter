import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDonationLeaderboard, useDonationPeriods } from '../hooks/useDonations';
import { DonationLeaderboardTable } from '../components/DonationLeaderboardTable';
import { PlayerSearchInput } from '../components/PlayerSearchInput';
import { formatWeekLabel, getCurrentParisIsoWeekMondayString } from '../utils/donationFormat';
import { isAccessDenied } from '../queries/atQueries';

export function DonationsPage() {
  const { allianceId } = useParams();
  const {
    data: periods = [],
    isLoading: periodsLoading,
    error: periodsError,
  } = useDonationPeriods(allianceId);

  const [selectedPeriodId, setSelectedPeriodId] = useState(null);

  const defaultPeriodId = useMemo(() => {
    if (!periods.length) return null;
    const targetMonday = getCurrentParisIsoWeekMondayString();
    const currentWeek = periods.find(p => p.period_start === targetMonday);
    return (currentWeek ?? periods[0]).id;
  }, [periods]);

  useEffect(() => {
    if (selectedPeriodId == null && defaultPeriodId) {
      setSelectedPeriodId(defaultPeriodId);
    }
  }, [defaultPeriodId, selectedPeriodId]);

  const {
    data: leaderboard = [],
    isLoading: leaderboardLoading,
    error: leaderboardError,
  } = useDonationLeaderboard(selectedPeriodId);

  const [search, setSearch] = useState('');
  const filteredLeaderboard = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return leaderboard;
    return leaderboard.filter(r => (r.player_name ?? '').toLowerCase().includes(q));
  }, [leaderboard, search]);

  if (!allianceId) {
    return (
      <div style={{ color: '#4a5568', textAlign: 'center', padding: '3rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem' }}>
        Select an alliance in the sidebar
      </div>
    );
  }

  if (periodsLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
        color: '#4a5568', letterSpacing: '0.1em' }}>
        LOADING…
      </div>
    );
  }

  if (periodsError) {
    return (
      <div style={{ background: '#ff4d4d0d', border: '1px solid #ff4d4d44',
        borderRadius: '10px', padding: '1.5rem', color: '#ff4d4d', fontSize: '0.85rem' }}>
        {isAccessDenied(periodsError)
          ? 'Access denied — you are not a member of this alliance.'
          : `Error: ${periodsError.message}`}
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeUp 0.25s ease' }} aria-busy={leaderboardLoading || undefined}>
      {/* Header */}
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: '#38bdf8',
          textTransform: 'uppercase', fontFamily: "'Orbitron',sans-serif",
          marginBottom: '0.2rem' }}>
          Contributions
        </div>
        <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.1rem',
          fontWeight: '900', color: '#e2e8f0' }}>
          Weekly donations
        </h2>
        <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.25rem' }}>
          Alliance Honor ranking per week · <em>latest-wins</em> values (latest capture).
        </div>
        <span
          title="Weeks run Monday to Sunday, Europe/Paris time — unlike the calendar, which is UTC."
          style={{
            display: 'inline-block',
            marginTop: '0.5rem',
            fontSize: '0.68rem',
            color: '#94a3b8',
            background: '#38bdf80f',
            border: '1px solid #38bdf833',
            borderRadius: '999px',
            padding: '0.2rem 0.7rem',
          }}
        >
          🕒 Week Mon→Sun, Europe/Paris time
        </span>
      </div>

      {/* Period selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem',
        marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label htmlFor="donation-period"
          style={{ fontSize: '0.7rem', color: '#94a3b8',
            fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.06em' }}>
          PERIOD
        </label>
        {periods.length === 0 ? (
          <span style={{ fontSize: '0.78rem', color: '#4a5568', fontStyle: 'italic' }}>
            No weeks recorded
          </span>
        ) : (
          <select
            id="donation-period"
            aria-label="Period selector"
            value={selectedPeriodId ?? ''}
            onChange={e => setSelectedPeriodId(e.target.value)}
            style={{
              background: '#0f111a',
              border: '1px solid #2a2d3e',
              borderRadius: '8px',
              color: '#e2e8f0',
              padding: '0.4rem 0.7rem',
              fontSize: '0.82rem',
              fontFamily: "'Rajdhani',sans-serif",
              minWidth: '220px',
            }}
          >
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {formatWeekLabel(p.period_start)}
              </option>
            ))}
          </select>
        )}
      </div>

      {leaderboardError ? (
        <div style={{ background: '#ff4d4d0d', border: '1px solid #ff4d4d44',
          borderRadius: '10px', padding: '1.5rem', color: '#ff4d4d', fontSize: '0.85rem' }}>
          Error: {leaderboardError.message}
        </div>
      ) : (
        <>
          <PlayerSearchInput value={search} onChange={setSearch} />
          <div style={{ background: '#0f111a', border: '1px solid #1e2132',
            borderRadius: '12px', overflow: 'hidden' }}>
            {leaderboardLoading ? (
              <div style={{ textAlign: 'center', padding: '3rem',
                fontFamily: "'Orbitron',sans-serif", fontSize: '0.78rem',
                color: '#4a5568', letterSpacing: '0.1em' }}>
                LOADING…
              </div>
            ) : (
              <DonationLeaderboardTable rows={filteredLeaderboard} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
