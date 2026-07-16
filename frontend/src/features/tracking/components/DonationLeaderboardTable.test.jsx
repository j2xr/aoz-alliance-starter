import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { DonationLeaderboardTable } from './DonationLeaderboardTable';

function renderTable(rows) {
  return render(
    <MemoryRouter initialEntries={['/tracking/alliances/alliance-1/donations']}>
      <Routes>
        <Route
          path="/tracking/alliances/:allianceId/donations"
          element={<DonationLeaderboardTable rows={rows} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function nameOrder() {
  return screen.getAllByRole('row').slice(1).map(row => row.textContent);
}

const ROWS = [
  { player_id: 'p1', player_name: 'Charlie', player_rank: 'R3', alliance_honor: 500, position: 1 },
  { player_id: 'p2', player_name: 'Alpha', player_rank: 'R5', alliance_honor: 900, position: 2 },
  { player_id: 'p3', player_name: 'Bravo', player_rank: 'R1', alliance_honor: 700, position: 3 },
];

describe('DonationLeaderboardTable sorting', () => {
  it('defaults to leaderboard position order', () => {
    renderTable(ROWS);
    const order = nameOrder();
    expect(order[0]).toContain('Charlie');
    expect(order[1]).toContain('Alpha');
    expect(order[2]).toContain('Bravo');
  });

  it('sorts by player name ascending on first click', () => {
    renderTable(ROWS);
    fireEvent.click(screen.getByText('Player'));
    const order = nameOrder();
    expect(order[0]).toContain('Alpha');
    expect(order[1]).toContain('Bravo');
    expect(order[2]).toContain('Charlie');
  });

  it('sorts by Alliance Honor numerically, not alphabetically', () => {
    renderTable(ROWS);
    const header = screen.getByText('Alliance Honor');
    fireEvent.click(header); // descending by default for a non-name column
    expect(nameOrder()[0]).toContain('Alpha'); // 900, the highest honor
  });
});
