import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const fetchDonationPeriods = vi.fn();
const fetchDonationLeaderboard = vi.fn();

vi.mock('../queries/atQueries', () => ({
  fetchDonationPeriods: (...args) => fetchDonationPeriods(...args),
  fetchDonationLeaderboard: (...args) => fetchDonationLeaderboard(...args),
  fetchPlayerDonationTotals: vi.fn(),
  fetchPlayerDonationHistory: vi.fn(),
  fetchUserAlliances: vi.fn(),
  fetchAllianceEvents: vi.fn(),
  fetchEventLeaderboard: vi.fn(),
  fetchParticipationRates: vi.fn(),
  fetchPlayerStats: vi.fn(),
  fetchAlliancePlayer: vi.fn(),
  isAccessDenied: (error) => error?.code === 'PGRST116',
}));

import { DonationsPage } from '../pages/Donations';

const ALLIANCE_ID = 'alliance-1';

const PERIODS = [
  { id: 'p-newer', period_type: 'weekly', period_start: '2026-04-27', period_end: '2026-05-03' },
  { id: 'p-older', period_type: 'weekly', period_start: '2026-04-20', period_end: '2026-04-26' },
];

const LEADERBOARD_NEWER = [
  { donation_period_id: 'p-newer', alliance_id: ALLIANCE_ID, period_type: 'weekly',
    period_start: '2026-04-27', period_end: '2026-05-03', alliance_name: 'SOD',
    player_id: 'pl-1', player_name: 'Alpha', player_rank: 'R5',
    alliance_honor: 1234567, updated_at: '2026-05-02T10:00:00Z', position: 1 },
  { donation_period_id: 'p-newer', alliance_id: ALLIANCE_ID, period_type: 'weekly',
    period_start: '2026-04-27', period_end: '2026-05-03', alliance_name: 'SOD',
    player_id: 'pl-2', player_name: 'Bravo', player_rank: 'R4',
    alliance_honor: 999999, updated_at: '2026-05-02T10:00:00Z', position: 2 },
];

const LEADERBOARD_OLDER = [
  { donation_period_id: 'p-older', alliance_id: ALLIANCE_ID, period_type: 'weekly',
    period_start: '2026-04-20', period_end: '2026-04-26', alliance_name: 'SOD',
    player_id: 'pl-3', player_name: 'Charlie', player_rank: 'R3',
    alliance_honor: 555000, updated_at: '2026-04-26T10:00:00Z', position: 1 },
];

function renderWithRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tracking/alliances/${ALLIANCE_ID}/donations`]}>
        <Routes>
          <Route path="/tracking/alliances/:allianceId/donations" element={<DonationsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('DonationsPage', () => {
  beforeEach(() => {
    fetchDonationPeriods.mockReset();
    fetchDonationLeaderboard.mockReset();
  });

  it('renders the period selector and the leaderboard for the most recent period', async () => {
    fetchDonationPeriods.mockResolvedValue(PERIODS);
    fetchDonationLeaderboard.mockImplementation(periodId =>
      Promise.resolve(periodId === 'p-newer' ? LEADERBOARD_NEWER : LEADERBOARD_OLDER)
    );

    renderWithRouter();

    const select = await screen.findByLabelText(/Period selector/i);
    expect(select).toBeInTheDocument();

    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent(/Week of 27 April 2026/);

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
    // Honor formatted with thousands separators (en-US locale)
    expect(screen.getByText(/1[,\s]*234[,\s]*567/)).toBeInTheDocument();
    // Medal for #1
    expect(screen.getByText('🥇')).toBeInTheDocument();
    // Timezone badge, since donation weeks run Europe/Paris unlike the UTC calendar
    expect(screen.getByText(/Europe\/Paris/)).toBeInTheDocument();
  });

  it('filters the leaderboard by player name search', async () => {
    fetchDonationPeriods.mockResolvedValue(PERIODS);
    fetchDonationLeaderboard.mockImplementation(periodId =>
      Promise.resolve(periodId === 'p-newer' ? LEADERBOARD_NEWER : LEADERBOARD_OLDER)
    );

    renderWithRouter();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();

    const search = screen.getByLabelText(/Search by player name/i);
    fireEvent.change(search, { target: { value: 'alph' } });

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Bravo')).not.toBeInTheDocument();
  });

  it('switches the leaderboard when another period is selected', async () => {
    fetchDonationPeriods.mockResolvedValue(PERIODS);
    fetchDonationLeaderboard.mockImplementation(periodId =>
      Promise.resolve(periodId === 'p-newer' ? LEADERBOARD_NEWER : LEADERBOARD_OLDER)
    );

    renderWithRouter();

    await screen.findByText('Alpha');

    const select = screen.getByLabelText(/Period selector/i);
    fireEvent.change(select, { target: { value: 'p-older' } });

    expect(await screen.findByText('Charlie')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    });
  });

  it('renders an empty state when no periods exist', async () => {
    fetchDonationPeriods.mockResolvedValue([]);
    renderWithRouter();
    expect(await screen.findByText(/No weeks recorded/i)).toBeInTheDocument();
    expect(fetchDonationLeaderboard).not.toHaveBeenCalled();
  });

  it('renders an access-denied message for a PGRST116 error, not the raw message', async () => {
    fetchDonationPeriods.mockRejectedValue({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
    renderWithRouter();
    expect(await screen.findByText(/Access denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/JSON object requested/i)).not.toBeInTheDocument();
  });

  it('renders the raw error message for a non-RLS error', async () => {
    fetchDonationPeriods.mockRejectedValue({ code: '500', message: 'connection refused' });
    renderWithRouter();
    expect(await screen.findByText(/connection refused/i)).toBeInTheDocument();
  });
});
