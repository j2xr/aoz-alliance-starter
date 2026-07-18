import { useNavigate, useParams } from 'react-router-dom';
import { usePlayerStats, usePlayerInfo } from '../hooks/usePlayerStats';
import { useParticipationRate } from '../hooks/useParticipationRates';
import { usePlayerDonationTotals, usePlayerDonationHistory } from '../hooks/useDonations';
import { usePlayerStatsHistory } from '../hooks/usePlayerStatsHistory';
import { PointsEvolutionChart } from '../components/PointsEvolutionChart';
import { PowerHistoryChart } from '../components/PowerHistoryChart';
import { DonationHistoryList } from '../components/DonationHistoryList';
import { StatsEvolutionChart } from '../components/StatsEvolutionChart';
import { formatHonor } from '../utils/donationFormat';

export function PlayerDetailPage() {
  const { allianceId, playerId } = useParams();
  const navigate = useNavigate();

  const { data: player, isLoading: playerLoading } = usePlayerInfo(playerId);
  const { data: stats = [], isLoading: statsLoading, error: statsError } = usePlayerStats(playerId, allianceId);
  const { data: participation } = useParticipationRate(allianceId, playerId);
  const { data: donationTotals } = usePlayerDonationTotals(playerId);
  const { data: donationHistory = [] } = usePlayerDonationHistory(playerId, 5);
  const { data: militaryStats = [] } = usePlayerStatsHistory(allianceId, playerId);

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
            {player?.game_id && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                ID : {player.game_id}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {participation?.participation_rate_pct != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900',
                  color: participation.participation_rate_pct >= 80 ? 'var(--success)'
                    : participation.participation_rate_pct >= 50 ? 'var(--gold)' : 'var(--danger)' }}>
                  {Math.round(participation.participation_rate_pct)}%
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
            {participation && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.4rem',
                  fontWeight: '900', color: 'var(--text)' }}>
                  {participation.events_participated}/{participation.eligible_events}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>Attendances</div>
              </div>
            )}
          </div>
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
