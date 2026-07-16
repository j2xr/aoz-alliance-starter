import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PlayerStatsTable } from './PlayerStatsTable';

function renderTable(rows) {
  return render(
    <MemoryRouter initialEntries={['/tracking/alliances/alliance-1/stats']}>
      <Routes>
        <Route
          path="/tracking/alliances/:allianceId/stats"
          element={<PlayerStatsTable rows={rows} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function nameOrder() {
  return screen.getAllByRole('row').slice(1).map(row => row.textContent);
}

const ROWS = [
  { player_id: 'p1', player_name: 'Charlie', last_rank: 'R3', attack_pct: 300, hp_pct: 100, defense_pct: 50, recorded_date: '2026-05-01' },
  { player_id: 'p2', player_name: 'Alpha', last_rank: 'R5', attack_pct: 500, hp_pct: 200, defense_pct: 80, recorded_date: '2026-05-02' },
  { player_id: 'p3', player_name: 'Bravo', last_rank: 'R1', attack_pct: 400, hp_pct: 150, defense_pct: 60, recorded_date: '2026-05-03' },
];

describe('PlayerStatsTable sorting', () => {
  it('defaults to attack % descending', () => {
    renderTable(ROWS);
    const order = nameOrder();
    expect(order[0]).toContain('Alpha'); // 500
    expect(order[1]).toContain('Bravo'); // 400
    expect(order[2]).toContain('Charlie'); // 300
  });

  it('sorts by player name ascending on first click', () => {
    renderTable(ROWS);
    fireEvent.click(screen.getByText('PLAYER'));
    const order = nameOrder();
    expect(order[0]).toContain('Alpha');
    expect(order[1]).toContain('Bravo');
    expect(order[2]).toContain('Charlie');
  });

  it('sorts nulls last on a numeric column', () => {
    const rowsWithNull = [
      { player_id: 'p1', player_name: 'NoDef', last_rank: 'R2', attack_pct: 100, hp_pct: 50, defense_pct: null },
      { player_id: 'p2', player_name: 'HasDef', last_rank: 'R2', attack_pct: 100, hp_pct: 50, defense_pct: 40 },
    ];
    renderTable(rowsWithNull);
    const header = screen.getByText('DEF %');
    fireEvent.click(header);
    expect(nameOrder()[1]).toContain('NoDef');
  });
});
