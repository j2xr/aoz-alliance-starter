import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const fetchAlliancePlayer = vi.fn();
const fetchPlayerStats = vi.fn();
const fetchParticipationRate = vi.fn();
const fetchPlayerDonationTotals = vi.fn();
const fetchPlayerDonationHistory = vi.fn();

vi.mock('../queries/atQueries', () => ({
  fetchAlliancePlayer: (...a) => fetchAlliancePlayer(...a),
  fetchPlayerStats: (...a) => fetchPlayerStats(...a),
  fetchParticipationRates: vi.fn(),
  fetchParticipationRate: (...a) => fetchParticipationRate(...a),
  fetchPlayerDonationTotals: (...a) => fetchPlayerDonationTotals(...a),
  fetchPlayerDonationHistory: (...a) => fetchPlayerDonationHistory(...a),
  fetchUserAlliances: vi.fn(),
  fetchAllianceEvents: vi.fn(),
  fetchEventLeaderboard: vi.fn(),
  fetchDonationPeriods: vi.fn(),
  fetchDonationLeaderboard: vi.fn(),
  fetchPlayerStatsHistory: vi.fn(),
}));

vi.mock('../components/PointsEvolutionChart', () => ({
  PointsEvolutionChart: () => <div data-testid="points-chart" />,
}));
vi.mock('../components/PowerHistoryChart', () => ({
  PowerHistoryChart: () => <div data-testid="power-chart" />,
}));

import { PlayerDetailPage } from '../pages/PlayerDetail';

const ALLIANCE_ID = 'alliance-1';
const PLAYER_ID = 'player-1';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tracking/alliances/${ALLIANCE_ID}/players/${PLAYER_ID}`]}>
        <Routes>
          <Route path="/tracking/alliances/:allianceId/players/:playerId"
            element={<PlayerDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('PlayerDetailPage — Avg. donations / week', () => {
  beforeEach(() => {
    fetchAlliancePlayer.mockReset();
    fetchPlayerStats.mockReset();
    fetchParticipationRate.mockReset();
    fetchPlayerDonationTotals.mockReset();
    fetchPlayerDonationHistory.mockReset();

    fetchAlliancePlayer.mockResolvedValue({ id: PLAYER_ID, name: 'Alpha' });
    fetchPlayerStats.mockResolvedValue([
      { event_datetime: '2026-04-01T00:00:00Z', points: 100, power: 1000, event_type_code: 'ke' },
      { event_datetime: '2026-04-08T00:00:00Z', points: 200, power: 1100, event_type_code: 'ke' },
    ]);
    fetchParticipationRate.mockResolvedValue(
      { player_id: PLAYER_ID, player_name: 'Alpha',
        participation_rate_pct: 75, events_participated: 6, eligible_events: 8,
        avg_points: 150, last_participation: '2026-04-08T00:00:00Z' },
    );
    fetchPlayerDonationHistory.mockResolvedValue([]);
  });

  it('shows the "Avg. donations / week" card with the formatted average', async () => {
    fetchPlayerDonationTotals.mockResolvedValue({
      alliance_id: ALLIANCE_ID,
      player_id: PLAYER_ID,
      name: 'Alpha',
      periods_contributed: 4,
      total_alliance_honor: 4000000,
      best_period_honor: 1500000,
      avg_per_period: 1000000,
      last_period_start: '2026-04-27',
    });

    renderPage();

    expect(await screen.findByText('Avg. donations / week')).toBeInTheDocument();

    const card = screen.getByTestId('avg-donations-card');
    // Average formatted with thousands separators (en-US locale)
    expect(card).toHaveTextContent(/1[,\s]*000[,\s]*000/);
  });

  it('displays "—" when periods_contributed is 0', async () => {
    fetchPlayerDonationTotals.mockResolvedValue({
      alliance_id: ALLIANCE_ID,
      player_id: PLAYER_ID,
      name: 'Alpha',
      periods_contributed: 0,
      total_alliance_honor: 0,
      best_period_honor: 0,
      avg_per_period: 0,
      last_period_start: null,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Avg. donations / week')).toBeInTheDocument();
    });
    const card = screen.getByTestId('avg-donations-card');
    expect(card).toHaveTextContent('—');
  });

  it('displays "—" when no donation totals row exists at all', async () => {
    fetchPlayerDonationTotals.mockResolvedValue(null);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Avg. donations / week')).toBeInTheDocument();
    });
    const card = screen.getByTestId('avg-donations-card');
    expect(card).toHaveTextContent('—');
  });
});
