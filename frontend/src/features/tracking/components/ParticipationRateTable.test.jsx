import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ParticipationRateTable } from './ParticipationRateTable';

function renderTable(rows) {
  return render(
    <MemoryRouter initialEntries={['/tracking/alliances/alliance-1/participation']}>
      <Routes>
        <Route
          path="/tracking/alliances/:allianceId/participation"
          element={<ParticipationRateTable rows={rows} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

function nameOrder() {
  return screen.getAllByRole('row')
    .slice(1) // drop the header row
    .map(row => row.textContent);
}

describe('ParticipationRateTable sorting', () => {
  it('sorts a string column by declared type, not by sniffing numeric-looking values', () => {
    // player_name is declared non-numeric in COLS. Value-sniffing would parse
    // "7" and "42" as numbers and sort 7 before 42; the column's declared
    // `numeric: false` must force a lexicographic compare instead ("42" < "7").
    const rows = [
      { player_id: 'p1', player_name: '7' },
      { player_id: 'p2', player_name: '42' },
    ];
    renderTable(rows);

    fireEvent.click(screen.getByText('Player')); // first click on Player sorts ascending

    const order = nameOrder();
    expect(order[0]).toContain('42');
    expect(order[1]).toContain('7');
  });

  it('sorts null last on a numeric column in both directions', () => {
    const rows = [
      { player_id: 'p1', player_name: 'Alice', events_participated: null },
      { player_id: 'p2', player_name: 'Bob', events_participated: 5 },
    ];
    renderTable(rows);
    const header = screen.getByText('Participations');

    fireEvent.click(header); // descending (default direction for non-name columns)
    expect(nameOrder()[1]).toContain('Alice');

    fireEvent.click(header); // toggle to ascending
    expect(nameOrder()[1]).toContain('Alice');
  });

  it('sorts null last on a string column in both directions', () => {
    const rows = [
      { player_id: 'p1', player_name: 'Alice', last_participation: null },
      { player_id: 'p2', player_name: 'Bob', last_participation: '2026-05-01' },
    ];
    renderTable(rows);
    const header = screen.getByText('Last part.');

    fireEvent.click(header);
    expect(nameOrder()[1]).toContain('Alice');

    fireEvent.click(header);
    expect(nameOrder()[1]).toContain('Alice');
  });

  it('does not crash when two rows share a null value on the active numeric sort column', () => {
    const rows = [
      { player_id: 'p1', player_name: 'Alice', avg_points: null },
      { player_id: 'p2', player_name: 'Bob', avg_points: null },
      { player_id: 'p3', player_name: 'Carol', avg_points: 500 },
    ];
    renderTable(rows);
    const header = screen.getByText('Avg. pts');
    fireEvent.click(header);
    fireEvent.click(header);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });
});
