import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const fetchAlliancePlayer = vi.fn();
const fetchPlayerStats = vi.fn();
const fetchParticipationRate = vi.fn();
const fetchPlayerDonationTotals = vi.fn();
const fetchPlayerDonationHistory = vi.fn();
const fetchAllianceEventCount = vi.fn();

vi.mock('../queries/atQueries', () => ({
  fetchAlliancePlayer: (...a) => fetchAlliancePlayer(...a),
  fetchPlayerStats: (...a) => fetchPlayerStats(...a),
  fetchParticipationRates: vi.fn(),
  fetchParticipationRate: (...a) => fetchParticipationRate(...a),
  fetchPlayerDonationTotals: (...a) => fetchPlayerDonationTotals(...a),
  fetchPlayerDonationHistory: (...a) => fetchPlayerDonationHistory(...a),
  fetchAllianceEventCount: (...a) => fetchAllianceEventCount(...a),
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
    fetchAllianceEventCount.mockReset();

    fetchAllianceEventCount.mockResolvedValue(0);
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

describe('PlayerDetailPage — period filter', () => {
  beforeEach(() => {
    fetchAlliancePlayer.mockReset();
    fetchPlayerStats.mockReset();
    fetchParticipationRate.mockReset();
    fetchPlayerDonationTotals.mockReset();
    fetchPlayerDonationHistory.mockReset();
    fetchAllianceEventCount.mockReset();

    fetchAlliancePlayer.mockResolvedValue({ id: PLAYER_ID, name: 'Alpha' });
    fetchPlayerDonationTotals.mockResolvedValue(null);
    fetchPlayerDonationHistory.mockResolvedValue([]);
    // All-time figure shown by default (before any period is picked).
    fetchParticipationRate.mockResolvedValue({
      player_id: PLAYER_ID, player_name: 'Alpha',
      participation_rate_pct: 75, events_participated: 6, eligible_events: 8,
      avg_points: 150, last_participation: '2026-04-08T00:00:00Z',
    });
  });

  it('defaults to All time and shows the all-time participation rate', async () => {
    fetchPlayerStats.mockResolvedValue([]);
    renderPage();

    const card = await screen.findByTestId('participation-card');
    expect(card).toHaveTextContent('75%');
    // The 'all' period is disabled, so no event-count query fires.
    expect(fetchAllianceEventCount).not.toHaveBeenCalled();
  });

  it('recomputes the rate for a selected period from the loaded participations', async () => {
    // Two participations inside the last 7 days, one well outside it. Dates are
    // relative to now so the rolling window holds regardless of run date.
    const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    fetchPlayerStats.mockResolvedValue([
      { event_datetime: daysAgo(100), points: 100, power: 1000, event_type_code: 'ke' },
      { event_datetime: daysAgo(3), points: 200, power: 1100, event_type_code: 'ke' },
      { event_datetime: daysAgo(1), points: 300, power: 1200, event_type_code: 'ke' },
    ]);
    fetchAllianceEventCount.mockResolvedValue(4);

    renderPage();
    // Wait for initial (all-time) render.
    const card = await screen.findByTestId('participation-card');
    expect(card).toHaveTextContent('75%');

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));

    // Denominator query fired with the alliance id and a since ~7 days back.
    await waitFor(() => expect(fetchAllianceEventCount).toHaveBeenCalled());
    const [allianceArg, sinceArg] = fetchAllianceEventCount.mock.calls[0];
    expect(allianceArg).toBe(ALLIANCE_ID);
    const sinceMs = new Date(sinceArg).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(sinceMs - (Date.now() - sevenDays))).toBeLessThan(60_000);

    // 2 in-window participations / 4 alliance events = 50%.
    await waitFor(() => expect(card).toHaveTextContent('50%'));
    expect(screen.getByTestId('attendances-card')).toHaveTextContent('2/4');
  });

  it('shows "—" when the alliance ran no events in the window', async () => {
    fetchPlayerStats.mockResolvedValue([]);
    fetchAllianceEventCount.mockResolvedValue(0);

    renderPage();
    await screen.findByTestId('participation-card');

    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));

    await waitFor(() => expect(fetchAllianceEventCount).toHaveBeenCalled());
    const rateCard = screen.getByTestId('participation-card');
    const attendCard = screen.getByTestId('attendances-card');
    // Wait for the count (0) to resolve — attendances reaching "0/0" proves it.
    await waitFor(() => expect(attendCard).toHaveTextContent('0/0'));
    expect(rateCard).toHaveTextContent('—');
  });
});
