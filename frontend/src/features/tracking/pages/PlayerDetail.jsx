import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlayerStats, usePlayerInfo } from '../hooks/usePlayerStats';
import { useParticipationRate } from '../hooks/useParticipationRates';
import { useAllianceEventCount } from '../hooks/useAllianceEvents';
import { PERIOD_OPTIONS, periodStartIso } from '../utils/periods';
import { usePlayerDonationTotals, usePlayerDonationHistory } from '../hooks/useDonations';
import { usePlayerStatsHistory } from '../hooks/usePlayerStatsHistory';
import { PointsEvolutionChart } from '../components/PointsEvolutionChart';
import { PowerHistoryChart } from '../components/PowerHistoryChart';
import { DonationHistoryList } from '../components/DonationHistoryList';
import { StatsEvolutionChart } from '../components/StatsEvolutionChart';
import { formatHonor } from '../utils/donationFormat';

// Same thresholds as ParticipationRateTable.jsx (kept local, mirroring how that
// file defines its own copy independently).
function rateColor(pct) {
  if (pct == null) return 'var(--text-faint)';
  if (pct >= 80) return 'var(--success)';
  if (pct >= 50) return 'var(--gold)';
  return 'var(--danger)';
}

export function PlayerDetailPage() {
  const { allianceId, playerId } = useParams();
  const navigate = useNavigate();

  const { data: player, isLoading: playerLoading } = usePlayerInfo(playerId);
  const { data: stats = [], isLoading: statsLoading, error: statsError } = usePlayerStats(playerId, allianceId);
  const { data: participation } = useParticipationRate(allianceId, playerId);
  const { data: donationTotals } = usePlayerDonationTotals(playerId);
  const { data: donationHistory = [] } = usePlayerDonationHistory(playerId, 5);
  const { data: militaryStats = [] } = usePlayerStatsHistory(allianceId, playerId);

  const [period, setPeriod] = useState('all');
  // Memoized on `period` alone: recomputing periodStartIso() every render would
  // hand useAllianceEventCount a fresh `now`-based key each time and refetch in
  // a loop. One boundary per period selection.
  const since = useMemo(
    () => (period === 'all' ? null : periodStartIso(period)),
    [period],
  );
  const { data: periodEventCount } = useAllianceEventCount(allianceId, since);

  const isLoading = playerLoading || statsLoading;

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
        color: 'var(--text-faint)', letterSpacing: '0.1em' }}>
        LOADING…
      </div>
    );
  }

  if (statsError) {
    return (
      <div style={{ background: '#ff4d4d0d', border: '1px solid #ff4d4d44',
        borderRadius: '10px', padding: '1.5rem', color: 'var(--danger)', fontSize: '0.85rem' }}>
        Error: {statsError.message}
      </div>
    );
  }

  const latestPower = stats.filter(s => s.power != null).slice(-1)[0]?.power;
  const periodsContributed = donationTotals?.periods_contributed ?? 0;
  const avgDonationDisplay = periodsContributed > 0
    ? formatHonor(Math.round(donationTotals.avg_per_period ?? 0))
    : '—';

  // Period participation. Numerator is computed client-side from the already
  // loaded participation rows (each carries event_datetime); only the
  // denominator — alliance events in the window — needs the extra count query.
  // Simple ratio (no join-date "eligible events" logic): a player who joined
  // mid-period shows an artificially low rate — the accepted tradeoff for 'all'.
  const showPeriod = period !== 'all';
  const periodParticipated = since == null
    ? null
    : stats.filter(s => s.event_datetime != null && new Date(s.event_datetime) >= new Date(since)).length;
  // periodEventCount === 0 (no events in the window) → null, so we render "—"
  // rather than a misleading 0% or a NaN.
  const periodRatePct = since == null || !periodEventCount
    ? null
    : Math.round((periodParticipated / periodEventCount) * 1000) / 10;

  // What the Participation / Attendances cards show: period values when a period
  // is selected, the all-time figures otherwise.
  const displayRatePct = showPeriod ? periodRatePct : participation?.participation_rate_pct;
  const displayParticipated = showPeriod ? periodParticipated : participation?.events_participated;
  // In period mode the denominator is the alliance event count (may be
  // undefined while loading → treated as null → renders "—").
  const displayEligible = showPeriod ? (periodEventCount ?? null) : participation?.eligible_events;

  return (
    <div style={{ animation: 'fadeUp 0.25s ease' }}>
      {/* Breadcrumb */}
      <button onClick={() => navigate(`/tracking/alliances/${allianceId}/players`)}
        style={{ background: 'transparent', border: 'none', color: 'var(--accent)',
          cursor: 'pointer', fontSize: '0.75rem', padding: '0',
          marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        ← Back to players
      </button>

      {/* Player header */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)',
        borderLeft: '3px solid var(--accent)', borderRadius: '12px',
        padding: '1.25rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem',
          alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.2rem',
              fontWeight: '900', color: 'var(--text)', marginBottom: '0.2rem' }}>
              {player?.name ?? '—'}
            </h2>
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {(showPeriod || participation?.participation_rate_pct != null) && (
              <div style={{ textAlign: 'center' }} data-testid="participation-card">
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900', color: rateColor(displayRatePct) }}>
                  {displayRatePct != null ? `${Math.round(displayRatePct)}%` : '—'}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>Participation</div>
              </div>
            )}
            {latestPower != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900', color: 'var(--purple)' }}>
                  {latestPower >= 1000000
                    ? `${(latestPower / 1000000).toFixed(1)}M`
                    : latestPower.toLocaleString()}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>Power</div>
              </div>
            )}
            <div style={{ textAlign: 'center' }} data-testid="avg-donations-card">
              <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                fontWeight: '900', color: 'var(--accent)' }}>
                {avgDonationDisplay}
              </div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>Avg. donations / week</div>
            </div>
            {(showPeriod || participation) && (
              <div style={{ textAlign: 'center' }} data-testid="attendances-card">
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900', color: 'var(--text)' }}>
                  {displayEligible == null ? '—' : `${displayParticipated ?? 0}/${displayEligible}`}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>Attendances</div>
              </div>
            )}
          </div>
        </div>

        {/* Period filter — scopes the Participation / Attendances figures above.
            'All time' keeps the join-date-aware view; the others are a simple
            in-period ratio. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem',
          alignItems: 'center', marginTop: '1rem', paddingTop: '1rem',
          borderTop: '1px solid var(--border)' }}>
          <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.6rem',
            color: 'var(--text-faint)', letterSpacing: '0.08em', marginRight: '0.3rem' }}>
            PERIOD
          </span>
          {PERIOD_OPTIONS.map(opt => {
            const active = period === opt.key;
            return (
              <button key={opt.key}
                onClick={() => setPeriod(opt.key)}
                aria-pressed={active}
                style={{
                  fontFamily: "'Orbitron',sans-serif", fontSize: '0.6rem',
                  letterSpacing: '0.05em', cursor: 'pointer',
                  padding: '0.3rem 0.65rem', borderRadius: '999px',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? '#38bdf815' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-dim)',
                  transition: 'all 0.1s',
                }}>
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))',
        gap: '1rem' }}>
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid var(--border)',
            fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem',
            color: 'var(--accent)', letterSpacing: '0.06em' }}>
            POINTS EVOLUTION
          </div>
          <div style={{ padding: '1rem' }}>
            <PointsEvolutionChart data={stats} />
          </div>
        </div>

        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid var(--border)',
            fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem',
            color: 'var(--purple)', letterSpacing: '0.06em' }}>
            POWER HISTORY
          </div>
          <div style={{ padding: '1rem' }}>
            <PowerHistoryChart data={stats} />
          </div>
        </div>
      </div>

      {/* Military stats */}
      {militaryStats.length > 0 && (
        <div style={{ marginTop: '1rem', background: 'var(--bg-panel)',
          border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid var(--border)',
            fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem',
            color: '#fb923c', letterSpacing: '0.06em' }}>
            COMBAT STATS EVOLUTION
          </div>
          <div style={{ padding: '1rem' }}>
            <StatsEvolutionChart data={militaryStats} />
          </div>
        </div>
      )}

      {/* Donations history */}
      <div style={{ marginTop: '1rem', background: 'var(--bg-panel)',
        border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ padding: '1rem 1.25rem 0.5rem', borderBottom: '1px solid var(--border)',
          fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem',
          color: 'var(--accent)', letterSpacing: '0.06em' }}>
          DONATION HISTORY (LAST 5 WEEKS)
        </div>
        <div style={{ padding: '0.75rem 1.25rem 1rem' }}>
          <DonationHistoryList rows={donationHistory} />
        </div>
      </div>
    </div>
  );
}
