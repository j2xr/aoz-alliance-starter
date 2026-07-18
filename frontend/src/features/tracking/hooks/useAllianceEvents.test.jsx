import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const fetchAllianceEvent = vi.fn();

vi.mock('../queries/atQueries', () => ({
  fetchAllianceEvents: vi.fn(),
  fetchAllianceEvent: (...a) => fetchAllianceEvent(...a),
}));

import { useAllianceEvent } from './useAllianceEvents';

function wrapper({ children }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useAllianceEvent', () => {
  beforeEach(() => {
    fetchAllianceEvent.mockReset();
  });

  it('fetches a single event by id, independent of how far back it is', async () => {
    // Regression for A8: EventDetail previously derived the event from
    // useAllianceEvents(allianceId, 100) + find, so anything past the 100
    // most recent events silently rendered as "—".
    const EVENT = {
      id: 'event-old',
      event_datetime: '2020-01-01T00:00:00Z',
      alliance_rank: 3,
      total_battlers: 40,
      total_points: 12345,
      at_event_types: { code: 'ke', display_name: 'Kill Event' },
    };
    fetchAllianceEvent.mockResolvedValue(EVENT);

    const { result } = renderHook(() => useAllianceEvent('event-old'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchAllianceEvent).toHaveBeenCalledWith('event-old');
    expect(result.current.data).toEqual(EVENT);
  });

  it('does not query when eventId is falsy', () => {
    const { result } = renderHook(() => useAllianceEvent(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchAllianceEvent).not.toHaveBeenCalled();
  });

  it('surfaces the query error (e.g. RLS access-denied) instead of swallowing it', async () => {
    const error = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
    fetchAllianceEvent.mockRejectedValue(error);

    const { result } = renderHook(() => useAllianceEvent('event-1'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(error);
  });
});
